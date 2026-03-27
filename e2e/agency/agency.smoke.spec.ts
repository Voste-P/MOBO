import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test('agency can login and view Team', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Splash -> Login
  const enterPortal = page.getByRole('button', { name: /Enter Portal/i });
  await expect(enterPortal).toBeVisible({ timeout: 15000 });

  // Next.js client hydration can make the first click a no-op; retry until the form is visible.
  await enterPortal.click();
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

  // Landing assertions (avoid brittle header text; wait for stable navigation)
  await expect(page.getByRole('button', { name: 'My Team' })).toBeVisible({ timeout: 15000 });

  // Navigate one core section
  await page.getByRole('button', { name: 'My Team' }).click();
  await expect(page.getByRole('button', { name: /Active Roster/i })).toBeVisible();

  // Connection flow entrypoint should be functional (real API call).
  await page.getByRole('button', { name: 'Connect Brands' }).click();
  await expect(page.getByRole('heading', { name: 'Connect Brand' })).toBeVisible();
  await page.getByPlaceholder('BRD_XXXX').fill('BRD_TEST');
  await page.getByRole('button', { name: /Send Connection Request/i }).click();
  await expect(page.getByText(/Request sent to Brand BRD_TEST\.|Already connected or already pending for BRD_TEST\./i)).toBeVisible({ timeout: 15000 });
});
