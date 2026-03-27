import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Agency API security', () => {
  let agencyToken: string;
  let buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const agency = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.agency.mobile,
      password: E2E_ACCOUNTS.agency.password,
    });
    agencyToken = agency.accessToken;

    const buyer = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    buyerToken = buyer.accessToken;
  });

  test('agency can view their profile', async ({ request }) => {
    const res = await request.get('/api/auth/me', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.roles).toContain('agency');
  });

  test('agency can list notifications', async ({ request }) => {
    const res = await request.get('/api/notifications', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency cannot access admin endpoints', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(agencyToken),
    });
    expect(res.status()).toBe(403);
  });

  test('buyer cannot impersonate agency role', async ({ request }) => {
    // Agency inventory page should reject buyer
    const res = await request.get('/api/brand/agencies', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('unauthenticated request is rejected', async ({ request }) => {
    const res = await request.get('/api/auth/me');
    expect(res.status()).toBe(401);
  });
});
