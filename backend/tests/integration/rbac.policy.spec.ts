import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

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

describe('RBAC policy (route guards + ownership)', () => {
  it('enforces key route-level role gates', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const admin = await loginAdmin(app, E2E_ACCOUNTS.admin.username, E2E_ACCOUNTS.admin.password);
    const agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);
    const mediator = await login(app, E2E_ACCOUNTS.mediator.mobile, E2E_ACCOUNTS.mediator.password);
    const brand = await login(app, E2E_ACCOUNTS.brand.mobile, E2E_ACCOUNTS.brand.password);
    const shopper = await login(app, E2E_ACCOUNTS.shopper.mobile, E2E_ACCOUNTS.shopper.password);

    // Admin routes: admin-only
    {
      const resAdmin = await request(app)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${admin.token}`);
      expect(resAdmin.status).toBe(200);

      const resBrand = await request(app)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${brand.token}`);
      expect(resBrand.status).toBe(403);

      const resAgency = await request(app)
        .get('/api/admin/stats')
        .set('Authorization', `Bearer ${agency.token}`);
      expect(resAgency.status).toBe(403);
    }

    // Brand routes: brand/admin/ops only
    {
      const resBrand = await request(app)
        .get('/api/brand/campaigns')
        .set('Authorization', `Bearer ${brand.token}`);
      expect([200, 204]).toContain(resBrand.status);

      const resShopper = await request(app)
        .get('/api/brand/campaigns')
        .set('Authorization', `Bearer ${shopper.token}`);
      expect(resShopper.status).toBe(403);

      const resMediator = await request(app)
        .get('/api/brand/campaigns')
        .set('Authorization', `Bearer ${mediator.token}`);
      expect(resMediator.status).toBe(403);
    }

    // Products: shopper-only
    {
      const resShopper = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${shopper.token}`);
      expect(resShopper.status).toBe(200);

      const resMediator = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${mediator.token}`);
      expect(resMediator.status).toBe(403);

      const resAgency = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${agency.token}`);
      expect(resAgency.status).toBe(403);
    }

    // Ops routes: role gate allows agency/mediator/admin/ops but controller may be stricter.
    // Agency-only intent: brand connect
    {
      const resAgency = await request(app)
        .post('/api/ops/brands/connect')
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ brandCode: E2E_ACCOUNTS.brand.brandCode });
      expect([200, 409]).toContain(resAgency.status); // 409 if already requested/connected

      const resMediator = await request(app)
        .post('/api/ops/brands/connect')
        .set('Authorization', `Bearer ${mediator.token}`)
        .send({ brandCode: E2E_ACCOUNTS.brand.brandCode });
      expect(resMediator.status).toBe(403);
    }

    // Settlement: controller-scoped (role gate allows agency/mediator/admin/ops)
    {
      // get a deal and create the minimal flow to reach APPROVED is covered elsewhere;
      // here we only assert that non-privileged callers are rejected even if they try.
      const resAgency = await request(app)
        .post('/api/ops/orders/settle')
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ orderId: '000000000000000000000000' });
      expect(resAgency.status).toBe(404);

      const resMediator = await request(app)
        .post('/api/ops/orders/settle')
        .set('Authorization', `Bearer ${mediator.token}`)
        .send({ orderId: '000000000000000000000000' });
      expect(resMediator.status).toBe(404);

      const resBrand = await request(app)
        .post('/api/ops/orders/settle')
        .set('Authorization', `Bearer ${brand.token}`)
        .send({ orderId: '000000000000000000000000' });
      // brand cannot pass ops role gate
      expect(resBrand.status).toBe(403);

      const resShopper = await request(app)
        .post('/api/ops/orders/settle')
        .set('Authorization', `Bearer ${shopper.token}`)
        .send({ orderId: '000000000000000000000000' });
      expect(resShopper.status).toBe(403);
    }
  });

  it('enforces shopper ownership on order listing', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const shopper = await login(app, E2E_ACCOUNTS.shopper.mobile, E2E_ACCOUNTS.shopper.password);
    const shopper2 = await login(app, E2E_ACCOUNTS.shopper2.mobile, E2E_ACCOUNTS.shopper2.password);

    const resSelf = await request(app)
      .get(`/api/orders/user/${shopper.userId}`)
      .set('Authorization', `Bearer ${shopper.token}`);
    expect(resSelf.status).toBe(200);

    const resOther = await request(app)
      .get(`/api/orders/user/${shopper.userId}`)
      .set('Authorization', `Bearer ${shopper2.token}`);
    expect(resOther.status).toBe(403);
  });
});
