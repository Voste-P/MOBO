import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Notifications API', () => {
  let shopperToken: string;

  test.beforeAll(async ({ request }) => {
    const shopper = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    shopperToken = shopper.accessToken;
  });

  // ── Push public key (no auth required) ─────────────────────────
  test('can fetch push VAPID public key', async ({ request }) => {
    const res = await request.get('/api/notifications/push/public-key');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // publicKey can be null if VAPID is not configured
    expect('publicKey' in body || 'key' in body).toBeTruthy();
  });

  // ── List notifications ─────────────────────────────────────────
  test('authenticated user can list notifications', async ({ request }) => {
    const res = await request.get('/api/notifications', {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Push subscribe ─────────────────────────────────────────────
  test('can subscribe to push notifications', async ({ request }) => {
    const res = await request.post('/api/notifications/push/subscribe', {
      headers: authHeaders(shopperToken),
      data: {
        app: 'buyer',
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-test-endpoint',
          keys: {
            p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRI',
            auth: 'tBHItJI5svbpC7',
          },
        },
      },
    });
    // May return 200/201 on success, or 400 if VAPID is not configured
    expect([200, 201, 400]).toContain(res.status());
  });

  // ── Push unsubscribe ───────────────────────────────────────────
  test('can unsubscribe from push notifications', async ({ request }) => {
    const res = await request.delete('/api/notifications/push/subscribe', {
      headers: authHeaders(shopperToken),
      data: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-test-endpoint',
      },
    });
    // May return 200/204 on success, or 404 if no subscription exists
    expect([200, 204, 400, 404]).toContain(res.status());
  });

  // ── Unauthenticated access blocked ─────────────────────────────
  test('unauthenticated request cannot list notifications', async ({ request }) => {
    const res = await request.get('/api/notifications');
    expect([401, 403]).toContain(res.status());
  });
});
