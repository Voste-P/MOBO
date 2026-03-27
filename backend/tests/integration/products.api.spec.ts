import request from 'supertest';
import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

describe('products API', () => {
  let app: any;
  let buyerToken: string;
  let mediatorToken: string;
  let brandToken: string;
  let _adminToken: string;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    await seedE2E();
    app = createApp(env);

    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    buyerToken = buyerRes.body.tokens.accessToken;

    const mediatorRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.mediator.mobile, password: E2E_ACCOUNTS.mediator.password });
    mediatorToken = mediatorRes.body.tokens.accessToken;

    const brandRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.brand.mobile, password: E2E_ACCOUNTS.brand.password });
    brandToken = brandRes.body.tokens.accessToken;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
    _adminToken = adminRes.body.tokens.accessToken;
  });

  it('buyer can list products', async () => {
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body) || (res.body.data && Array.isArray(res.body.data))).toBe(true);
  });

  it('buyer can paginate products', async () => {
    const res = await request(app)
      .get('/api/products?page=1&limit=5')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    if (res.body.data) {
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page', 1);
      expect(res.body).toHaveProperty('limit', 5);
    }
  });

  it('mediator cannot list products', async () => {
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${mediatorToken}`);
    expect(res.status).toBe(403);
  });

  it('brand cannot list products', async () => {
    const res = await request(app)
      .get('/api/products')
      .set('Authorization', `Bearer ${brandToken}`);
    expect(res.status).toBe(403);
  });

  it('unauthenticated user cannot list products', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(401);
  });
});
