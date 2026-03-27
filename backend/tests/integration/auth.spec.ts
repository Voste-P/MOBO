import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

describe('auth', () => {
  it('logs in and calls /me', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });

    expect(loginRes.status).toBe(200);
    expect(String(loginRes.header['cache-control'] || '')).toContain('no-store');
    expect(loginRes.body).toHaveProperty('user');
    expect(loginRes.body).toHaveProperty('tokens');
    expect(typeof loginRes.body.tokens?.accessToken).toBe('string');

    const accessToken = loginRes.body.tokens.accessToken as string;

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body).toHaveProperty('user');
    expect(meRes.body.user).toHaveProperty('id');
    expect(meRes.body.user).toHaveProperty('mobile', E2E_ACCOUNTS.admin.mobile);
  });

  it('allows profile update when optional fields are blank', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    await seedE2E();

    const app = createApp(env);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.mediator.mobile, password: E2E_ACCOUNTS.mediator.password });
    expect(loginRes.status).toBe(200);

    const accessToken = loginRes.body.tokens.accessToken as string;

    const patchRes = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        upiId: '',
        bankDetails: {
          accountNumber: '',
          ifsc: '',
          bankName: '',
          holderName: '',
        },
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toHaveProperty('user');
    expect(patchRes.body.user).toHaveProperty('mobile', E2E_ACCOUNTS.mediator.mobile);
  });
});
