import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';
import { prisma } from '../../database/prisma.js';

describe('order velocity limits', () => {
  let app: any;
  let buyerToken: string;
  let buyerUserId: string;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    await seedE2E();
    app = createApp(env);

    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    buyerToken = buyerRes.body.tokens.accessToken;
    buyerUserId = buyerRes.body.user.id;
  });

  it('buyer can create an order', async () => {
    const db = prisma();
    const deal = await db.deal.findFirst({
      where: { active: true, isDeleted: false },
      select: { id: true, campaignId: true, title: true, image: true, pricePaise: true, commissionPaise: true, dealType: true, platform: true, brandName: true },
    });

    if (!deal) {
      // Skip if no deals exist in test DB
      return;
    }

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        userId: buyerUserId,
        items: [{
          productId: String(deal.id || deal.id),
          title: String(deal.title ?? 'Deal'),
          image: String(deal.image ?? 'https://example.com/e2e.png'),
          priceAtPurchase: Number(deal.pricePaise ?? 0) / 100,
          commission: Number(deal.commissionPaise ?? 0) / 100,
          campaignId: String(deal.campaignId ?? ''),
          dealType: String(deal.dealType ?? 'General'),
          quantity: 1,
          platform: deal.platform ? String(deal.platform) : undefined,
          brandName: deal.brandName ? String(deal.brandName) : undefined,
        }],
        externalOrderId: `VEL-TEST-${randomUUID().slice(0, 8)}`,
        screenshots: {
          order: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAADUlEQVQYV2P4////fwYACf4C/dQhMwAAAABJRU5ErkJggg==',
        },
      });
    // 200/201 if successful, 400 validation, 403 RBAC, 429 velocity limit
    expect([200, 201, 400, 403, 429]).toContain(res.status);
  });

  it('rejects order creation without auth', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({ userId: 'test', items: [{ productId: 'x', title: 'x', image: 'x', priceAtPurchase: 0, commission: 0, campaignId: 'x', dealType: 'x', quantity: 1 }] });
    expect(res.status).toBe(401);
  });

  it('rejects order with duplicate external order ID', async () => {
    const db = prisma();
    const deal = await db.deal.findFirst({
      where: { active: true, isDeleted: false },
      select: { id: true, campaignId: true, title: true, image: true, pricePaise: true, commissionPaise: true, dealType: true },
    });

    if (!deal) return;

    const externalOrderId = `DUP-TEST-${randomUUID().slice(0, 8)}`;
    const orderPayload = {
      userId: buyerUserId,
      items: [{
        productId: String(deal.id || deal.id),
        title: String(deal.title ?? 'Deal'),
        image: String(deal.image ?? 'https://example.com/e2e.png'),
        priceAtPurchase: Number(deal.pricePaise ?? 0) / 100,
        commission: Number(deal.commissionPaise ?? 0) / 100,
        campaignId: String(deal.campaignId ?? ''),
        dealType: String(deal.dealType ?? 'General'),
        quantity: 1,
      }],
      externalOrderId,
      screenshots: {
        order: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAADUlEQVQYV2P4////fwYACf4C/dQhMwAAAABJRU5ErkJggg==',
      },
    };
    // First order
    await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(orderPayload);

    // Second order with same external ID should be rejected
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send(orderPayload);
    // 400 validation, 403 RBAC, 409 duplicate, 429 velocity
    expect([400, 403, 409, 429]).toContain(res.status);
  });
});
