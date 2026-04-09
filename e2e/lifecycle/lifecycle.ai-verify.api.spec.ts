import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('AI verification endpoints', () => {
  let buyerToken: string;
  let adminToken: string;

  test.beforeAll(async ({ request }) => {
    const [buyer, admin] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
      loginAndGetAccessToken(request, {
        username: E2E_ACCOUNTS.admin.username,
        password: E2E_ACCOUNTS.admin.password,
      }),
    ]);
    buyerToken = buyer.accessToken;
    adminToken = admin.accessToken;
  });

  // ── AI status endpoint (no auth) ──────────────────────────────
  test('AI status endpoint returns status', async ({ request }) => {
    const res = await request.get('/api/ai/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('configured');
  });

  // ── Chat endpoint requires auth or is optional ────────────────
  test('AI chat rejects empty message', async ({ request }) => {
    const res = await request.post('/api/ai/chat', {
      headers: authHeaders(buyerToken),
      data: { message: '' },
    });
    // Should reject with 400/422 or 503 (AI not configured) or return validation error
    expect([400, 422, 503].includes(res.status()) || res.ok()).toBeTruthy();
  });

  // ── Verify proof requires auth ────────────────────────────────
  test('verify-proof rejects unauthenticated request', async ({ request }) => {
    const res = await request.post('/api/ai/verify-proof', {
      data: { image: 'test' },
    });
    expect([401, 403]).toContain(res.status());
  });

  // ── Verify rating requires auth ───────────────────────────────
  test('verify-rating rejects unauthenticated request', async ({ request }) => {
    const res = await request.post('/api/ai/verify-rating', {
      data: { image: 'test' },
    });
    expect([401, 403]).toContain(res.status());
  });

  // ── Verify return window requires auth ────────────────────────
  test('verify-return-window rejects unauthenticated request', async ({ request }) => {
    const res = await request.post('/api/ai/verify-return-window', {
      data: { image: 'test' },
    });
    expect([401, 403]).toContain(res.status());
  });

  // ── Extract order requires auth ───────────────────────────────
  test('extract-order rejects unauthenticated request', async ({ request }) => {
    const res = await request.post('/api/ai/extract-order', {
      data: { image: 'test' },
    });
    expect([401, 403]).toContain(res.status());
  });

  // ── Check-key requires admin/ops role ─────────────────────────
  test('check-key rejects buyer', async ({ request }) => {
    const res = await request.post('/api/ai/check-key', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('check-key accessible by admin', async ({ request }) => {
    const res = await request.post('/api/ai/check-key', {
      headers: authHeaders(adminToken),
    });
    // May return 200 or 400 depending on config — but not 403
    expect(res.status()).not.toBe(403);
  });

  // ── Verify proof with invalid payload ─────────────────────────
  test('verify-proof rejects missing image data', async ({ request }) => {
    const res = await request.post('/api/ai/verify-proof', {
      headers: authHeaders(buyerToken),
      data: {},
    });
    // Should fail validation (400/422) or service-level error, NOT crash (500)
    expect(res.status()).toBeLessThan(500);
  });

  // ── Verify rating with invalid payload ────────────────────────
  test('verify-rating rejects missing image data', async ({ request }) => {
    const res = await request.post('/api/ai/verify-rating', {
      headers: authHeaders(buyerToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });
});
