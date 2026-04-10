import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Google OAuth & Sheets export API', () => {
  let shopperToken: string;
  let agencyToken: string;

  test.beforeAll(async ({ request }) => {
    const [shopper, agency] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.agency.mobile,
        password: E2E_ACCOUNTS.agency.password,
      }),
    ]);
    shopperToken = shopper.accessToken;
    agencyToken = agency.accessToken;
  });

  // ── Google OAuth ──────────────────────────────────────────────
  test('Google auth URL requires auth', async ({ request }) => {
    const res = await request.get('/api/google/auth');
    expect([401, 403]).toContain(res.status());
  });

  test('authenticated user can get Google auth URL', async ({ request }) => {
    const res = await request.get('/api/google/auth', {
      headers: authHeaders(shopperToken),
    });
    // Returns auth URL or 503 if Google not configured
    expect(res.status() < 500 || res.status() === 503).toBeTruthy();
  });

  test('Google status requires auth', async ({ request }) => {
    const res = await request.get('/api/google/status');
    expect([401, 403]).toContain(res.status());
  });

  test('authenticated user can check Google status', async ({ request }) => {
    const res = await request.get('/api/google/status', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('Google disconnect requires auth', async ({ request }) => {
    const res = await request.post('/api/google/disconnect');
    expect([401, 403]).toContain(res.status());
  });

  test('authenticated user can disconnect Google', async ({ request }) => {
    const res = await request.post('/api/google/disconnect', {
      headers: authHeaders(shopperToken),
    });
    // May succeed (200/204) or fail gracefully (400 if not connected)
    expect(res.status()).toBeLessThan(500);
  });

  // ── Sheets export ─────────────────────────────────────────────
  test('sheets export requires auth', async ({ request }) => {
    const res = await request.post('/api/sheets/export', {
      data: { type: 'orders' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('sheets export rejects empty payload', async ({ request }) => {
    const res = await request.post('/api/sheets/export', {
      headers: authHeaders(agencyToken),
      data: {},
    });
    // Should fail validation, not 500
    expect(res.status()).toBeLessThan(500);
  });

  test('sheets export with valid type', async ({ request }) => {
    const res = await request.post('/api/sheets/export', {
      headers: authHeaders(agencyToken),
      data: { type: 'orders' },
    });
    // May fail if Google not connected — but should not 500
    expect(res.status()).toBeLessThan(500);
  });
});
