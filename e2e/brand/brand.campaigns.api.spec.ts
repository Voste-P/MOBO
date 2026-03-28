import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Brand campaigns & dashboard API', () => {
  let brandToken: string;
  let shopperToken: string;

  test.beforeAll(async ({ request }) => {
    const [brand, shopper] = await Promise.all([
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
    shopperToken = shopper.accessToken;
  });

  // ── Dashboard read endpoints ───────────────────────────────────
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

  test('brand can view inventory fill', async ({ request }) => {
    const res = await request.get('/api/brand/inventory-fill', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand can list agencies', async ({ request }) => {
    const res = await request.get('/api/brand/agencies', {
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

  test('brand can list orders', async ({ request }) => {
    const res = await request.get('/api/brand/orders', {
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

  // ── Campaign CRUD ──────────────────────────────────────────────
  let createdCampaignId: string | undefined;

  test('brand can create a campaign', async ({ request }) => {
    const res = await request.post('/api/brand/campaigns', {
      headers: authHeaders(brandToken),
      data: {
        title: `E2E Campaign ${Date.now()}`,
        platform: 'Amazon',
        price: 999,
        originalPrice: 1200,
        payout: 100,
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        totalSlots: 10,
        allowedAgencies: ['AG_TEST'],
      },
    });
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    createdCampaignId = body.campaign?.id ?? body.id ?? body._id;
  });

  test('brand can update a campaign', async ({ request }) => {
    test.skip(!createdCampaignId, 'No campaign was created');
    const res = await request.patch(`/api/brand/campaigns/${createdCampaignId}`, {
      headers: authHeaders(brandToken),
      data: { title: `Updated E2E Campaign ${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand can delete a campaign', async ({ request }) => {
    test.skip(!createdCampaignId, 'No campaign was created');
    const res = await request.delete(`/api/brand/campaigns/${createdCampaignId}`, {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── RBAC: shopper cannot access brand endpoints ────────────────
  test('shopper cannot view brand dashboard', async ({ request }) => {
    const res = await request.get('/api/brand/dashboard-stats', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });

  test('shopper cannot list brand campaigns', async ({ request }) => {
    const res = await request.get('/api/brand/campaigns', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });

  test('shopper cannot view brand transactions', async ({ request }) => {
    const res = await request.get('/api/brand/transactions', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });
});
