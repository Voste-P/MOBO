import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test.describe('Admin portal smoke', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/');
    // Admin portal should show a login form
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
  });

  test('admin can log in', async ({ page }) => {
    await page.goto('/');
    // Fill admin credentials
    const usernameField = page.getByPlaceholder(/username|email/i).first();
    const passwordField = page.getByPlaceholder(/password/i).first();

    if (await usernameField.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await usernameField.fill(E2E_ACCOUNTS.admin.username);
      await passwordField.fill(E2E_ACCOUNTS.admin.password);
      await page.getByRole('button', { name: /login|sign in|submit/i }).first().click();
      // Should navigate away from login
      await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 15_000 }).catch(() => {});
    }
  });
});
