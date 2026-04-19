import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Wallet & financial operations', () => {
  let buyerToken: string;
  let adminToken: string;

  test.beforeAll(async ({ request }) => {
    const [buyer, admin] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
      loginAndGetAccessToken(request, {
        username: E2E_ACCOUNTS.admin.username,
        password: E2E_ACCOUNTS.admin.password,
      }),
    ]);
    buyerToken = buyer.accessToken;
    adminToken = admin.accessToken;
  });

  // ── Wallet balance accessible via /me ─────────────────────────
  test('buyer wallet balance is returned in /me', async ({ request }) => {
    const res = await request.get('/api/auth/me', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // /api/auth/me returns flat walletBalance (rupees) and walletPending (rupees)
    expect(body.user).toHaveProperty('walletBalance');
    expect(typeof body.user.walletBalance).toBe('number');
    expect(body.user.walletBalance).toBeGreaterThanOrEqual(0);
  });

  // ── Admin can view financial summary ──────────────────────────
  test('admin can view financials', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Admin can view stats ──────────────────────────────────────
  test('admin can view stats', async ({ request }) => {
    const res = await request.get('/api/admin/stats', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Admin can view growth metrics ─────────────────────────────
  test('admin can view growth metrics', async ({ request }) => {
    const res = await request.get('/api/admin/growth', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Buyer cannot access admin financials ──────────────────────
  test('buyer cannot access admin financials', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  // ── Ops ledger accessible by ops roles ────────────────────────
  test('ops ledger returns data for agency', async ({ request }) => {
    const agency = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.agency.mobile,
      password: E2E_ACCOUNTS.agency.password,
    });
    const res = await request.get('/api/ops/ledger', {
      headers: authHeaders(agency.accessToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Buyer cannot access ops ledger ────────────────────────────
  test('buyer cannot access ops ledger', async ({ request }) => {
    const res = await request.get('/api/ops/ledger', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });
});
