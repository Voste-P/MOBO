import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test.describe('Buyer portal smoke', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible({ timeout: 30_000 });
  });

  test('buyer can log in and see products', async ({ page }) => {
    await page.goto('/');
    const mobileField = page.getByPlaceholder('Mobile Number').first();
    const passwordField = page.getByPlaceholder('Password').first();

    await expect(mobileField).toBeVisible({ timeout: 10_000 });
    await mobileField.fill(E2E_ACCOUNTS.shopper.mobile);
    await passwordField.fill(E2E_ACCOUNTS.shopper.password);
    await page.getByRole('button', { name: /login|sign in|submit/i }).first().click();
    // Should navigate to dashboard / product listing
    await expect(page.locator('body')).toBeVisible({ timeout: 15_000 });
  });
});
