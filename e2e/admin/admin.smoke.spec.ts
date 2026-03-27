import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test('admin can authenticate and see sidebar', async ({ page }) => {
  await page.goto('/');

  await page.getByPlaceholder('root').fill(E2E_ACCOUNTS.admin.username);
  await page.getByRole('textbox', { name: 'Security Key' }).fill(E2E_ACCOUNTS.admin.password);
  await page.getByRole('button', { name: /Authenticate Session/i }).click();

  // Cold-start Next compilation can make the first post-login render slow.
  await expect(page.getByText(/Buzzma.*Admin/i)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible({ timeout: 45_000 });
});
