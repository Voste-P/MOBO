import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test('brand can login and view Campaigns', async ({ page }) => {
  await page.goto('/');

  // Splash -> Login
  await page.getByRole('button', { name: /Access Portal/i }).click();

  await page.getByPlaceholder('9000000000').fill(E2E_ACCOUNTS.brand.mobile);
  await page.getByPlaceholder('Password').fill(E2E_ACCOUNTS.brand.password);
  await page.getByRole('button', { name: /Login to Portal/i }).click();

  // Landing assertions
  await expect(page.getByText('Partner Portal', { exact: true })).toBeVisible();

  // Navigate one core section
  await page.getByRole('button', { name: 'Campaigns' }).click();
  await expect(page.getByText('Active Campaigns')).toBeVisible();
});
