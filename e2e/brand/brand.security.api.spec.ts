import { expect, test } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';
import { loginAndGetAccessToken } from '../helpers/auth';

test('brand can read its own transactions', async ({ request }) => {
  const { accessToken, user } = await loginAndGetAccessToken(request, E2E_ACCOUNTS.brand);
  const brandId = user?.id;
  expect(typeof brandId).toBe('string');

  const res = await request.get(`/api/brand/transactions?brandId=${encodeURIComponent(String(brandId))}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect(res.ok()).toBeTruthy();
  const payload = await res.json();
  expect(Array.isArray(payload)).toBeTruthy();
});
