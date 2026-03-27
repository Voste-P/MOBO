import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test('agency can open Inventory tab', async ({ page }) => {
  await page.goto('/');

  // Splash -> Login
  const enterPortal = page.getByRole('button', { name: /Enter Portal/i });
  await enterPortal.click();

  // Next.js client hydration can make the first click a no-op; retry until the form is visible.
  const mobileInput = page.locator('input[type="tel"]');
  try {
    await mobileInput.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    await enterPortal.click();
    await mobileInput.waitFor({ state: 'visible', timeout: 15000 });
  }

  await mobileInput.fill(E2E_ACCOUNTS.agency.mobile);
  await page.locator('input[type="password"]').fill(E2E_ACCOUNTS.agency.password);
  await page.getByRole('button', { name: /Login to Ops/i }).click();

  await page.getByRole('button', { name: 'Inventory' }).click();
  await expect(page.getByText('Offered by Brands', { exact: false })).toBeVisible();
});
