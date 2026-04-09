import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Comprehensive cross-role RBAC tests.
 * Verifies that each role can ONLY access their authorized endpoints.
 */
test.describe('Cross-role RBAC enforcement', () => {
  let adminToken: string;
  let agencyToken: string;
  let mediatorToken: string;
  let brandToken: string;
  let buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const [admin, agency, mediator, brand, buyer] = await Promise.all([
      loginAndGetAccessToken(request, {
        username: E2E_ACCOUNTS.admin.username,
        password: E2E_ACCOUNTS.admin.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.agency.mobile,
        password: E2E_ACCOUNTS.agency.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.mediator.mobile,
        password: E2E_ACCOUNTS.mediator.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.brand.mobile,
        password: E2E_ACCOUNTS.brand.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
    ]);
    adminToken = admin.accessToken;
    agencyToken = agency.accessToken;
    mediatorToken = mediator.accessToken;
    brandToken = brand.accessToken;
    buyerToken = buyer.accessToken;
  });

  // ── Admin endpoints: only admin ───────────────────────────────
  const adminEndpoints = [
    '/api/admin/users',
    '/api/admin/financials',
    '/api/admin/stats',
    '/api/admin/growth',
    '/api/admin/config',
    '/api/admin/invites',
    '/api/admin/audit-logs',
  ];

  for (const endpoint of adminEndpoints) {
    test(`buyer blocked from ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(buyerToken),
      });
      expect(res.status()).toBe(403);
    });

    test(`brand blocked from ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(brandToken),
      });
      expect(res.status()).toBe(403);
    });

    test(`mediator blocked from ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(mediatorToken),
      });
      expect(res.status()).toBe(403);
    });

    test(`agency blocked from ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(agencyToken),
      });
      expect(res.status()).toBe(403);
    });
  }

  // ── Ops endpoints: buyer blocked ──────────────────────────────
  const opsEndpoints = [
    '/api/ops/dashboard-stats',
    '/api/ops/orders',
    '/api/ops/mediators',
    '/api/ops/ledger',
    '/api/ops/campaigns',
    '/api/ops/deals',
  ];

  for (const endpoint of opsEndpoints) {
    test(`buyer blocked from ops: ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(buyerToken),
      });
      expect(res.status()).toBe(403);
    });

    test(`brand blocked from ops: ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(brandToken),
      });
      expect(res.status()).toBe(403);
    });
  }

  // ── Brand endpoints: buyer/mediator blocked ───────────────────
  const brandEndpoints = [
    '/api/brand/dashboard-stats',
    '/api/brand/campaigns',
    '/api/brand/orders',
    '/api/brand/transactions',
    '/api/brand/agencies',
  ];

  for (const endpoint of brandEndpoints) {
    test(`buyer blocked from brand: ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(buyerToken),
      });
      expect(res.status()).toBe(403);
    });

    test(`mediator blocked from brand: ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint, {
        headers: authHeaders(mediatorToken),
      });
      expect(res.status()).toBe(403);
    });
  }

  // ── Unauthenticated: all protected endpoints blocked ──────────
  const protectedEndpoints = [
    '/api/auth/me',
    '/api/orders/user/fake-id',
    '/api/ops/dashboard-stats',
    '/api/admin/users',
    '/api/brand/dashboard-stats',
    '/api/tickets',
    '/api/notifications',
  ];

  for (const endpoint of protectedEndpoints) {
    test(`unauthenticated blocked from ${endpoint}`, async ({ request }) => {
      const res = await request.get(endpoint);
      expect([401, 403]).toContain(res.status());
    });
  }

  // ── Product redirect: only shoppers ───────────────────────────
  test('buyer can access products', async ({ request }) => {
    const res = await request.get('/api/products', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── All roles can access their /me ────────────────────────────
  const roleTokenMap = () => [
    { role: 'admin', token: adminToken },
    { role: 'agency', token: agencyToken },
    { role: 'mediator', token: mediatorToken },
    { role: 'brand', token: brandToken },
    { role: 'buyer', token: buyerToken },
  ];

  for (const { role, token } of [
    { role: 'admin', token: '' },
    { role: 'agency', token: '' },
    { role: 'mediator', token: '' },
    { role: 'brand', token: '' },
    { role: 'buyer', token: '' },
  ]) {
    // These run afterAll tokens are populated — Playwright runs beforeAll first
    test(`${role} can access /me`, async ({ request }) => {
      const tokens = {
        admin: adminToken,
        agency: agencyToken,
        mediator: mediatorToken,
        brand: brandToken,
        buyer: buyerToken,
      };
      const res = await request.get('/api/auth/me', {
        headers: authHeaders(tokens[role as keyof typeof tokens]),
      });
      expect(res.ok()).toBeTruthy();
    });
  }
});
