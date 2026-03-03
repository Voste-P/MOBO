import request from 'supertest';

import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../seeds/e2e.js';
import { prisma } from '../database/prisma.js';

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

describe('order step verification (purchase vs review/rating)', () => {
  it('keeps order UNDER_REVIEW when purchase verified but review proof missing, then approves after review verified', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const shopper = await login(app, E2E_ACCOUNTS.shopper.mobile, E2E_ACCOUNTS.shopper.password);
    const admin = await loginAdmin(app, E2E_ACCOUNTS.admin.username, E2E_ACCOUNTS.admin.password);

    const productsRes = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${shopper.token}`);
    expect(productsRes.status).toBe(200);
    expect(Array.isArray(productsRes.body)).toBe(true);
    expect(productsRes.body.length).toBeGreaterThan(0);

    const deal = productsRes.body[0];

    // Reset velocity counter: soft-delete ALL orders for this user so the
    // per-buyer velocity limit (10/hour, 30/day) does not fire on repeated runs.
    await prisma().order.updateMany({
      where: { userId: shopper.userId, isDeleted: false },
      data: { isDeleted: true },
    });

    const createOrderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({
        userId: shopper.userId,
        items: [
          {
            productId: String(deal.id),
            title: String(deal.title || 'E2E Deal'),
            image: String(deal.image || 'https://placehold.co/600x400'),
            priceAtPurchase: Number(deal.price || 999),
            commission: Number(deal.commission || 50),
            campaignId: String(deal.campaignId || deal.campaign?.id || deal.campaign || ''),
            dealType: 'Review',
            quantity: 1,
            platform: String(deal.platform || 'Amazon'),
            brandName: String(deal.brandName || 'E2E Brand'),
          },
        ],
        externalOrderId: `EXT_REVIEW_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        screenshots: { order: LARGE_DATA_URL },
      });

    expect(createOrderRes.status).toBe(201);
    const orderId = String(createOrderRes.body.id);
    expect(orderId).toBeTruthy();

    const verifyPurchaseRes = await request(app)
      .post('/api/ops/verify')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ orderId });

    expect(verifyPurchaseRes.status).toBe(200);
    expect(verifyPurchaseRes.body).toHaveProperty('ok', true);
    expect(verifyPurchaseRes.body).toHaveProperty('approved', false);
    expect(Array.isArray(verifyPurchaseRes.body.missingProofs)).toBe(true);
    expect(verifyPurchaseRes.body.missingProofs).toContain('review');

    const afterPurchase = await prisma().order.findFirst({ where: { id: orderId } });
    expect(afterPurchase).toBeTruthy();
    expect(afterPurchase?.workflowStatus).toBe('UNDER_REVIEW');
    expect(!!(afterPurchase?.verification as any)?.order?.verifiedAt).toBe(true);

    const submitReviewRes = await request(app)
      .post('/api/orders/claim')
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({ orderId, type: 'review', data: 'https://example.com/review/123' });

    expect(submitReviewRes.status).toBe(200);

    const verifyReviewRes = await request(app)
      .post('/api/ops/orders/verify-requirement')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ orderId, type: 'review' });

    expect(verifyReviewRes.status).toBe(200);
    expect(verifyReviewRes.body).toHaveProperty('ok', true);
    // Review verified but returnWindow still missing for Review deals
    expect(verifyReviewRes.body).toHaveProperty('approved', false);
    expect(verifyReviewRes.body.missingProofs).toContain('returnWindow');

    // Submit returnWindow proof
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

    const finalOrder = await prisma().order.findFirst({ where: { id: orderId } });
    expect(finalOrder).toBeTruthy();
    expect(finalOrder?.workflowStatus).toBe('APPROVED');
    expect(finalOrder?.affiliateStatus).toBe('Pending_Cooling');
    expect(!!(finalOrder?.verification as any)?.review?.verifiedAt).toBe(true);
    expect(!!(finalOrder?.verification as any)?.returnWindow?.verifiedAt).toBe(true);
  });

  it('keeps order UNDER_REVIEW when purchase verified but rating proof missing, then approves after rating verified', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const shopper = await login(app, E2E_ACCOUNTS.shopper2.mobile, E2E_ACCOUNTS.shopper2.password);
    const admin = await loginAdmin(app, E2E_ACCOUNTS.admin.username, E2E_ACCOUNTS.admin.password);

    const productsRes = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${shopper.token}`);
    expect(productsRes.status).toBe(200);
    expect(Array.isArray(productsRes.body)).toBe(true);
    expect(productsRes.body.length).toBeGreaterThan(0);

    // Use productsRes.body[0] — shopper2 hasn't ordered this deal yet
    const deal = productsRes.body[0];

    // Reset velocity counter: soft-delete ALL orders for this user so the
    // per-buyer velocity limit (10/hour, 30/day) does not fire on repeated runs.
    await prisma().order.updateMany({
      where: { userId: shopper.userId, isDeleted: false },
      data: { isDeleted: true },
    });

    const createOrderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({
        userId: shopper.userId,
        items: [
          {
            productId: String(deal.id),
            title: String(deal.title || 'E2E Deal'),
            image: String(deal.image || 'https://placehold.co/600x400'),
            priceAtPurchase: Number(deal.price || 999),
            commission: Number(deal.commission || 50),
            campaignId: String(deal.campaignId || deal.campaign?.id || deal.campaign || ''),
            dealType: 'Rating',
            quantity: 1,
            platform: String(deal.platform || 'Amazon'),
            brandName: String(deal.brandName || 'E2E Brand'),
          },
        ],
        externalOrderId: `EXT_RATING_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        screenshots: { order: LARGE_DATA_URL },
      });

    expect(createOrderRes.status).toBe(201);
    const orderId = String(createOrderRes.body.id);
    expect(orderId).toBeTruthy();

    const verifyPurchaseRes = await request(app)
      .post('/api/ops/verify')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ orderId });

    expect(verifyPurchaseRes.status).toBe(200);
    expect(verifyPurchaseRes.body).toHaveProperty('ok', true);
    expect(verifyPurchaseRes.body).toHaveProperty('approved', false);
    expect(Array.isArray(verifyPurchaseRes.body.missingProofs)).toBe(true);
    expect(verifyPurchaseRes.body.missingProofs).toContain('rating');

    const submitRatingRes = await request(app)
      .post('/api/orders/claim')
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({ orderId, type: 'rating', data: LARGE_DATA_URL });

    expect(submitRatingRes.status).toBe(200);

    const verifyRatingRes = await request(app)
      .post('/api/ops/orders/verify-requirement')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ orderId, type: 'rating' });

    expect(verifyRatingRes.status).toBe(200);
    expect(verifyRatingRes.body).toHaveProperty('ok', true);
    // Rating verified but returnWindow still missing for Rating deals
    expect(verifyRatingRes.body).toHaveProperty('approved', false);
    expect(verifyRatingRes.body.missingProofs).toContain('returnWindow');

    // Submit returnWindow proof
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

    const finalOrder = await prisma().order.findFirst({ where: { id: orderId } });
    expect(finalOrder).toBeTruthy();
    expect(finalOrder?.workflowStatus).toBe('APPROVED');
    expect(finalOrder?.affiliateStatus).toBe('Pending_Cooling');
    expect(!!(finalOrder?.verification as any)?.rating?.verifiedAt).toBe(true);
    expect(!!(finalOrder?.verification as any)?.returnWindow?.verifiedAt).toBe(true);
  });
});
