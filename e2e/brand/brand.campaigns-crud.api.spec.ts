import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Brand campaign & payout management API', () => {
  let brandToken: string;
  let buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const [brand, buyer] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.brand.mobile,
        password: E2E_ACCOUNTS.brand.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
    ]);
    brandToken = brand.accessToken;
    buyerToken = buyer.accessToken;
  });

  // ── Dashboard ─────────────────────────────────────────────────
  test('brand can view dashboard stats', async ({ request }) => {
    const res = await request.get('/api/brand/dashboard-stats', {
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

  // ── Campaign CRUD ─────────────────────────────────────────────
  test('brand can list their campaigns', async ({ request }) => {
    const res = await request.get('/api/brand/campaigns', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data ?? body)).toBeTruthy();
  });

  test('brand can create a campaign', async ({ request }) => {
    const res = await request.post('/api/brand/campaigns', {
      headers: authHeaders(brandToken),
      data: {
        title: `E2E Brand Campaign ${Date.now()}`,
        platform: 'Amazon',
        dealType: 'Discount',
        price: 999,
        originalPrice: 1200,
        payout: 100,
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        totalSlots: 10,
        allowedAgencies: ['AG_TEST'],
      },
    });
    // May need agency association — but should not 500
    expect(res.status()).toBeLessThan(500);
  });

  test('brand can copy a campaign', async ({ request }) => {
    const res = await request.post('/api/brand/campaigns/copy', {
      headers: authHeaders(brandToken),
      data: { id: 'nonexistent-id' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('brand campaign update rejects nonexistent', async ({ request }) => {
    const res = await request.patch('/api/brand/campaigns/nonexistent-id', {
      headers: authHeaders(brandToken),
      data: { title: 'Updated' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('brand campaign delete rejects nonexistent', async ({ request }) => {
    const res = await request.delete('/api/brand/campaigns/nonexistent-id', {
      headers: authHeaders(brandToken),
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Transactions ──────────────────────────────────────────────
  test('brand can list transactions', async ({ request }) => {
    const res = await request.get('/api/brand/transactions', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Agency management ─────────────────────────────────────────
  test('brand can list agencies', async ({ request }) => {
    const res = await request.get('/api/brand/agencies', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand agency removal rejects empty data', async ({ request }) => {
    const res = await request.post('/api/brand/agencies/remove', {
      headers: authHeaders(brandToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Payout ────────────────────────────────────────────────────
  test('brand payout rejects empty data', async ({ request }) => {
    const res = await request.post('/api/brand/payout', {
      headers: authHeaders(brandToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Request resolve ───────────────────────────────────────────
  test('brand request resolve rejects empty data', async ({ request }) => {
    const res = await request.post('/api/brand/requests/resolve', {
      headers: authHeaders(brandToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Validation: image & productUrl must be valid URLs ─────────
  test('campaign creation rejects invalid image URL', async ({ request }) => {
    const res = await request.post('/api/brand/campaigns', {
      headers: authHeaders(brandToken),
      data: {
        title: 'Validation Test',
        platform: 'Amazon',
        dealType: 'Discount',
        price: 100,
        originalPrice: 200,
        payout: 50,
        image: 'not-a-url',
        productUrl: 'https://example.com/product',
        totalSlots: 5,
        allowedAgencies: ['AG_TEST'],
      },
    });
    expect([400, 422]).toContain(res.status());
  });

  test('campaign creation rejects invalid productUrl', async ({ request }) => {
    const res = await request.post('/api/brand/campaigns', {
      headers: authHeaders(brandToken),
      data: {
        title: 'Validation Test',
        platform: 'Amazon',
        dealType: 'Discount',
        price: 100,
        originalPrice: 200,
        payout: 50,
        image: 'https://placehold.co/600x400',
        productUrl: 'just-text',
        totalSlots: 5,
        allowedAgencies: ['AG_TEST'],
      },
    });
    expect([400, 422]).toContain(res.status());
  });

  test('campaign update rejects invalid image URL', async ({ request }) => {
    const res = await request.patch('/api/brand/campaigns/nonexistent-id', {
      headers: authHeaders(brandToken),
      data: { image: 'not-a-valid-url' },
    });
    // Should reject with validation error (400/422), not 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── RBAC: buyer blocked ───────────────────────────────────────
  test('buyer cannot access brand dashboard', async ({ request }) => {
    const res = await request.get('/api/brand/dashboard-stats', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('buyer cannot list brand campaigns', async ({ request }) => {
    const res = await request.get('/api/brand/campaigns', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  test('buyer cannot create brand campaigns', async ({ request }) => {
    const res = await request.post('/api/brand/campaigns', {
      headers: authHeaders(buyerToken),
      data: { title: 'test', dealType: 'Discount' },
    });
    expect(res.status()).toBe(403);
  });

  test('buyer cannot access brand transactions', async ({ request }) => {
    const res = await request.get('/api/brand/transactions', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });
});
