import { expect, test } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';
import { loginAndGetAccessToken } from '../helpers/auth';

test('buyer cannot access admin stats', async ({ request }) => {
  const { accessToken } = await loginAndGetAccessToken(request, E2E_ACCOUNTS.shopper);

  const res = await request.get('/api/admin/stats', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect([401, 403]).toContain(res.status());
});

test('buyer can list products', async ({ request }) => {
  const { accessToken } = await loginAndGetAccessToken(request, E2E_ACCOUNTS.shopper);

  const res = await request.get('/api/products', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect(res.ok()).toBeTruthy();
  const payload = await res.json();
  expect(Array.isArray(payload)).toBeTruthy();
});
