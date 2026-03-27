import { expect, test } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';
import { loginAndGetAccessToken } from '../helpers/auth';

test('admin can read admin stats', async ({ request }) => {
  const { accessToken } = await loginAndGetAccessToken(request, E2E_ACCOUNTS.admin);

  const res = await request.get('/api/admin/stats', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect(res.ok()).toBeTruthy();
  const payload = await res.json();
  expect(payload).toBeTruthy();
});
