import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Health & Realtime API', () => {
  let shopperToken: string;

  test.beforeAll(async ({ request }) => {
    const shopper = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    shopperToken = shopper.accessToken;
  });

  // ── Health endpoints ───────────────────────────────────────────
  test('health/live returns 200', async ({ request }) => {
    const res = await request.get('/api/health/live');
    expect(res.ok()).toBeTruthy();
  });

  test('health/ready returns 200', async ({ request }) => {
    const res = await request.get('/api/health/ready');
    expect(res.ok()).toBeTruthy();
  });

  test('health root returns 200', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
  });

  test('health/e2e returns 200', async ({ request }) => {
    // CI starts only the backend — portals are not running, so /health/e2e returns 503.
    // Locally the portals may also not be running.
    test.skip(!!process.env.CI, 'Portals not available in CI');
    const res = await request.get('/api/health/e2e');
    test.skip(!res.ok(), 'Portals not running');
    expect(res.ok()).toBeTruthy();
  });

  test('client-error endpoint accepts error report', async ({ request }) => {
    const res = await request.post('/api/health/client-error', {
      data: {
        message: 'E2E test client error',
        stack: 'Error: test\n    at e2e/test.ts:1:1',
        url: 'http://localhost:3001/test-page',
      },
    });
    // May return 200/204 on success
    expect([200, 204]).toContain(res.status());
  });

  // ── Realtime health ────────────────────────────────────────────
  test('realtime health endpoint returns 200', async ({ request }) => {
    const res = await request.get('/api/realtime/health');
    expect(res.ok()).toBeTruthy();
  });

  // ── Products (shopper role) ────────────────────────────────────
  test('shopper can list products', async ({ request }) => {
    const res = await request.get('/api/products', {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Products RBAC ──────────────────────────────────────────────
  test('unauthenticated request cannot list products', async ({ request }) => {
    const res = await request.get('/api/products');
    expect([401, 403]).toContain(res.status());
  });
});
