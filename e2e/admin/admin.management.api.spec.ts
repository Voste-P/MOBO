import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Admin management API', () => {
  let adminToken: string;
  let shopperToken: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginAndGetAccessToken(request, {
      username: E2E_ACCOUNTS.admin.username,
      password: E2E_ACCOUNTS.admin.password,
    });
    adminToken = admin.accessToken;

    const shopper = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    shopperToken = shopper.accessToken;
  });

  // ── System config ──────────────────────────────────────────────
  test('admin can read system config', async ({ request }) => {
    const res = await request.get('/api/admin/config', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Users ──────────────────────────────────────────────────────
  test('admin can list users', async ({ request }) => {
    const res = await request.get('/api/admin/users', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.users)).toBeTruthy();
  });

  // ── Financials ─────────────────────────────────────────────────
  test('admin can view financials', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Stats & growth ─────────────────────────────────────────────
  test('admin can view stats', async ({ request }) => {
    const res = await request.get('/api/admin/stats', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('admin can view growth', async ({ request }) => {
    const res = await request.get('/api/admin/growth', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Products ───────────────────────────────────────────────────
  test('admin can list products', async ({ request }) => {
    const res = await request.get('/api/admin/products', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Audit logs ─────────────────────────────────────────────────
  test('admin can view audit logs', async ({ request }) => {
    const res = await request.get('/api/admin/audit-logs', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Invites CRUD ───────────────────────────────────────────────
  let createdInviteCode: string | undefined;

  test('admin can list invites', async ({ request }) => {
    const res = await request.get('/api/admin/invites', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('admin can create an invite', async ({ request }) => {
    const res = await request.post('/api/admin/invites', {
      headers: authHeaders(adminToken),
      data: { role: 'agency', label: `E2E invite ${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    createdInviteCode = body.invite?.code ?? body.code;
  });

  test('admin can delete the created invite', async ({ request }) => {
    test.skip(!createdInviteCode, 'No invite was created');
    const res = await request.delete(`/api/admin/invites/${createdInviteCode}`, {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── RBAC: non-admin cannot access admin endpoints ──────────────
  test('shopper cannot access admin config', async ({ request }) => {
    const res = await request.get('/api/admin/config', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });

  test('shopper cannot list admin users', async ({ request }) => {
    const res = await request.get('/api/admin/users', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });

  test('shopper cannot view admin financials', async ({ request }) => {
    const res = await request.get('/api/admin/financials', {
      headers: authHeaders(shopperToken),
    });
    expect(res.status()).toBe(403);
  });
});
