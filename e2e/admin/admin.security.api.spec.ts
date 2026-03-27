import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Admin API security', () => {
  let adminToken: string;
  let buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginAndGetAccessToken(request, {
      username: E2E_ACCOUNTS.admin.username,
      password: E2E_ACCOUNTS.admin.password,
    });
    adminToken = admin.accessToken;

    const buyer = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    buyerToken = buyer.accessToken;
  });

  test('admin can access admin dashboard stats', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer cannot access admin endpoints', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('unauthenticated request is rejected', async ({ request }) => {
    const res = await request.get('/api/admin/financials');
    expect(res.status()).toBe(401);
  });

  test('expired/invalid token is rejected', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders('invalid.jwt.token'),
    });
    expect(res.status()).toBe(401);
  });

  test('admin can list users', async ({ request }) => {
    const res = await request.get('/api/admin/users', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data ?? body).toEqual(expect.arrayContaining([]));
  });

  test('admin can view audit logs', async ({ request }) => {
    const res = await request.get('/api/admin/audit-log', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('admin can list all tickets', async ({ request }) => {
    const res = await request.get('/api/tickets', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });
});
