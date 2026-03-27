import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const BRAND_CODE = 'BRD_TEST';
const AGENCY_CODE = 'AG_TEST';

async function loginApi(request: APIRequestContext, mobile: string, password?: string) {
  const { accessToken, user } = await loginAndGetAccessToken(request, {
    mobile,
    password: password ?? E2E_ACCOUNTS.brand.password,
  });
  return { token: accessToken, user };
}

test('brand can see and approve an agency connection request', async ({ page, request }) => {
  // Ensure a clean slate (idempotent test).
  const brandAuth = await loginApi(request, E2E_ACCOUNTS.brand.mobile);

  const meRes = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${brandAuth.token}` },
  });
  expect(meRes.ok()).toBeTruthy();
  const meJson = (await meRes.json()) as any;
  const me = meJson?.user ?? meJson;
  const brandId = String(me?.id || '');
  expect(brandId).toBeTruthy();

  // If already connected, remove so we can exercise the full request/approve flow.
  if (Array.isArray(me?.connectedAgencies) && me.connectedAgencies.includes(AGENCY_CODE)) {
    const removeRes = await request.post('/api/brand/agencies/remove', {
      headers: { Authorization: `Bearer ${brandAuth.token}` },
      data: { brandId, agencyCode: AGENCY_CODE },
    });
    expect(removeRes.ok()).toBeTruthy();
  }

  // Reject ALL existing pending connections to ensure a clean slate.
  const pending = Array.isArray(me?.pendingConnections) ? me.pendingConnections : [];
  for (const p of pending) {
    await request.post('/api/brand/requests/resolve', {
      headers: { Authorization: `Bearer ${brandAuth.token}` },
      data: { agencyCode: String(p.agencyCode), action: 'reject' },
    });
  }

  // Create a request as the agency.
  const agencyAuth = await loginApi(request, E2E_ACCOUNTS.agency.mobile);
  const connectRes = await request.post('/api/ops/brands/connect', {
    headers: { Authorization: `Bearer ${agencyAuth.token}` },
    data: { brandCode: BRAND_CODE },
  });
  if (!connectRes.ok()) {
    const payload = (await connectRes.json().catch(() => null)) as any;
    expect(connectRes.status()).toBe(409);
    expect(payload?.error?.code).toBe('ALREADY_REQUESTED');
  }

  // Now verify in the brand UI.
  await page.goto('/');
  await page.getByRole('button', { name: /Access Portal/i }).click();
  await page.getByPlaceholder('9000000000').fill(E2E_ACCOUNTS.brand.mobile);
  await page.getByPlaceholder('Password').fill(E2E_ACCOUNTS.brand.password);
  await page.getByRole('button', { name: /Login to Portal/i }).click();

  await expect(page.getByText('Partner Portal', { exact: true })).toBeVisible({ timeout: 15000 });

  // Reload to ensure session restore fetches full user data (including pendingConnections).
  await page.reload();
  await expect(page.getByText('Partner Portal', { exact: true })).toBeVisible({ timeout: 15000 });

  // Open requests tab.
  await page.getByRole('button', { name: 'Requests' }).click();

  // Wait for the pending connection card from E2E Agency.
  // Use h4 heading locator — avoids matching ancestor wrapper divs that cascade `hasText`.
  const agencyHeading = page.locator('h4').filter({ hasText: 'E2E Agency' });
  await expect(agencyHeading.first()).toBeVisible({ timeout: 15000 });

  // Click Approve on the card containing that heading.
  const card = page
    .locator('div')
    .filter({ has: agencyHeading })
    .filter({ hasText: 'Wants to connect with your brand.' })
    .first();
  await card.getByRole('button', { name: 'Approve' }).click();

  // Wait for the UI to process the approval.
  await page.waitForTimeout(1000);

  // Verify persistence by navigating away/back.
  await page.getByRole('button', { name: 'Agency Partners' }).click();
  await page.getByRole('button', { name: 'Requests' }).click();

  // Assert: E2E Agency heading should no longer exist on the Requests tab.
  await expect(agencyHeading).toHaveCount(0, { timeout: 15000 });

  // And the agency should appear in partners.
  await page.getByRole('button', { name: 'Agency Partners' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Agency' }).first()).toBeVisible({
    timeout: 15000,
  });
});
