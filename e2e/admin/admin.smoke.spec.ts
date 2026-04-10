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
    // Admin portal uses placeholder="root" for username and "••••••••" for password
    const usernameField = page.getByPlaceholder('root').first();
    const passwordField = page.getByLabel(/security key/i).first();

    await expect(usernameField).toBeVisible({ timeout: 10_000 });
    await usernameField.fill(E2E_ACCOUNTS.admin.username);
    await passwordField.fill(E2E_ACCOUNTS.admin.password);
    await page.getByRole('button', { name: /enter|sign in|submit/i }).first().click();
    // Should navigate away from login
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 15_000 });
  });
});
