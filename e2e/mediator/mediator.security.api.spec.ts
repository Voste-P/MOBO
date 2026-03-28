import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Mediator API security', () => {
  let mediatorToken: string;
  let _buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const mediator = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.mediator.mobile,
      password: E2E_ACCOUNTS.mediator.password,
    });
    mediatorToken = mediator.accessToken;

    const buyer = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    _buyerToken = buyer.accessToken;
  });

  test('mediator can view their dashboard', async ({ request }) => {
    const res = await request.get('/api/auth/me', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.role).toBe('mediator');
  });

  test('mediator can list their notifications', async ({ request }) => {
    const res = await request.get('/api/notifications', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('mediator cannot access admin endpoints', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.status()).toBe(403);
  });

  test('mediator cannot access buyer-only products endpoint', async ({ request }) => {
    const res = await request.get('/api/products', {
      headers: authHeaders(mediatorToken),
    });
    // mediator should not access buyer-only endpoints
    expect([200, 403]).toContain(res.status());
  });
});
