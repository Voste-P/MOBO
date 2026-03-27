import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Brand API security', () => {
  let brandToken: string;
  let buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const brand = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.brand.mobile,
      password: E2E_ACCOUNTS.brand.password,
    });
    brandToken = brand.accessToken;

    const buyer = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    buyerToken = buyer.accessToken;
  });

  test('brand can view dashboard stats', async ({ request }) => {
    const res = await request.get('/api/brand/dashboard-stats', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand can view transactions', async ({ request }) => {
    const res = await request.get('/api/brand/transactions', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand can list campaigns', async ({ request }) => {
    const res = await request.get('/api/brand/campaigns', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand can view revenue trend', async ({ request }) => {
    const res = await request.get('/api/brand/revenue-trend', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer cannot access brand endpoints', async ({ request }) => {
    const res = await request.get('/api/brand/dashboard-stats', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('unauthenticated request is rejected', async ({ request }) => {
    const res = await request.get('/api/brand/transactions');
    expect(res.status()).toBe(401);
  });
});
