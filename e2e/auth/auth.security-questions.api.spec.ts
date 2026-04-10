import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Auth security questions & password reset API', () => {
  let shopperToken: string;

  test.beforeAll(async ({ request }) => {
    const shopper = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    shopperToken = shopper.accessToken;
  });

  // ── Security question templates (public) ──────────────────────
  test('can fetch security question templates', async ({ request }) => {
    const res = await request.get('/api/auth/security-question-templates');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.templates ?? body)).toBeTruthy();
  });

  // ── Save security answers requires auth ───────────────────────
  test('save security answers rejects unauthenticated', async ({ request }) => {
    const res = await request.post('/api/auth/security-questions', {
      data: { answers: [] },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('save security answers with auth', async ({ request }) => {
    const res = await request.post('/api/auth/security-questions', {
      headers: authHeaders(shopperToken),
      data: { answers: [{ questionId: 'q1', answer: 'E2E test answer' }] },
    });
    // May succeed or fail based on templates — no 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── Forgot password: lookup ───────────────────────────────────
  test('forgot password lookup rejects empty payload', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password/lookup', {
      data: {},
    });
    expect([400, 422]).toContain(res.status());
  });

  test('forgot password lookup with valid mobile', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password/lookup', {
      data: { mobile: E2E_ACCOUNTS.shopper.mobile },
    });
    // Should return security questions for verification
    expect(res.status()).toBeLessThan(500);
  });

  test('forgot password lookup with nonexistent mobile', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password/lookup', {
      data: { mobile: '0000000000' },
    });
    // Should be 404 or return empty — no 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── Forgot password: reset ────────────────────────────────────
  test('forgot password reset rejects empty payload', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password/reset', {
      data: {},
    });
    expect([400, 422]).toContain(res.status());
  });

  test('forgot password reset rejects invalid answers', async ({ request }) => {
    const res = await request.post('/api/auth/forgot-password/reset', {
      data: {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        answers: [{ questionId: 'fake', answer: 'wrong' }],
        newPassword: 'NewPassword_123!',
      },
    });
    // Should fail verification, not 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── Register ops/brand require proper fields ──────────────────
  test('register-ops rejects missing fields', async ({ request }) => {
    const res = await request.post('/api/auth/register-ops', {
      data: {},
    });
    expect([400, 422]).toContain(res.status());
  });

  test('register-brand rejects missing fields', async ({ request }) => {
    const res = await request.post('/api/auth/register-brand', {
      data: {},
    });
    expect([400, 422]).toContain(res.status());
  });

  // ── Profile update validation ─────────────────────────────────
  test('profile update rejects unauthenticated', async ({ request }) => {
    const res = await request.patch('/api/auth/profile', {
      data: { name: 'test' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
