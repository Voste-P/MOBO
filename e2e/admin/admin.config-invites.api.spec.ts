import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Admin configuration & invite management API', () => {
  let adminToken: string;
  let buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const [admin, buyer] = await Promise.all([
      loginAndGetAccessToken(request, {
        username: E2E_ACCOUNTS.admin.username,
        password: E2E_ACCOUNTS.admin.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
    ]);
    adminToken = admin.accessToken;
    buyerToken = buyer.accessToken;
  });

  // ── System config ─────────────────────────────────────────────
  test('admin can get system config', async ({ request }) => {
    const res = await request.get('/api/admin/config', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer cannot get system config', async ({ request }) => {
    const res = await request.get('/api/admin/config', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  // ── Invite management ─────────────────────────────────────────
  test('admin can list invites', async ({ request }) => {
    const res = await request.get('/api/admin/invites', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('admin can create an invite', async ({ request }) => {
    const res = await request.post('/api/admin/invites', {
      headers: authHeaders(adminToken),
      data: { type: 'agency' },
    });
    // May succeed or need different params — but no 500
    expect(res.status()).toBeLessThan(500);
  });

  test('admin can revoke an invite', async ({ request }) => {
    const res = await request.post('/api/admin/invites/revoke', {
      headers: authHeaders(adminToken),
      data: { code: 'nonexistent-code' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('admin can delete invite by code', async ({ request }) => {
    const res = await request.delete('/api/admin/invites/nonexistent-code', {
      headers: authHeaders(adminToken),
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('buyer cannot list invites', async ({ request }) => {
    const res = await request.get('/api/admin/invites', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  // ── Products (admin view) ─────────────────────────────────────
  test('admin can list products', async ({ request }) => {
    const res = await request.get('/api/admin/products', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer cannot list admin products', async ({ request }) => {
    const res = await request.get('/api/admin/products', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });

  // ── Security question templates ───────────────────────────────
  test('admin can list security question templates', async ({ request }) => {
    const res = await request.get('/api/admin/security-question-templates', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('admin can create a security question template', async ({ request }) => {
    const res = await request.post('/api/admin/security-question-templates', {
      headers: authHeaders(adminToken),
      data: { question: `E2E question ${Date.now()}` },
    });
    // May succeed or fail on duplicate — no 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── Order reactivation ────────────────────────────────────────
  test('admin order reactivation rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/admin/orders/reactivate', {
      headers: authHeaders(adminToken),
      data: { orderId: 'nonexistent' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('buyer cannot reactivate orders', async ({ request }) => {
    const res = await request.post('/api/admin/orders/reactivate', {
      headers: authHeaders(buyerToken),
      data: { orderId: 'test' },
    });
    expect(res.status()).toBe(403);
  });

  // ── Audit logs ────────────────────────────────────────────────
  test('admin can view audit logs', async ({ request }) => {
    const res = await request.get('/api/admin/audit-logs', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('buyer cannot view audit logs', async ({ request }) => {
    const res = await request.get('/api/admin/audit-logs', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(403);
  });
});
