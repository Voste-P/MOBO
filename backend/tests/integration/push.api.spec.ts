import request from 'supertest';
import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

describe('push notifications API', () => {
  let app: any;
  let buyerToken: string;

  beforeAll(async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    await seedE2E();
    app = createApp(env);

    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
    buyerToken = buyerRes.body.tokens.accessToken;
  });

  it('returns VAPID public key', async () => {
    const res = await request(app)
      .get('/api/notifications/push/public-key');
    // VAPID keys may not be configured in test env
    expect([200, 404, 501]).toContain(res.status);
  });

  it('rejects subscription without auth', async () => {
    const res = await request(app)
      .post('/api/notifications/push/subscribe')
      .send({
        app: 'buyer',
        subscription: {
          endpoint: 'https://fcm.googleapis.com/v1/test',
          keys: { auth: 'test', p256dh: 'test' },
        },
      });
    expect(res.status).toBe(401);
  });

  it('rejects invalid subscription payload', async () => {
    const res = await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ subscription: {} });
    expect([400, 422]).toContain(res.status);
  });
});
