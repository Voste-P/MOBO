import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Auth lifecycle API', () => {
  let shopperToken: string;

  test.beforeAll(async ({ request }) => {
    const shopper = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    shopperToken = shopper.accessToken;
  });

  // ── Login ──────────────────────────────────────────────────────
  test('login returns tokens and user', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.tokens?.accessToken).toBeTruthy();
    expect(body.tokens?.refreshToken).toBeTruthy();
    expect(body.user).toBeTruthy();
  });

  // ── Me ─────────────────────────────────────────────────────────
  test('authenticated user can fetch /me', async ({ request }) => {
    const res = await request.get('/api/auth/me', {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user).toBeTruthy();
    expect(body.user.roles).toContain('shopper');
  });

  // ── Token refresh ──────────────────────────────────────────────
  test('can refresh tokens', async ({ request }) => {
    // First get a refresh token
    const loginRes = await request.post('/api/auth/login', {
      data: {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      },
    });
    const { tokens } = await loginRes.json();

    const res = await request.post('/api/auth/refresh', {
      data: { refreshToken: tokens.refreshToken },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.tokens?.accessToken).toBeTruthy();
  });

  // ── Profile update ─────────────────────────────────────────────
  test('user can update their profile', async ({ request }) => {
    const res = await request.patch('/api/auth/profile', {
      headers: authHeaders(shopperToken),
      data: { name: `E2E Shopper ${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Register validation ────────────────────────────────────────
  test('register rejects missing fields', async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      data: {},
    });
    expect([400, 422]).toContain(res.status());
  });

  test('register rejects duplicate mobile', async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      data: {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: 'SomePassword_123!',
        name: 'Duplicate Test',
        mediatorCode: 'AG_TEST',
      },
    });
    // Should reject because the mobile already exists
    expect([400, 409, 422]).toContain(res.status());
  });

  // ── Login validation ───────────────────────────────────────────
  test('login rejects wrong password', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: 'WrongPassword_999!',
      },
    });
    expect([400, 401]).toContain(res.status());
  });

  // ── Unauthenticated /me ────────────────────────────────────────
  test('unauthenticated /me returns 401', async ({ request }) => {
    const res = await request.get('/api/auth/me');
    expect([401, 403]).toContain(res.status());
  });

  // ── Admin login via username ───────────────────────────────────
  test('admin can login with username', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: {
        username: E2E_ACCOUNTS.admin.username,
        password: E2E_ACCOUNTS.admin.password,
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.roles).toContain('admin');
  });

  // ── Brand registration flow ────────────────────────────────────
  test('register-brand rejects without invite code', async ({ request }) => {
    const res = await request.post('/api/auth/register-brand', {
      data: {
        mobile: '9999999999',
        password: 'BrandTest_123!',
        name: 'E2E Brand Test',
      },
    });
    // Should require invite or reject the registration
    expect([400, 403, 422]).toContain(res.status());
  });
});
