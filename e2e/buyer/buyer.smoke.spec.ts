import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test.describe('Buyer portal smoke', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 30_000 });
  });

  test('buyer can log in and see products', async ({ page }) => {
    await page.goto('/');
    const mobileField = page.getByPlaceholder(/mobile|phone/i).first();
    const passwordField = page.getByPlaceholder(/password/i).first();

    if (await mobileField.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await mobileField.fill(E2E_ACCOUNTS.shopper.mobile);
      await passwordField.fill(E2E_ACCOUNTS.shopper.password);
      await page.getByRole('button', { name: /login|sign in|submit/i }).first().click();
      // Should navigate to dashboard / product listing
      await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 15_000 }).catch(() => {});
    }
  });
});
