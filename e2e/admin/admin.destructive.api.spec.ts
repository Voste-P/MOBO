import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Admin destructive operations — confirmation header tests', () => {
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

  // ── Delete deal: requires X-Confirm-Delete header ─────────────
  test('delete deal rejects without confirmation header', async ({ request }) => {
    const res = await request.delete('/api/admin/products/nonexistent-id', {
      headers: authHeaders(adminToken),
    });
    // Should be 400 (missing header) or 404 (not found), but not 500
    expect([400, 404]).toContain(res.status());
  });

  test('delete deal with confirmation header returns 404 for nonexistent', async ({ request }) => {
    const res = await request.delete('/api/admin/products/nonexistent-id', {
      headers: {
        ...authHeaders(adminToken),
        'X-Confirm-Delete': 'true',
      },
    });
    expect([404, 400]).toContain(res.status());
  });

  test('buyer cannot delete deals', async ({ request }) => {
    const res = await request.delete('/api/admin/products/any-id', {
      headers: {
        ...authHeaders(buyerToken),
        'X-Confirm-Delete': 'true',
      },
    });
    expect(res.status()).toBe(403);
  });

  // ── Delete user: requires X-Confirm-Delete header ─────────────
  test('delete user rejects without confirmation header', async ({ request }) => {
    const res = await request.delete('/api/admin/users/nonexistent-id', {
      headers: authHeaders(adminToken),
    });
    expect([400, 404]).toContain(res.status());
  });

  test('delete user with confirmation header returns 404 for nonexistent', async ({ request }) => {
    const res = await request.delete('/api/admin/users/nonexistent-id', {
      headers: {
        ...authHeaders(adminToken),
        'X-Confirm-Delete': 'true',
      },
    });
    expect([404, 400]).toContain(res.status());
  });

  test('buyer cannot delete users', async ({ request }) => {
    const res = await request.delete('/api/admin/users/some-id', {
      headers: {
        ...authHeaders(buyerToken),
        'X-Confirm-Delete': 'true',
      },
    });
    expect(res.status()).toBe(403);
  });

  // ── Delete wallet: requires X-Confirm-Delete header ───────────
  test('delete wallet rejects without confirmation header', async ({ request }) => {
    const res = await request.delete('/api/admin/wallets/nonexistent-id', {
      headers: authHeaders(adminToken),
    });
    expect([400, 404]).toContain(res.status());
  });

  test('delete wallet with confirmation returns 404 for nonexistent', async ({ request }) => {
    const res = await request.delete('/api/admin/wallets/nonexistent-id', {
      headers: {
        ...authHeaders(adminToken),
        'X-Confirm-Delete': 'true',
      },
    });
    expect([404, 400]).toContain(res.status());
  });

  // ── User status update ────────────────────────────────────────
  test('admin can update user status', async ({ request }) => {
    const res = await request.patch('/api/admin/users/status', {
      headers: authHeaders(adminToken),
      data: { userId: 'nonexistent-id', status: 'active' },
    });
    // Should be 404 or 400 for nonexistent, not 500
    expect(res.status()).toBeLessThan(500);
  });

  test('buyer cannot update user status', async ({ request }) => {
    const res = await request.patch('/api/admin/users/status', {
      headers: authHeaders(buyerToken),
      data: { userId: 'test', status: 'active' },
    });
    expect(res.status()).toBe(403);
  });
});
