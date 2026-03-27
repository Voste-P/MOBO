import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

async function loginAdmin(app: any, username: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return res.body.tokens.accessToken as string;
}

describe('admin invites delete', () => {
  it('allows admin to delete an unused active invite code', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);
    const adminToken = await loginAdmin(app, E2E_ACCOUNTS.admin.username, E2E_ACCOUNTS.admin.password);

    const createRes = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'brand', label: 'Delete test invite', maxUses: 1, ttlSeconds: 60 });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toHaveProperty('code');
    const code = createRes.body.code as string;

    const delRes = await request(app)
      .delete(`/api/admin/invites/${encodeURIComponent(code)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.status).toBe(200);

    const listRes = await request(app)
      .get('/api/admin/invites')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    // After soft-delete the invite is revoked, not physically removed
    const deleted = listRes.body.find((i: any) => i.code === code);
    expect(!deleted || deleted.status === 'revoked').toBe(true);
  });
});
