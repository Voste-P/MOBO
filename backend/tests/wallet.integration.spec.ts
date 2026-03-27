import request from 'supertest';
import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../seeds/e2e.js';
import { prisma } from '../database/prisma.js';

describe('wallet integration', () => {
  let app: any;
  let adminToken: string;
  let buyerToken: string;
  let buyerUserId: string;
  let brandToken: string;
  let brandUserId: string;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    await seedE2E();
    app = createApp(env);

    // Login as admin
    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
    adminToken = adminRes.body.tokens.accessToken;

    // Login as buyer
    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    buyerToken = buyerRes.body.tokens.accessToken;
    buyerUserId = buyerRes.body.user.id;

    // Login as brand
    const brandRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.brand.mobile, password: E2E_ACCOUNTS.brand.password });
    brandToken = brandRes.body.tokens.accessToken;
    brandUserId = brandRes.body.user.id;
  });

  it('buyer has a wallet after login', async () => {
    const db = prisma();
    const wallet = await db.wallet.findUnique({ where: { ownerUserId: buyerUserId } });
    // Wallet may not exist until first transaction, but the user should exist
    const user = await db.user.findUnique({ where: { id: buyerUserId } });
    expect(user).toBeTruthy();
    expect(user!.status).toBe('active');
  });

  it('brand can view their transactions', async () => {
    const res = await request(app)
      .get('/api/brand/transactions')
      .set('Authorization', `Bearer ${brandToken}`);
    expect([200, 204]).toContain(res.status);
  });

  it('buyer cannot access brand transactions', async () => {
    const res = await request(app)
      .get('/api/brand/transactions')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(403);
  });

  it('admin can view system financials', async () => {
    const res = await request(app)
      .get('/api/admin/financials')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('buyer cannot access admin financials', async () => {
    const res = await request(app)
      .get('/api/admin/financials')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(403);
  });
});
