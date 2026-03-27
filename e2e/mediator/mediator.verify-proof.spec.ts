import { test, expect } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test('mediator can open verification modal for a newly created buyer order', async ({ page, request }) => {
  page.on('dialog', async (dialog) => {
    try {
      await dialog.accept();
    } catch {
      // ignore
    }
  });

  const login = async (args: { mobile?: string; username?: string }) => {
    const password = E2E_ACCOUNTS.admin.password; // Same password for all E2E accounts
    const res = await request.post('/api/auth/login', {
      data: args.username
        ? { username: args.username, password }
        : { mobile: String(args.mobile || ''), password },
    });
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json?.tokens?.accessToken).toBeTruthy();
    return json as {
      user: { id: string; roles: string[] };
      tokens: { accessToken: string };
    };
  };

  const buyer = await login({ mobile: E2E_ACCOUNTS.shopper2.mobile });
  const ops = await login({ username: E2E_ACCOUNTS.admin.username });
  const brand = await login({ mobile: E2E_ACCOUNTS.brand.mobile });

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

  // Create a unique campaign+deal so we always get a fresh Unchecked order.
  // The backend blocks duplicate active orders per buyer+deal, and the seeded deal
  // can already be settled by other specs.
  const campaignTitle = `Mediator Proof ${Date.now()}`;
  const createCampaignRes = await request.post('/api/ops/campaigns', {
    headers: authHeaders(ops.tokens.accessToken),
    data: {
      brandUserId: brand.user.id,
      title: campaignTitle,
      platform: 'Amazon',
      dealType: 'Discount',
      price: 999,
      originalPrice: 1999,
      payout: 150,
      image: 'https://placehold.co/600x400',
      productUrl: 'https://example.com/mediator-proof',
      totalSlots: 10,
      allowedAgencies: [],
      returnWindowDays: 14,
    },
  });
  expect(createCampaignRes.ok()).toBeTruthy();
  const createdCampaign = (await createCampaignRes.json()) as any;
  const campaignId = String(createdCampaign?.id || '');
  expect(campaignId).toBeTruthy();

  const assignRes = await request.post('/api/ops/campaigns/assign', {
    headers: authHeaders(ops.tokens.accessToken),
    data: {
      id: campaignId,
      assignments: {
        MED_TEST: { limit: 5 },
      },
    },
  });
  expect(assignRes.ok()).toBeTruthy();

  const publishRes = await request.post('/api/ops/deals/publish', {
    headers: authHeaders(ops.tokens.accessToken),
    data: {
      id: campaignId,
      commission: 50,
      mediatorCode: 'MED_TEST',
    },
  });
  expect(publishRes.ok()).toBeTruthy();

  const dealsRes = await request.get('/api/products', {
    headers: authHeaders(buyer.tokens.accessToken),
  });
  expect(dealsRes.ok()).toBeTruthy();
  const deals = (await dealsRes.json()) as any[];
  expect(Array.isArray(deals)).toBeTruthy();
  expect(deals.length).toBeGreaterThan(0);
  const deal = deals.find((d) => String(d?.campaignId) === campaignId) ?? deals.find((d) => String(d?.title) === campaignTitle);
  expect(deal).toBeTruthy();

  const expectedExternalOrderId = `MED-E2E-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createRes = await request.post('/api/orders', {
    headers: authHeaders(buyer.tokens.accessToken),
    data: {
      userId: String(buyer.user.id),
      items: [
        {
          productId: String(deal.id),
          title: String(deal.title ?? 'Deal'),
          image: String(deal.image ?? 'https://example.com/e2e.png'),
          priceAtPurchase: Number(deal.price ?? 0),
          commission: Number(deal.commission ?? 0),
          campaignId: String(deal.campaignId ?? ''),
          dealType: String(deal.dealType ?? 'Discount'),
          quantity: 1,
          platform: deal.platform ? String(deal.platform) : undefined,
          brandName: deal.brandName ? String(deal.brandName) : undefined,
        },
      ],
      externalOrderId: expectedExternalOrderId,
      screenshots: {
        order: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTAwIj48dGV4dCB4PSIxMCIgeT0iNTAiPkUyRSBNZWRpYXRvciBQcm9vZjwvdGV4dD48L3N2Zz4=',
      },
    },
  });
  expect(createRes.ok()).toBeTruthy();

  // Sanity check: the order should be visible to the mediator as Unchecked.
  const mediator = await login({ mobile: E2E_ACCOUNTS.mediator.mobile });
  const mediatorOrdersRes = await request.get('/api/ops/orders?mediatorCode=MED_TEST', {
    headers: authHeaders(mediator.tokens.accessToken),
  });
  expect(mediatorOrdersRes.ok()).toBeTruthy();
  const mediatorOrders = (await mediatorOrdersRes.json()) as any[];
  const createdForMediator = mediatorOrders.find(
    (o) => o?.buyerMobile === E2E_ACCOUNTS.shopper2.mobile && o?.affiliateStatus === 'Unchecked' && String(o?.items?.[0]?.title) === campaignTitle,
  );
  expect(createdForMediator).toBeTruthy();

  // Now login as mediator in UI
  await page.goto('/');
  await page.getByRole('button', { name: /^Login$/ }).click();
  await page.getByPlaceholder('Mobile Number').fill(E2E_ACCOUNTS.mediator.mobile);
  await page.getByPlaceholder('Password').fill(E2E_ACCOUNTS.mediator.password);
  await page.getByRole('button', { name: /^Login$/ }).click();

  // Mediator dashboard keeps background polling/realtime, so `networkidle` can be unreliable.
  await expect(page.getByText('MED_TEST', { exact: false }).first()).toBeVisible({ timeout: 15000 });

  // Ensure inbox is loaded and open verification for the buyer
  // Scope to the actual order card (the UI renders many nested divs, and a broad div
  // locator can match the whole page, containing multiple "Verify Proofs" buttons).
  const buyerCard = page
    .locator('div.bg-white.p-2')
    .filter({ hasText: 'Buyer:' })
    .filter({ hasText: 'E2E Shopper 2' })
    .filter({ hasText: campaignTitle })
    .first();
  await expect(buyerCard).toBeVisible({ timeout: 15000 });

  await buyerCard.getByRole('button', { name: /Verify Purchase|Review Steps/i }).click();

  await expect(page.getByText('Verification Station', { exact: true })).toBeVisible();
  await expect(page.getByText(expectedExternalOrderId, { exact: true }).first()).toBeVisible();
});
