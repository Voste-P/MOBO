import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test('mediator can login and open Market', async ({ page }) => {
  await page.goto('/');

  // Splash -> Login
  await page.getByRole('button', { name: /^Login$/ }).click();

  await page.getByPlaceholder('Mobile Number').fill(E2E_ACCOUNTS.mediator.mobile);
  await page.getByPlaceholder('Password').fill(E2E_ACCOUNTS.mediator.password);
  const loginResPromise = page.waitForResponse(
    (res) => res.url().includes('/api/auth/login') && res.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /^Login$/ }).click();
  const loginRes = await loginResPromise;
  expect(loginRes.ok(), `Login failed: ${loginRes.status()} ${loginRes.statusText()}`).toBeTruthy();

  // Landing assertions (avoid brittle user-name text; wait for a stable navigation entry)
  await expect(page.getByRole('button', { name: 'Market' })).toBeVisible({ timeout: 15000 });

  // Navigate one core section
  await page.getByRole('button', { name: 'Market' }).click();
  await expect(page.getByText('Inventory Deck')).toBeVisible();
});
