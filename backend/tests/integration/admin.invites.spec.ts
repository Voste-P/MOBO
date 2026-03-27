import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

async function loginAdmin(app: any) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
  expect(res.status).toBe(200);
  return res.body.tokens.accessToken as string;
}

describe('admin invites', () => {
  it('can create, list, and revoke invites', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);
    const adminToken = await loginAdmin(app);

    const createRes = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'brand', label: 'Test Invite', maxUses: 1, ttlSeconds: 60 });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toHaveProperty('code');
    expect(createRes.body).toHaveProperty('role', 'brand');

    const code = createRes.body.code as string;

    const listRes = await request(app)
      .get('/api/admin/invites')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.some((i: any) => i.code === code)).toBe(true);

    const revokeRes = await request(app)
      .post('/api/admin/invites/revoke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code, reason: 'test cleanup' });

    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body).toHaveProperty('ok', true);

    const listAfterRes = await request(app)
      .get('/api/admin/invites')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(listAfterRes.status).toBe(200);
    const updated = listAfterRes.body.find((i: any) => i.code === code);
    expect(updated).toBeTruthy();
    expect(updated.status).toBe('revoked');
  });
});
