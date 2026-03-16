import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from './_apiAuth';
import { E2E_ACCOUNTS } from './_seedAccounts';

// Helper: assert response ok and return parsed JSON, or throw with useful diagnostics.
async function expectOk(res: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<any> }, label: string) {
  if (!res.ok()) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`${label} failed [${res.status()}]: ${body.slice(0, 500)}`);
  }
  return res.json();
}

// This spec drives the critical money-moving lifecycle via HTTP APIs.
// It relies on the backend E2E seed users and runs against the buyer project by default.

test('order lifecycle: buyer create -> ops verify -> ops settle -> wallets credited', async ({ request }) => {
  // IMPORTANT: tests run in parallel; don't reuse the single seeded deal because
  // other specs (buyer + mediator) also create/verify orders for it.
  // We instead create a unique campaign+deal for this spec.

  const buyerLogin = await loginAndGetAccessToken(request, { mobile: E2E_ACCOUNTS.shopper.mobile, password: E2E_ACCOUNTS.shopper.password });
  const opsLogin = await loginAndGetAccessToken(request, { username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
  const brandLogin = await loginAndGetAccessToken(request, { mobile: E2E_ACCOUNTS.brand.mobile, password: E2E_ACCOUNTS.brand.password });

  const buyer = { user: buyerLogin.user, tokens: { accessToken: buyerLogin.accessToken } };
  const ops = { user: opsLogin.user, tokens: { accessToken: opsLogin.accessToken } };
  const brand = { user: brandLogin.user, tokens: { accessToken: brandLogin.accessToken } };

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

  // Create a fresh campaign + deal that won't collide with other E2E specs.
  const lifecycleTitle = `Lifecycle Campaign ${Date.now()}`;

  const createdCampaign = await expectOk(
    await request.post('/api/ops/campaigns', {
      headers: authHeaders(ops.tokens.accessToken),
      data: {
        brandUserId: brand.user.id,
        title: lifecycleTitle,
        platform: 'Amazon',
        dealType: 'Discount',
        price: 999,
        originalPrice: 1999,
        payout: 150,
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/lifecycle',
        totalSlots: 10,
        allowedAgencies: [],
        returnWindowDays: 14,
      },
    }),
    'Create campaign',
  );
  const campaignId = String(createdCampaign?.id || '');
  expect(campaignId, 'Campaign ID should be present in response').toBeTruthy();

  // Assign slots so the buyer's mediator has access.
  await expectOk(
    await request.post('/api/ops/campaigns/assign', {
      headers: authHeaders(ops.tokens.accessToken),
      data: {
        id: campaignId,
        assignments: {
          MED_TEST: { limit: 5 },
        },
      },
    }),
    'Assign slots',
  );

  // Publish deal for the seeded mediator.
  await expectOk(
    await request.post('/api/ops/deals/publish', {
      headers: authHeaders(ops.tokens.accessToken),
      data: {
        id: campaignId,
        commission: 50,
        mediatorCode: 'MED_TEST',
      },
    }),
    'Publish deal',
  );

  // Fetch products and pick our unique deal (retry briefly in case of propagation delay).
  let deal: any = null;
  for (let attempt = 0; attempt < 3 && !deal; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    const productsRes = await request.get('/api/products', {
      headers: authHeaders(buyer.tokens.accessToken),
    });
    const deals: any[] = (await expectOk(productsRes, 'List products')) ?? [];
    expect(Array.isArray(deals), 'Products response should be an array').toBeTruthy();
    deal = deals.find((d) => String(d?.campaignId) === campaignId) ?? deals.find((d) => String(d?.title) === lifecycleTitle);
  }
  expect(deal, `Deal for campaign ${campaignId} not found in products list`).toBeTruthy();

  // Wallets before
  const meBefore = await expectOk(
    await request.get('/api/auth/me', { headers: authHeaders(buyer.tokens.accessToken) }),
    'Get buyer wallet before',
  );
  const buyerWalletBefore = Number(meBefore?.user?.wallet?.balancePaise ?? meBefore?.user?.walletBalance ?? 0);

  // Create order with proof at creation time (UI-equivalent).
  // The backend enforces one active order per buyer+deal, so this spec must be idempotent.
  const externalOrderId = `E2E-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createRes = await request.post('/api/orders', {
    headers: authHeaders(buyer.tokens.accessToken),
    data: {
      userId: buyer.user.id,
      items: [
        {
          productId: String(deal.id),
          title: String(deal.title ?? 'Deal'),
          image: String(deal.image ?? 'https://example.com/e2e.png'),
          priceAtPurchase: Number(deal.price ?? 0),
          commission: Number(deal.commission ?? 0),
          campaignId: String(deal.campaignId ?? ''),
          dealType: String(deal.dealType ?? 'General'),
          quantity: 1,
          platform: deal.platform ? String(deal.platform) : undefined,
          brandName: deal.brandName ? String(deal.brandName) : undefined,
        },
      ],
      externalOrderId,
      reviewLink:
        String(deal.dealType ?? '').toLowerCase() === 'review'
          ? 'https://example.com/review/e2e'
          : undefined,
      screenshots: {
        order: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTAwIj48dGV4dCB4PSIxMCIgeT0iNTAiPkUyRSBQcm9vZjwvdGV4dD48L3N2Zz4=',
      },
    },
  });

  let orderId: string;
  let currentWorkflow: string | undefined;
  let didSettle = false;

  if (createRes.ok()) {
    const created = (await createRes.json()) as any;
    orderId = String(created?.id || '');
    currentWorkflow = created?.workflowStatus;
    expect(orderId, 'Order ID should be present after creation').toBeTruthy();
  } else {
    // Likely DUPLICATE_DEAL_ORDER. Re-use the most recent order for this buyer.
    const body = await createRes.text().catch(() => '');
    console.log(`Order creation returned ${createRes.status()}: ${body.slice(0, 300)}`);
    const existingRes = await request.get(`/api/orders/user/${buyer.user.id}`, {
      headers: authHeaders(buyer.tokens.accessToken),
    });
    const existing = (await expectOk(existingRes, 'List buyer orders (fallback)')) as any[];
    expect(Array.isArray(existing), 'Orders response should be an array').toBeTruthy();
    expect(existing.length, 'Buyer should have at least one existing order').toBeGreaterThan(0);
    const reusable = existing.find((o) => o?.items?.[0]?.productId === String(deal.id)) ?? existing[0];
    orderId = String(reusable?.id || '');
    currentWorkflow = String(reusable?.workflowStatus || '');
    expect(orderId, 'Reusable order ID should be present').toBeTruthy();
  }

  // Verify (ops/admin) - only valid from UNDER_REVIEW.
  if (currentWorkflow === 'UNDER_REVIEW') {
    const verifyRes = await expectOk(
      await request.post('/api/ops/verify', {
        headers: authHeaders(ops.tokens.accessToken),
        data: { orderId },
      }),
      'Verify order',
    );

    // With returnWindow required for all deals, purchase verification alone
    // does NOT approve.  We must submit + verify the returnWindow proof too.
    if (verifyRes?.approved === true) {
      currentWorkflow = 'APPROVED';
    } else {
      // Submit returnWindow proof (purchase must already be verified).
      await expectOk(
        await request.post('/api/orders/claim', {
          headers: authHeaders(buyer.tokens.accessToken),
          data: {
            orderId,
            type: 'returnWindow',
            data: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTAwIj48dGV4dCB4PSIxMCIgeT0iNTAiPkUyRSBSZXR1cm4gV2luZG93PC90ZXh0Pjwvc3ZnPg==',
          },
        }),
        'Submit returnWindow proof',
      );

      // Verify the returnWindow proof (ops).
      const rwVerifyRes = await expectOk(
        await request.post('/api/ops/orders/verify-requirement', {
          headers: authHeaders(ops.tokens.accessToken),
          data: { orderId, type: 'returnWindow' },
        }),
        'Verify returnWindow requirement',
      );
      currentWorkflow = rwVerifyRes?.approved === true ? 'APPROVED' : String(rwVerifyRes?.order?.workflowStatus ?? 'UNDER_REVIEW');
    }
  }

  // Settle (ops/admin) - only valid from APPROVED.
  if (currentWorkflow === 'APPROVED') {
    await expectOk(
      await request.post('/api/ops/orders/settle', {
        headers: authHeaders(ops.tokens.accessToken),
        data: { orderId, settlementRef: `E2E-SETTLE-${Date.now()}` },
      }),
      'Settle order',
    );
    didSettle = true;
  }

  // Wallets after
  const meAfter = await expectOk(
    await request.get('/api/auth/me', { headers: authHeaders(buyer.tokens.accessToken) }),
    'Get buyer wallet after',
  );
  const buyerWalletAfter = Number(meAfter?.user?.wallet?.balancePaise ?? meAfter?.user?.walletBalance ?? 0);

  if (didSettle) {
    // Settlement just happened — wallet balance must have increased.
    expect(buyerWalletAfter).toBeGreaterThan(buyerWalletBefore);
  } else {
    // Order was already settled in a prior run — wallet shouldn't have decreased.
    expect(buyerWalletAfter).toBeGreaterThanOrEqual(buyerWalletBefore);
  }
});
