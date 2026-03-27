import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Buyer API security', () => {
  let buyerToken: string;
  let buyerUser: any;

  test.beforeAll(async ({ request }) => {
    const buyer = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    buyerToken = buyer.accessToken;
    buyerUser = buyer.user;
  });

  test('buyer can view their profile', async ({ request }) => {
    const res = await request.get('/api/auth/me', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user).toBeTruthy();
    expect(body.user.id).toBe(buyerUser.id);
  });

  test('buyer can list products', async ({ request }) => {
    const res = await request.get('/api/products', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer can list their orders', async ({ request }) => {
    const res = await request.get(`/api/orders/user/${buyerUser.id}`, {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer can list their notifications', async ({ request }) => {
    const res = await request.get('/api/notifications', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer cannot access admin endpoints', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('buyer cannot access brand endpoints', async ({ request }) => {
    const res = await request.get('/api/brand/transactions', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('unauthenticated request is rejected', async ({ request }) => {
    const res = await request.get('/api/orders/user/fake-id');
    expect(res.status()).toBe(401);
  });

  test('buyer can create a support ticket', async ({ request }) => {
    const res = await request.post('/api/tickets', {
      headers: authHeaders(buyerToken),
      data: {
        issueType: 'Order Issue',
        description: `E2E test ticket ${Date.now()}`,
      },
    });
    expect(res.ok()).toBeTruthy();
  });
});
