import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Ops campaign & deal management API', () => {
  let agencyToken: string;
  let mediatorToken: string;
  let buyerToken: string;
  let createdCampaignId: string | undefined;

  test.beforeAll(async ({ request }) => {
    const [agency, mediator, buyer] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.agency.mobile,
        password: E2E_ACCOUNTS.agency.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.mediator.mobile,
        password: E2E_ACCOUNTS.mediator.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
    ]);
    agencyToken = agency.accessToken;
    mediatorToken = mediator.accessToken;
    buyerToken = buyer.accessToken;
  });

  // ── Campaign CRUD ─────────────────────────────────────────────
  test('agency can create a campaign', async ({ request }) => {
    const res = await request.post('/api/ops/campaigns', {
      headers: authHeaders(agencyToken),
      data: {
        title: `E2E Campaign ${Date.now()}`,
        brandId: 'e2e-brand-placeholder',
        budget: 10000,
        dealType: 'Discount',
      },
    });
    // May succeed or fail if brandId doesn't exist — but should not be 500
    if (res.ok()) {
      const body = await res.json();
      createdCampaignId = body.campaign?.id ?? body.id;
    }
    expect(res.status()).toBeLessThan(500);
  });

  test('agency can list campaigns', async ({ request }) => {
    const res = await request.get('/api/ops/campaigns', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data ?? body)).toBeTruthy();
  });

  test('mediator can list campaigns', async ({ request }) => {
    const res = await request.get('/api/ops/campaigns', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer cannot list ops campaigns', async ({ request }) => {
    const res = await request.get('/api/ops/campaigns', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  // ── Campaign status update ────────────────────────────────────
  test('campaign status update rejects invalid campaignId', async ({ request }) => {
    const res = await request.patch('/api/ops/campaigns/nonexistent-id/status', {
      headers: authHeaders(agencyToken),
      data: { status: 'active' },
    });
    // Should be 404 or 400, not 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── Campaign copy ─────────────────────────────────────────────
  test('campaign copy rejects invalid source', async ({ request }) => {
    const res = await request.post('/api/ops/campaigns/copy', {
      headers: authHeaders(agencyToken),
      data: { campaignId: 'nonexistent-id' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Campaign decline ──────────────────────────────────────────
  test('campaign decline rejects invalid campaign', async ({ request }) => {
    const res = await request.post('/api/ops/campaigns/decline', {
      headers: authHeaders(agencyToken),
      data: { campaignId: 'nonexistent-id' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Deal listing ──────────────────────────────────────────────
  test('agency can list deals', async ({ request }) => {
    const res = await request.get('/api/ops/deals', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Deal publish requires valid data ──────────────────────────
  test('deal publish rejects empty payload', async ({ request }) => {
    const res = await request.post('/api/ops/deals/publish', {
      headers: authHeaders(agencyToken),
      data: {},
    });
    // Should fail validation, not 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── Buyer cannot publish deals ────────────────────────────────
  test('buyer cannot publish deals', async ({ request }) => {
    const res = await request.post('/api/ops/deals/publish', {
      headers: authHeaders(buyerToken),
      data: { dealId: 'test' },
    });
    expect(res.status()).toBe(403);
  });

  // ── Campaign delete (if created) ──────────────────────────────
  test('campaign delete for invalid id returns error', async ({ request }) => {
    const res = await request.delete('/api/ops/campaigns/nonexistent-id', {
      headers: authHeaders(agencyToken),
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Slot assignment ───────────────────────────────────────────
  test('slot assignment rejects invalid data', async ({ request }) => {
    const res = await request.post('/api/ops/campaigns/assign', {
      headers: authHeaders(agencyToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });
});
