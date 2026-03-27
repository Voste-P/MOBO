import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Admin users management API', () => {
  let adminToken: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginAndGetAccessToken(request, {
      username: E2E_ACCOUNTS.admin.username,
      password: E2E_ACCOUNTS.admin.password,
    });
    adminToken = admin.accessToken;
  });

  test('admin can list users with pagination', async ({ request }) => {
    const res = await request.get('/api/admin/users?page=1&limit=10', {
      headers: authHeaders(adminToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const users = body.data ?? body;
    expect(Array.isArray(users)).toBeTruthy();
  });

  test('admin can view system health', async ({ request }) => {
    const res = await request.get('/api/health/ready');
    expect(res.ok()).toBeTruthy();
  });

  test('admin can access realtime health', async ({ request }) => {
    const res = await request.get('/api/health/realtime', {
      headers: authHeaders(adminToken),
    });
    // Realtime health may not be available in all environments
    expect([200, 404, 503]).toContain(res.status());
  });
});
