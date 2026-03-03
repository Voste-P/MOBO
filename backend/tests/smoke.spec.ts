import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { seedE2E, E2E_ACCOUNTS } from '../seeds/e2e.js';

describe('api smoke', () => {
  it('serves health and core protected endpoints', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const campaign = await prisma().campaign.findFirst({
      where: { title: 'E2E Campaign', isDeleted: false },
    });
    expect(campaign).toBeTruthy();

    // Ensure buyer has at least one visible deal.
    const existingDeal = await prisma().deal.findFirst({
      where: {
        campaignId: campaign!.id,
        mediatorCode: 'MED_TEST',
        isDeleted: false,
      },
    });

    if (!existingDeal) {
      await prisma().deal.create({
        data: {
          mongoId: randomUUID(),
          campaignId: campaign!.id,
          mediatorCode: 'MED_TEST',
          title: 'E2E Deal',
          description: 'E2E deal for buyer app',
          image: 'https://placehold.co/600x400',
          productUrl: 'https://example.com/product',
          platform: 'Amazon',
          brandName: 'E2E Brand',
          dealType: 'Discount',
          originalPricePaise: 199900,
          pricePaise: 99900,
          commissionPaise: 15000,
          payoutPaise: 15000,
          active: true,
        },
      });
    }

    const app = createApp(env);

    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body).toHaveProperty('status', 'ok');

    const adminLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
    expect(adminLoginRes.status).toBe(200);

    const adminToken = adminLoginRes.body.tokens.accessToken as string;
    expect(typeof adminToken).toBe('string');

    const statsRes = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body && typeof statsRes.body === 'object').toBe(true);

    const buyerLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    expect(buyerLoginRes.status).toBe(200);

    const buyerToken = buyerLoginRes.body.tokens.accessToken as string;
    const buyerUserId = buyerLoginRes.body.user.id as string;

    const buyerMeRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(buyerMeRes.status).toBe(200);
    expect(buyerMeRes.body).toHaveProperty('user');
    expect(buyerMeRes.body.user).toHaveProperty('id', buyerUserId);

    const productsRes = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(productsRes.status).toBe(200);
    expect(Array.isArray(productsRes.body)).toBe(true);
    expect(productsRes.body.length).toBeGreaterThan(0);

    const buyerOrdersRes = await request(app)
      .get(`/api/orders/user/${buyerUserId}`)
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(buyerOrdersRes.status).toBe(200);
    expect(Array.isArray(buyerOrdersRes.body)).toBe(true);
  });
});
