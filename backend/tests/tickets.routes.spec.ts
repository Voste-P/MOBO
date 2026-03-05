import request from 'supertest';

import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../seeds/e2e.js';

async function login(app: any, mobile: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ mobile, password });
  expect(res.status).toBe(200);
  return res.body.tokens.accessToken as string;
}

async function loginAdmin(app: any, username: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return res.body.tokens.accessToken as string;
}
describe('tickets routes', () => {
  it('allows shopper to create/list/update own ticket; blocks other shoppers; admin can list all', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const shopperToken = await login(app, E2E_ACCOUNTS.shopper.mobile, E2E_ACCOUNTS.shopper.password);
    const shopper2Token = await login(app, E2E_ACCOUNTS.shopper2.mobile, E2E_ACCOUNTS.shopper2.password);
    const adminToken = await loginAdmin(app, E2E_ACCOUNTS.admin.username, E2E_ACCOUNTS.admin.password);

    const createRes = await request(app)
      .post('/api/tickets')
      .set('Authorization', `Bearer ${shopperToken}`)
      .send({ issueType: 'Order Issue', description: 'E2E test ticket' });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toHaveProperty('id');
    expect(createRes.body).toHaveProperty('status', 'Open');
    expect(createRes.body).toHaveProperty('issueType', 'Order Issue');

    const ticketId = createRes.body.id as string;

    const listSelfRes = await request(app)
      .get('/api/tickets')
      .set('Authorization', `Bearer ${shopperToken}`);

    expect(listSelfRes.status).toBe(200);
    expect(Array.isArray(listSelfRes.body)).toBe(true);
    expect(listSelfRes.body.some((t: any) => t.id === ticketId)).toBe(true);

    const updateSelfRes = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${shopperToken}`)
      .send({ status: 'Resolved' });

    expect(updateSelfRes.status).toBe(200);
    expect(updateSelfRes.body).toHaveProperty('id', ticketId);
    expect(updateSelfRes.body).toHaveProperty('status', 'Resolved');

    const updateOtherRes = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${shopper2Token}`)
      .send({ status: 'Rejected' });

    expect(updateOtherRes.status).toBe(403);

    const listAdminRes = await request(app)
      .get('/api/tickets')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listAdminRes.status).toBe(200);
    expect(Array.isArray(listAdminRes.body)).toBe(true);
    expect(listAdminRes.body.some((t: any) => t.id === ticketId)).toBe(true);
  });

  it('allows deleting tickets only after resolved/rejected', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const shopperToken = await login(app, E2E_ACCOUNTS.shopper.mobile, E2E_ACCOUNTS.shopper.password);
    const adminToken = await loginAdmin(app, E2E_ACCOUNTS.admin.username, E2E_ACCOUNTS.admin.password);

    const createRes = await request(app)
      .post('/api/tickets')
      .set('Authorization', `Bearer ${shopperToken}`)
      .send({ issueType: 'Order Issue', description: 'E2E delete test ticket' });
    expect(createRes.status).toBe(201);
    const ticketId = createRes.body.id as string;

    const deleteOpenRes = await request(app)
      .delete(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${shopperToken}`);
    expect(deleteOpenRes.status).toBe(409);

    const resolveRes = await request(app)
      .patch(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${shopperToken}`)
      .send({ status: 'Resolved' });
    expect(resolveRes.status).toBe(200);

    const deleteResolvedRes = await request(app)
      .delete(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${shopperToken}`);
    expect(deleteResolvedRes.status).toBe(200);

    const listAdminRes = await request(app)
      .get('/api/tickets')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listAdminRes.status).toBe(200);
    expect(listAdminRes.body.some((t: any) => t.id === ticketId)).toBe(false);
  });
});
