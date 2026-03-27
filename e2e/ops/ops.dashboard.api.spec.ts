import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Ops dashboard API', () => {
  let agencyToken: string;
  let mediatorToken: string;
  let shopperToken: string;

  test.beforeAll(async ({ request }) => {
    const [agency, mediator, shopper] = await Promise.all([
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
    shopperToken = shopper.accessToken;
  });

  // ── Dashboard read endpoints (agency) ──────────────────────────
  test('agency can view dashboard stats', async ({ request }) => {
    const res = await request.get('/api/ops/dashboard-stats', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can view revenue trend', async ({ request }) => {
    const res = await request.get('/api/ops/revenue-trend', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can view brand performance', async ({ request }) => {
    const res = await request.get('/api/ops/brand-performance', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list mediators', async ({ request }) => {
    const res = await request.get('/api/ops/mediators', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list campaigns', async ({ request }) => {
    const res = await request.get('/api/ops/campaigns', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list deals', async ({ request }) => {
    const res = await request.get('/api/ops/deals', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list orders', async ({ request }) => {
    const res = await request.get('/api/ops/orders', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can view pending users', async ({ request }) => {
    const res = await request.get('/api/ops/users/pending', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can view verified users', async ({ request }) => {
    const res = await request.get('/api/ops/users/verified', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can view ledger', async ({ request }) => {
    const res = await request.get('/api/ops/ledger', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Dashboard read endpoints (mediator) ────────────────────────
  test('mediator can view dashboard stats', async ({ request }) => {
    const res = await request.get('/api/ops/dashboard-stats', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('mediator can view revenue trend', async ({ request }) => {
    const res = await request.get('/api/ops/revenue-trend', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('mediator can list campaigns', async ({ request }) => {
    const res = await request.get('/api/ops/campaigns', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── RBAC: shopper cannot access ops endpoints ──────────────────
  test('shopper cannot view ops dashboard stats', async ({ request }) => {
    const res = await request.get('/api/ops/dashboard-stats', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });

  test('shopper cannot view ops orders', async ({ request }) => {
    const res = await request.get('/api/ops/orders', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });

  test('shopper cannot view ops ledger', async ({ request }) => {
    const res = await request.get('/api/ops/ledger', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });

  test('shopper cannot view ops mediators', async ({ request }) => {
    const res = await request.get('/api/ops/mediators', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });
});
