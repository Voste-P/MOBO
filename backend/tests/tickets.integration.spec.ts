import request from 'supertest';
import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../seeds/e2e.js';

describe('tickets integration', () => {
  let app: any;
  let buyerToken: string;
  let buyerUserId: string;
  let adminToken: string;
  let mediatorToken: string;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    await seedE2E();
    app = createApp(env);

    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    buyerToken = buyerRes.body.tokens.accessToken;
    buyerUserId = buyerRes.body.user.id;

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
    adminToken = adminRes.body.tokens.accessToken;

    const mediatorRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.mediator.mobile, password: E2E_ACCOUNTS.mediator.password });
    mediatorToken = mediatorRes.body.tokens.accessToken;
  });

  it('buyer can create a support ticket', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        description: 'I have a problem with my order',
        issueType: 'Order Issue',
      });
    expect([200, 201]).toContain(res.status);
    if (res.status === 200 || res.status === 201) {
      expect(res.body).toHaveProperty('id');
    }
  });

  it('buyer can list their tickets', async () => {
    const res = await request(app)
      .get('/api/tickets')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    const tickets = Array.isArray(res.body) ? res.body : res.body.data;
    expect(Array.isArray(tickets)).toBe(true);
  });

  it('admin can list all tickets', async () => {
    const res = await request(app)
      .get('/api/tickets')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('unauthenticated user cannot create tickets', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .send({ subject: 'Test', description: 'test', issueType: 'order_issue' });
    expect(res.status).toBe(401);
  });

  it('rejects ticket creation with missing fields', async () => {
    const res = await request(app)
      .post('/api/tickets')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ subject: '' });
    expect([400, 422]).toContain(res.status);
  });
});
