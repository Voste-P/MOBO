import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Buyer order creation flow', () => {
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

  test('buyer can list available products', async ({ request }) => {
    const res = await request.get('/api/products', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const deals = body.data ?? body;
    expect(Array.isArray(deals)).toBeTruthy();
  });

  test('product image field is a valid URL or empty string (no SVG placeholder)', async ({ request }) => {
    const res = await request.get('/api/products', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const deals = body.data ?? body;
    if (Array.isArray(deals) && deals.length > 0) {
      for (const deal of deals) {
        if (deal.image) {
          // Image should be a valid URL, not a data:image/svg+xml placeholder
          expect(deal.image).not.toContain('data:image/svg+xml');
          expect(typeof deal.image).toBe('string');
        }
      }
    }
  });

  test('buyer can paginate products', async ({ request }) => {
    const res = await request.get('/api/products?page=1&limit=5', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    if (body.pagination) {
      expect(body.pagination.limit).toBeLessThanOrEqual(5);
    }
  });

  test('buyer can view their order history', async ({ request }) => {
    const res = await request.get(`/api/orders/user/${buyerUser.id}`, {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
    const orders = await res.json();
    expect(Array.isArray(orders.data ?? orders)).toBeTruthy();
  });

  test('order creation requires auth', async ({ request }) => {
    const res = await request.post('/api/orders', {
      data: { userId: 'fake', items: [] },
    });
    expect(res.status()).toBe(401);
  });
});
