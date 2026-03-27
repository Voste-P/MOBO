import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test.describe.configure({ retries: 2 });

test('brand can open Order Intelligence', async ({ page, request }) => {
  test.setTimeout(360_000);

  const loginRes = await request.post('/api/auth/login', {
    data: { mobile: E2E_ACCOUNTS.brand.mobile, password: E2E_ACCOUNTS.brand.password },
  });
  expect(loginRes.ok()).toBeTruthy();
  const payload = await loginRes.json();
  const user = payload?.user;
  const tokens = payload?.tokens;
  expect(user).toBeTruthy();
  expect(tokens?.accessToken).toBeTruthy();

  await page.addInitScript(({ user, tokens }) => {
    localStorage.setItem('mobo_session', JSON.stringify(user));
    localStorage.setItem('mobo_tokens_v1', JSON.stringify(tokens));
  }, { user, tokens });

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.getByRole('button', { name: 'Order Intelligence' }).waitFor({ timeout: 120_000 });

  await page.getByRole('button', { name: 'Order Intelligence' }).click();
  await expect(page.getByRole('heading', { name: 'Order Intelligence' })).toBeVisible();
  await expect(page.getByPlaceholder('Search Orders...')).toBeVisible();
});
