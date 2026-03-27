import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Mediator verification flow', () => {
  let mediatorToken: string;
  let adminToken: string;

  test.beforeAll(async ({ request }) => {
    const mediator = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.mediator.mobile,
      password: E2E_ACCOUNTS.mediator.password,
    });
    mediatorToken = mediator.accessToken;

    const admin = await loginAndGetAccessToken(request, {
      username: E2E_ACCOUNTS.admin.username,
      password: E2E_ACCOUNTS.admin.password,
    });
    adminToken = admin.accessToken;
  });

  test('mediator can list their team orders', async ({ request }) => {
    const res = await request.get('/api/auth/me', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('mediator can create a ticket', async ({ request }) => {
    const res = await request.post('/api/tickets', {
      headers: authHeaders(mediatorToken),
      data: {
        issueType: 'Commission Delay',
        description: `E2E test ticket from mediator ${Date.now()}`,
      },
    });
    expect(res.ok()).toBeTruthy();
  });
});
