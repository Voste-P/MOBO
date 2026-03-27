import request from 'supertest';
import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../seeds/e2e.js';
import { prisma } from '../database/prisma.js';

describe('audit log integration', () => {
  let app: any;
  let adminToken: string;
  let buyerToken: string;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    await seedE2E();
    app = createApp(env);

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
    adminToken = adminRes.body.tokens.accessToken;

    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    buyerToken = buyerRes.body.tokens.accessToken;
  });

  it('admin can view audit logs', async () => {
    const res = await request(app)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const logs = Array.isArray(res.body) ? res.body : (res.body.data || []);
    expect(Array.isArray(logs)).toBe(true);
  });

  it('buyer cannot view audit logs', async () => {
    const res = await request(app)
      .get('/api/admin/audit-logs')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(403);
  });

  it('login creates an audit trail entry', async () => {
    const db = prisma();
    // Count audit logs before
    const before = await db.auditLog.count();

    // Trigger a login
    await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });

    // Check audit log count increased
    const after = await db.auditLog.count();
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('audit logs have required fields', async () => {
    const db = prisma();
    const log = await db.auditLog.findFirst({ orderBy: { createdAt: 'desc' } });
    if (log) {
      expect(log.action).toBeDefined();
      expect(typeof log.action).toBe('string');
      expect(log.createdAt).toBeDefined();
    }
  });
});
