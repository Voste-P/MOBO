import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Agency inventory & connections API', () => {
  let agencyToken: string;

  test.beforeAll(async ({ request }) => {
    const agency = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.agency.mobile,
      password: E2E_ACCOUNTS.agency.password,
    });
    agencyToken = agency.accessToken;
  });

  test('agency can view their profile', async ({ request }) => {
    const res = await request.get('/api/auth/me', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.role).toBe('agency');
  });

  test('agency can view ops dashboard stats', async ({ request }) => {
    const res = await request.get('/api/ops/dashboard-stats', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list ops campaigns', async ({ request }) => {
    const res = await request.get('/api/ops/campaigns', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list ops deals', async ({ request }) => {
    const res = await request.get('/api/ops/deals', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list ops orders', async ({ request }) => {
    const res = await request.get('/api/ops/orders', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can view ops ledger', async ({ request }) => {
    const res = await request.get('/api/ops/ledger', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('agency can list their tickets', async ({ request }) => {
    const res = await request.get('/api/tickets', {
      headers: authHeaders(agencyToken),
    });
    expect(res.ok()).toBeTruthy();
  });
});
