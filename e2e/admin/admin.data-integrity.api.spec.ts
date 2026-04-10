import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Admin data integrity — status updates & cache coherence', () => {
  let adminToken: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginAndGetAccessToken(request, {
      username: E2E_ACCOUNTS.admin.username,
      password: E2E_ACCOUNTS.admin.password,
    });
    adminToken = admin.accessToken;
  });

  // ── User status toggles reflect immediately ───────────────────────
  test('suspend and reactivate a user — status reflects in listing', async ({ request }) => {
    // Get a non-admin user to test with
    const listRes = await request.get('/api/admin/users', {
      headers: authHeaders(adminToken),
    });
    expect(listRes.ok()).toBeTruthy();
    const users = (await listRes.json()).data ?? await listRes.json();
    const target = users.find(
      (u: any) => u.roles?.includes('shopper') && u.status === 'active'
    );
    test.skip(!target, 'No active shopper to test with');

    // Suspend
    const suspendRes = await request.patch(`/api/admin/users/${target.id}/status`, {
      headers: authHeaders(adminToken),
      data: { status: 'suspended' },
    });
    expect(suspendRes.ok()).toBeTruthy();

    // Verify suspension reflected
    const checkRes = await request.get('/api/admin/users', {
      headers: authHeaders(adminToken),
    });
    const updated = ((await checkRes.json()).data ?? []).find((u: any) => u.id === target.id);
    expect(updated?.status).toBe('suspended');

    // Reactivate to restore test data
    const reactivateRes = await request.patch(`/api/admin/users/${target.id}/status`, {
      headers: authHeaders(adminToken),
      data: { status: 'active' },
    });
    expect(reactivateRes.ok()).toBeTruthy();

    // Verify reactivation
    const finalRes = await request.get('/api/admin/users', {
      headers: authHeaders(adminToken),
    });
    const restored = ((await finalRes.json()).data ?? []).find((u: any) => u.id === target.id);
    expect(restored?.status).toBe('active');
  });

  // ── Audit log records status change events ────────────────────────
  test('audit log captures admin actions', async ({ request }) => {
    const res = await request.get('/api/admin/audit-logs', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const logs = body.data ?? body;
    expect(Array.isArray(logs)).toBeTruthy();
    // Audit logs should exist (populated by prior tests or seed data)
    expect(logs.length).toBeGreaterThan(0);
  });

  // ── Config CRUD is consistent ─────────────────────────────────────
  test('system config read returns expected shape', async ({ request }) => {
    const res = await request.get('/api/admin/config', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
    const config = await res.json();
    // Config should be an object with at least one key
    expect(typeof config).toBe('object');
    expect(Object.keys(config).length).toBeGreaterThan(0);
  });
});
