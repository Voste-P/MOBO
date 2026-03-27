import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('buyer can submit a cashback claim (creates an order)', async ({ page }) => {
  page.once('dialog', (dialog) => {
    // Dialogs can appear late (e.g., during navigation/teardown).
    // Accept best-effort and swallow any "Test ended" / closed-page errors.
    try {
      dialog.accept().catch(() => undefined);
    } catch {
      // ignore
    }
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Get Started' }).click();

  await page.getByPlaceholder('Mobile Number').fill(E2E_ACCOUNTS.shopper.mobile);
  await page.getByPlaceholder('Password').fill(E2E_ACCOUNTS.shopper.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Go to Orders
  await page.getByRole('button', { name: 'Orders' }).click();
  await expect(page.getByRole('heading', { name: 'My Orders' })).toBeVisible();

  // Open claim modal
  await page.getByRole('button', { name: 'New order' }).click();
  await expect(page.getByRole('heading', { name: 'Claim Cashback' })).toBeVisible();

  // Wait for the claim modal/sheet to appear
  const claimModal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Claim Cashback' });
  await expect(claimModal).toBeVisible();

  // Select the seeded deal (Discount tab is default)
  // We rely on seed title containing "E2E".
  await claimModal.getByText('E2E', { exact: false }).first().click();

  // Upload proof
  const proofPath = path.resolve(__dirname, '..', 'fixtures', 'proof.png');
  const fileInput = page.locator('input[type="file"][accept="image/*"]');
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles(proofPath);

  // The proof fixture is a generic SVG — AI extraction won't find a real order
  // ID or amount.  Fill the manual fields that appear after upload so Submit
  // Claim becomes enabled.
  const orderIdInput = claimModal.locator('input[placeholder="e.g. 404-..."]');
  await expect(orderIdInput).toBeVisible({ timeout: 30_000 });
  await orderIdInput.fill('E2E-ORDER-1234');

  const amountInput = claimModal.locator('input[placeholder="e.g. 1299"]');
  await amountInput.fill('999');

  // Submit claim
  const submit = page.getByRole('button', { name: 'Submit Claim' });
  await expect(submit).toBeEnabled({ timeout: 10_000 });
  await submit.click();

  await expect(claimModal).toBeHidden({ timeout: 30_000 });

  await page.reload({ waitUntil: 'domcontentloaded' });

  // Order list should no longer be empty.
  await expect(page.getByText('No orders yet', { exact: false })).toHaveCount(0, { timeout: 60_000 });
});
