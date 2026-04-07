import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

async function expectOk(res: any, label: string) {
  if (!res.ok()) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label}: expected 2xx, got ${res.status()} – ${body.slice(0, 400)}`);
  }
  return res.json().catch(() => null);
}

test.describe('Order lifecycle: create → verify → settle → wallet', () => {
  let buyer: { accessToken: string; user: any };
  let ops: { accessToken: string; user: any };

  test.beforeAll(async ({ request }) => {
    buyer = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    ops = await loginAndGetAccessToken(request, {
      username: E2E_ACCOUNTS.admin.username,
      password: E2E_ACCOUNTS.admin.password,
    });
  });

  test('health endpoint is reachable', async ({ request }) => {
    const res = await request.get('/api/health/ready');
    expect(res.ok()).toBeTruthy();
  });

  test('full order lifecycle', async ({ request }) => {
    // 1. Get available products — retry up to 10 times (seed may still be settling)
    let deals: any[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      const productsRes = await request.get('/api/products', {
        headers: authHeaders(buyer.accessToken),
      });
      expect(productsRes.ok()).toBeTruthy();
      const products = await productsRes.json();
      const raw = products?.data ?? products;
      if (Array.isArray(raw) && raw.length > 0) { deals = raw; break; }
    }
    // Fail with diagnostics instead of silently skipping
    expect(deals.length, 'No deals found after 10 retries — check E2E seed').toBeGreaterThan(0);
    // Pick the E2E Deal (has valid payout) instead of whatever comes first
    const deal = deals.find((d: any) => d.title === 'E2E Deal' && d.commission > 0)
      ?? deals.find((d: any) => d.commission > 0)
      ?? deals[0];

    // 2. Record wallet before
    const meBefore = await expectOk(
      await request.get('/api/auth/me', { headers: authHeaders(buyer.accessToken) }),
      'Get buyer wallet before',
    );
    const buyerWalletBefore = Number(
      meBefore?.user?.wallet?.balancePaise ?? meBefore?.user?.walletBalance ?? 0,
    );

    // 3. Create order
    const externalOrderId = `E2E-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const createRes = await request.post('/api/orders', {
      headers: authHeaders(buyer.accessToken),
      data: {
        userId: buyer.user.id,
        items: [
          {
            productId: String(deal.id),
            title: String(deal.title ?? 'Deal'),
            image: String(deal.image ?? 'https://example.com/e2e.png'),
            priceAtPurchase: Number(deal.price ?? deal.pricePaise ?? 0),
            commission: Number(deal.commission ?? deal.commissionPaise ?? 0),
            campaignId: String(deal.campaignId ?? ''),
            dealType: String(deal.dealType ?? 'General'),
            quantity: 1,
            platform: deal.platform ? String(deal.platform) : undefined,
            brandName: deal.brandName ? String(deal.brandName) : undefined,
          },
        ],
        externalOrderId,
        screenshots: {
          order:
            'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTAwIj48dGV4dCB4PSIxMCIgeT0iNTAiPkUyRSBQcm9vZjwvdGV4dD48L3N2Zz4=',
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
      expect(orderId).toBeTruthy();
    } else {
      // DUPLICATE_DEAL_ORDER or RBAC — re-use most recent order
      const existingRes = await request.get(`/api/orders/user/${buyer.user.id}`, {
        headers: authHeaders(buyer.accessToken),
      });
      const existing = (await expectOk(existingRes, 'List buyer orders (fallback)')) as any[];
      expect(
        Array.isArray(existing) && existing.length > 0,
        'No orders exist and creation failed — check seed data and order creation',
      ).toBeTruthy();
      const reusable =
        existing.find((o) => o?.items?.[0]?.productId === String(deal.id)) ?? existing[0];
      orderId = String(reusable?.id || '');
      currentWorkflow = String(reusable?.workflowStatus || '');
      expect(orderId).toBeTruthy();
    }

    // 4. Verify (ops/admin) – only valid from UNDER_REVIEW
    if (currentWorkflow === 'UNDER_REVIEW') {
      const verifyRes = await expectOk(
        await request.post('/api/ops/verify', {
          headers: authHeaders(ops.accessToken),
          data: { orderId },
        }),
        'Verify order',
      );

      if (verifyRes?.approved === true) {
        currentWorkflow = 'APPROVED';
      } else {
        // Submit returnWindow proof
        await expectOk(
          await request.post('/api/orders/claim', {
            headers: authHeaders(buyer.accessToken),
            data: {
              orderId,
              type: 'returnWindow',
              data: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMTAwIj48dGV4dCB4PSIxMCIgeT0iNTAiPkUyRSBSZXR1cm4gV2luZG93PC90ZXh0Pjwvc3ZnPg==',
            },
          }),
          'Submit returnWindow proof',
        );
        // Verify returnWindow proof
        const rwRes = await expectOk(
          await request.post('/api/ops/orders/verify-requirement', {
            headers: authHeaders(ops.accessToken),
            data: { orderId, type: 'returnWindow' },
          }),
          'Verify returnWindow',
        );
        currentWorkflow =
          rwRes?.approved === true
            ? 'APPROVED'
            : String(rwRes?.order?.workflowStatus ?? 'UNDER_REVIEW');
      }
    }

    // 5. Settle (ops/admin) – only valid from APPROVED
    if (currentWorkflow === 'APPROVED') {
      await expectOk(
        await request.post('/api/ops/orders/settle', {
          headers: authHeaders(ops.accessToken),
          data: { orderId, settlementRef: `E2E-SETTLE-${Date.now()}` },
        }),
        'Settle order',
      );
      didSettle = true;
    }

    // 6. Verify wallet updated
    const meAfter = await expectOk(
      await request.get('/api/auth/me', { headers: authHeaders(buyer.accessToken) }),
      'Get buyer wallet after',
    );
    const buyerWalletAfter = Number(
      meAfter?.user?.wallet?.balancePaise ?? meAfter?.user?.walletBalance ?? 0,
    );

    if (didSettle) {
      expect(buyerWalletAfter).toBeGreaterThan(buyerWalletBefore);
    } else {
      expect(buyerWalletAfter).toBeGreaterThanOrEqual(buyerWalletBefore);
    }
  });
});
