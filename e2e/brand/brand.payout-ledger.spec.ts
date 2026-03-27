import { test, expect, type APIRequestContext } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const BRAND_CODE = 'BRD_TEST';
const AGENCY_CODE = 'AG_TEST';

async function loginApi(request: APIRequestContext, mobile: string) {
  const res = await request.post('/api/auth/login', {
    data: { mobile, password: E2E_ACCOUNTS.brand.password },
  });
  if (!res.ok()) {
    throw new Error(`Login failed (status=${res.status()}): ${await res.text()}`);
  }
  const json = (await res.json()) as any;
  const token = String(json?.tokens?.accessToken || '');
  expect(token).toBeTruthy();
  return { token, user: json.user };
}

test('brand can record a payout and see it in ledger', async ({ page, request }) => {
  // Ensure the brand portal proxy + backend are ready.
  await expect
    .poll(async () => {
      const res = await request.get('/api/health');
      return res.ok();
    })
    .toBeTruthy();

  const brandAuth = await loginApi(request, E2E_ACCOUNTS.brand.mobile);

  // Identify brand + current ledger count.
  const meRes = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${brandAuth.token}` },
  });
  expect(meRes.ok()).toBeTruthy();
  const meJson = (await meRes.json()) as any;
  const me = meJson?.user ?? meJson;
  const brandId = String(me?.id || '');
  expect(brandId).toBeTruthy();

  // Ensure brand is connected to the demo agency.
  if (!Array.isArray(me?.connectedAgencies) || !me.connectedAgencies.includes(AGENCY_CODE)) {
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

    const approveRes = await request.post('/api/brand/requests/resolve', {
      headers: { Authorization: `Bearer ${brandAuth.token}` },
      data: { agencyCode: AGENCY_CODE, action: 'approve' },
    });
    if (!approveRes.ok()) {
      const payload = (await approveRes.json().catch(() => null)) as any;
      expect(approveRes.status()).toBe(409);
      expect(payload?.error?.code).toBe('NO_CHANGE');
    }

    // Confirm the connection is in place.
    const me2Res = await request.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${brandAuth.token}` },
    });
    expect(me2Res.ok()).toBeTruthy();
    const me2Json = (await me2Res.json()) as any;
    const me2 = me2Json?.user ?? me2Json;
    expect(Array.isArray(me2?.connectedAgencies) && me2.connectedAgencies.includes(AGENCY_CODE)).toBeTruthy();
  }

  // Fetch connected agencies so we can click the right card by name.
  const agenciesRes = await request.get(`/api/brand/agencies?brandId=${brandId}`, {
    headers: { Authorization: `Bearer ${brandAuth.token}` },
  });
  expect(agenciesRes.ok()).toBeTruthy();
  const agencies = (await agenciesRes.json()) as any[];
  const agency = agencies.find((a) => String(a?.mediatorCode || '') === AGENCY_CODE);
  expect(agency).toBeTruthy();
  const agencyName = String(agency?.name || '');
  expect(agencyName).toBeTruthy();

  const beforeTxnsRes = await request.get(`/api/brand/transactions?brandId=${brandId}`, {
    headers: { Authorization: `Bearer ${brandAuth.token}` },
  });
  expect(beforeTxnsRes.ok()).toBeTruthy();
  const beforeTxns = (await beforeTxnsRes.json()) as any[];

  // Login in UI and open the agency modal.
  await page.goto('/');
  await page.getByRole('button', { name: /Access Portal/i }).click();
  await page.getByPlaceholder('9000000000').fill(E2E_ACCOUNTS.brand.mobile);
  await page.getByPlaceholder('Password').fill(E2E_ACCOUNTS.brand.password);
  await page.getByRole('button', { name: /Login to Portal/i }).click();

  await expect(page.getByText('Partner Portal', { exact: true })).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'Agency Partners' }).click();

  // Click the agency card.
  const agencyCard = page
    .locator('div.bg-white.p-6')
    .filter({ hasText: agencyName })
    .filter({ hasText: AGENCY_CODE });
  await expect(agencyCard.first()).toBeVisible({ timeout: 15000 });
  await agencyCard.first().click();

  // Fill payout details.
  const amount = 123;
  const ref = `UTR-E2E-${Date.now()}`;

  await page.getByPlaceholder('0.00').fill(String(amount));
  await page.getByPlaceholder('Transaction Reference (UTR)').fill(ref);

  await page.getByRole('button', { name: /Confirm Transfer/i }).click();

  // Brand portal uses an in-app toast (not a browser dialog) on success.
  await expect(page.getByRole('status').filter({ hasText: 'Payment recorded' }).first()).toBeVisible({
    timeout: 15000,
  });

  // Modal closes on success.
  await expect(page.getByRole('heading', { name: 'Record Payment' })).toBeHidden({
    timeout: 15000,
  });

  // Ledger should eventually include the new payout (validate via API for stability).
  await expect
    .poll(
      async () => {
        const afterTxnsRes = await request.get(`/api/brand/transactions?brandId=${brandId}`, {
          headers: { Authorization: `Bearer ${brandAuth.token}` },
        });
        if (!afterTxnsRes.ok()) {
          return {
            count: 0,
            found: false,
            status: afterTxnsRes.status(),
            body: await afterTxnsRes.text(),
          };
        }
        const afterTxns = (await afterTxnsRes.json()) as any[];
        const found = afterTxns.some(
          (t) => String(t?.ref || '') === ref && Number(t?.amount) === amount && String(t?.agencyName || '') === agencyName
        );
        return { count: afterTxns.length, found };
      },
      { timeout: 15000 }
    )
    .toEqual(
      expect.objectContaining({
        count: beforeTxns.length + 1,
        found: true,
      })
    );

  // And the UI ledger should show the amount (best-effort check).
  await page.getByRole('button', { name: 'Agency Partners' }).click();
  const ledgerRow = page
    .locator('tbody tr')
    .filter({ hasText: agencyName })
    .filter({ hasText: `${amount}` });
  await expect(ledgerRow.first()).toBeVisible({ timeout: 15000 });
});
