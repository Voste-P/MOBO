import request from 'supertest';
import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

describe('notifications integration', () => {
  let app: any;
  let buyerToken: string;
  let _adminToken: string;
  let mediatorToken: string;
  let _brandToken: string;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    await seedE2E();
    app = createApp(env);

    // Login all roles
    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    buyerToken = buyerRes.body.tokens.accessToken;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
    _adminToken = adminRes.body.tokens.accessToken;

    const mediatorRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.mediator.mobile, password: E2E_ACCOUNTS.mediator.password });
    mediatorToken = mediatorRes.body.tokens.accessToken;

    const brandRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.brand.mobile, password: E2E_ACCOUNTS.brand.password });
    _brandToken = brandRes.body.tokens.accessToken;
  });

  it('buyer can list their notifications', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body) || (res.body.data && Array.isArray(res.body.data))).toBe(true);
  });

  it('mediator can list their notifications', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${mediatorToken}`);
    expect(res.status).toBe(200);
  });

  it('unauthenticated user cannot list notifications', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });
});
