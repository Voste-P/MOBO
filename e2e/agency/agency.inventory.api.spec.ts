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
    expect(body.user.roles).toContain('agency');
  });

  test('agency can create a support ticket', async ({ request }) => {
    const res = await request.post('/api/tickets', {
      headers: authHeaders(agencyToken),
      data: {
        issueType: 'Technical Issue',
        description: `E2E test ticket from agency ${Date.now()}`,
      },
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
