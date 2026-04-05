import crypto from 'node:crypto';
import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';
import { prisma } from '../../database/prisma.js';

async function login(app: any, mobile: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ mobile, password });
  expect(res.status).toBe(200);
  return {
    token: res.body.tokens.accessToken as string,
    userId: res.body.user.id as string,
  };
}

async function loginAdmin(app: any, username: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return {
    token: res.body.tokens.accessToken as string,
    userId: res.body.user.id as string,
  };
}

const LARGE_DATA_URL = `data:image/png;base64,${'A'.repeat(14000)}`;
describe('core flows: products -> redirect -> order -> claim -> ops verify/settle -> brand payout/connect', () => {
  it('supports end-to-end API flow (minimal assertions, contract-focused)', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    const seeded = await seedE2E();

    const app = createApp(env);
    const db = prisma();

    const shopper = await login(app, E2E_ACCOUNTS.shopper.mobile, E2E_ACCOUNTS.shopper.password);
    const admin = await loginAdmin(app, E2E_ACCOUNTS.admin.username, E2E_ACCOUNTS.admin.password);
    const brand = await login(app, E2E_ACCOUNTS.brand.mobile, E2E_ACCOUNTS.brand.password);
    const agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);

    // Products list (shopper-only)
    const productsRes = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${shopper.token}`);

    expect(productsRes.status).toBe(200);
    expect(Array.isArray(productsRes.body)).toBe(true);
    expect(productsRes.body.length).toBeGreaterThan(0);

    // Find the E2E Deal: query DB directly because stale deals from prior runs
    // may push it off the first page of the paginated products API.
    const deal = await db.deal.findFirst({
      where: { title: 'E2E Deal', active: true, isDeleted: false },
      include: { campaign: true },
    });
    expect(deal).toBeTruthy();
    const dealId = String(deal!.id);
    const payoutPaise = Number(deal?.payoutPaise ?? 0);
    expect(payoutPaise).toBeGreaterThan(0);

    // Use the campaign's brand (the actual wallet owner for settlement)
    const campaignBrandUserId = String(deal?.campaign?.brandUserId || seeded.brand.id);

    // Force-reset the wallet to a known balance (5,00,000 paisa = ₹50,000)
    // so the assertion is deterministic regardless of leftover state.
    const WALLET_START = 50_000_00;
    await db.wallet.upsert({
      where: { ownerUserId: campaignBrandUserId },
      create: {
        mongoId: crypto.randomUUID(),
        ownerUserId: campaignBrandUserId,
        currency: 'INR' as any,
        availablePaise: WALLET_START,
        pendingPaise: 0,
        lockedPaise: 0,
        version: 0,
        createdBy: campaignBrandUserId,
      },
      update: { availablePaise: WALLET_START, pendingPaise: 0, lockedPaise: 0 },
    });

    // Reset velocity counter: soft-delete ALL orders for this user so the
    // per-buyer velocity limit (10/hour, 30/day) does not fire on repeated runs.
    await db.order.updateMany({
      where: { userId: shopper.userId, isDeleted: false },
      data: { isDeleted: true },
    });

    // Also soft-delete any settled orders for this campaign (from ANY user)
    // to prevent isOverLimit from skipping wallet movements.
    if (deal?.campaignId) {
      await db.order.updateMany({
        where: {
          items: { some: { campaignId: deal.campaignId } },
          isDeleted: false,
        },
        data: { isDeleted: true },
      });
      // Reset campaign usedSlots so repeated runs don't exhaust the campaign
      await db.campaign.update({
        where: { id: deal.campaignId },
        data: { usedSlots: 0 },
      });
    }

    // Clean up ALL stale settlement transactions for this campaign's orders
    const allCampaignOrders = await db.order.findMany({
      where: deal?.campaignId
        ? { items: { some: { campaignId: deal.campaignId } } }
        : { userId: shopper.userId },
      select: { mongoId: true },
    });
    const allMongoIds = allCampaignOrders.map((o) => o.mongoId).filter(Boolean) as string[];
    if (allMongoIds.length > 0) {
      const allStaleKeys = allMongoIds.flatMap((mid) => [
        `order-settlement-debit-${mid}`,
        `order-commission-${mid}`,
        `order-margin-${mid}`,
        // Also clean keys with cycle suffix (settle/unsettle/re-settle)
        ...Array.from({ length: 4 }, (_, i) => `order-settlement-debit-${mid}-c${i}`),
        ...Array.from({ length: 4 }, (_, i) => `order-commission-${mid}-c${i}`),
        ...Array.from({ length: 4 }, (_, i) => `order-margin-${mid}-c${i}`),
      ]);
      try { await db.transaction.deleteMany({ where: { idempotencyKey: { in: allStaleKeys } } }); } catch { /* ignore */ }
    }

    // Redirect tracking creates a pre-order
    const redirectRes = await request(app)
      .post(`/api/deals/${dealId}/redirect`)
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({});

    expect(redirectRes.status).toBe(201);
    expect(redirectRes.body).toHaveProperty('preOrderId');
    expect(redirectRes.body).toHaveProperty('url');

    const preOrderId = String(redirectRes.body.preOrderId);

    // Upgrade pre-order into a full order
    const createOrderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({
        userId: shopper.userId,
        preOrderId,
        items: [
          {
            productId: dealId,
            title: 'E2E Deal',
            image: 'https://placehold.co/600x400',
            priceAtPurchase: 999,
            commission: 50,
            campaignId: String(deal!.campaignId || deal!.campaign?.id || ''),
            dealType: 'Discount',
            quantity: 1,
            platform: 'Amazon',
            brandName: 'E2E Brand',
          },
        ],
        externalOrderId: `EXT_${Date.now()}`,
        screenshots: { order: LARGE_DATA_URL },
      });

    expect(createOrderRes.status).toBe(201);
    expect(createOrderRes.body).toHaveProperty('id');

    const orderId = String(createOrderRes.body.id);

    // Claim submission (should be allowed by owner)
    const claimRes = await request(app)
      .post('/api/orders/claim')
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({ orderId, type: 'order', data: LARGE_DATA_URL });

    expect(claimRes.status).toBe(200);
    expect(claimRes.body).toHaveProperty('id', orderId);

    // Ops verify purchase (privileged)
    const verifyRes = await request(app)
      .post('/api/ops/verify')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ orderId });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body).toHaveProperty('ok', true);
    // Discount deals now also require returnWindow proof
    expect(verifyRes.body).toHaveProperty('approved', false);
    expect(verifyRes.body.missingProofs).toContain('returnWindow');

    // Submit returnWindow proof (required for ALL deal types)
    const submitReturnWindowRes = await request(app)
      .post('/api/orders/claim')
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({ orderId, type: 'returnWindow', data: LARGE_DATA_URL });

    expect(submitReturnWindowRes.status).toBe(200);

    // Verify returnWindow
    const verifyReturnWindowRes = await request(app)
      .post('/api/ops/orders/verify-requirement')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ orderId, type: 'returnWindow' });

    expect(verifyReturnWindowRes.status).toBe(200);
    expect(verifyReturnWindowRes.body).toHaveProperty('ok', true);
    expect(verifyReturnWindowRes.body).toHaveProperty('approved', true);

    // Force-reset brand wallet to a known balance right before settlement to
    // avoid contamination from other test files sharing the same database.
    await db.wallet.updateMany({
      where: { ownerUserId: campaignBrandUserId, isDeleted: false },
      data: { availablePaise: WALLET_START, pendingPaise: 0, lockedPaise: 0 },
    });

    // Also clean any stale settlement transactions for THIS specific order
    // (in case a previous full-suite run left them behind)
    const thisOrderMongoId = (await db.order.findFirst({ where: { id: orderId }, select: { mongoId: true } }))?.mongoId;
    if (thisOrderMongoId) {
      const cycleKeys = Array.from({ length: 4 }, (_, i) => [
        `order-settlement-debit-${thisOrderMongoId}-c${i}`,
        `order-commission-${thisOrderMongoId}-c${i}`,
        `order-margin-${thisOrderMongoId}-c${i}`,
      ]).flat();
      try { await db.transaction.deleteMany({ where: { idempotencyKey: { in: [`order-settlement-debit-${thisOrderMongoId}`, `order-commission-${thisOrderMongoId}`, `order-margin-${thisOrderMongoId}`, ...cycleKeys] } } }); } catch { /* ignore */ }
    }

    // Snapshot wallet balance immediately BEFORE settling
    const walletSnap = await db.wallet.findFirst({ where: { ownerUserId: campaignBrandUserId, isDeleted: false } });
    expect(walletSnap).toBeTruthy();
    const brandAvailableBefore = Number(walletSnap?.availablePaise ?? 0);

    // Ops settle (with optional settlementRef)
    const settleRes = await request(app)
      .post('/api/ops/orders/settle')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ orderId, settlementRef: 'UTR_TEST_123' });

    expect(settleRes.status).toBe(200);
    expect(settleRes.body).toHaveProperty('ok', true);

    // Verify the order was actually settled (not cap-exceeded)
    const settledOrder = await db.order.findFirst({ where: { id: orderId, isDeleted: false } });
    expect(String(settledOrder?.affiliateStatus)).toBe('Approved_Settled');

    const brandWalletAfter = await db.wallet.findFirst({ where: { ownerUserId: campaignBrandUserId, isDeleted: false } });
    expect(brandWalletAfter).toBeTruthy();
    const brandAvailableAfter = Number(brandWalletAfter?.availablePaise ?? 0);

    expect(brandAvailableAfter).toBe(brandAvailableBefore - payoutPaise);
    // Shopper can fetch own orders
    const myOrdersRes = await request(app)
      .get(`/api/orders/user/${shopper.userId}`)
      .set('Authorization', `Bearer ${shopper.token}`);

    expect(myOrdersRes.status).toBe(200);
    expect(Array.isArray(myOrdersRes.body)).toBe(true);
    expect(myOrdersRes.body.some((o: any) => o.id === orderId)).toBe(true);

    // Clean up any existing connection between agency and brand so we can test fresh
    const brandUser = await db.user.findFirst({ where: { brandCode: E2E_ACCOUNTS.brand.brandCode, isDeleted: false } });
    if (brandUser) {
      const currentConnected = Array.isArray(brandUser.connectedAgencies) ? brandUser.connectedAgencies as string[] : [];
      const stripped = currentConnected.filter((c: string) => c !== E2E_ACCOUNTS.agency.agencyCode);
      await db.user.update({ where: { id: brandUser.id }, data: { connectedAgencies: stripped } });
      await db.pendingConnection.deleteMany({ where: { userId: brandUser.id, agencyCode: E2E_ACCOUNTS.agency.agencyCode } });
    }

    // Agency requests brand connection (agency-only)
    const connectRes = await request(app)
      .post('/api/ops/brands/connect')
      .set('Authorization', `Bearer ${agency.token}`)
      .send({ brandCode: E2E_ACCOUNTS.brand.brandCode });

    expect(connectRes.status).toBe(200);
    expect(connectRes.body).toHaveProperty('ok', true);

    // Brand approves connection (brand-only)
    const approveConnRes = await request(app)
      .post('/api/brand/requests/resolve')
      .set('Authorization', `Bearer ${brand.token}`)
      .send({ agencyCode: E2E_ACCOUNTS.agency.agencyCode, action: 'approve' });

    expect(approveConnRes.status).toBe(200);
    expect(approveConnRes.body).toHaveProperty('ok', true);

    // Brand pays out to agency (requires connection)
    const payoutRes = await request(app)
      .post('/api/brand/payout')
      .set('Authorization', `Bearer ${brand.token}`)
      .send({ agencyId: E2E_ACCOUNTS.agency.agencyCode, amount: 10, ref: `REF_${Date.now()}` });

    // NOTE: payout endpoint expects agencyId (PG UUID), not agencyCode.
    // Sending an agencyCode string fails with 404 — not a valid user ID.
    expect([400, 404]).toContain(payoutRes.status);

    // Fetch agencies list and pay using actual agency id.
    const agenciesRes = await request(app)
      .get('/api/brand/agencies')
      .set('Authorization', `Bearer ${brand.token}`);

    expect(agenciesRes.status).toBe(200);
    expect(Array.isArray(agenciesRes.body)).toBe(true);

    const agencyRow = agenciesRes.body.find((a: any) => a.code === E2E_ACCOUNTS.agency.agencyCode || a.mediatorCode === E2E_ACCOUNTS.agency.agencyCode);
    expect(agencyRow).toBeTruthy();

    const agencyId = String(agencyRow.id);

    const payoutOkRes = await request(app)
      .post('/api/brand/payout')
      .set('Authorization', `Bearer ${brand.token}`)
      .send({ agencyId, amount: 10, ref: `REF_OK_${Date.now()}` });

    expect(payoutOkRes.status).toBe(200);
    expect(payoutOkRes.body).toHaveProperty('ok', true);
  });
});
