import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Order proof management API', () => {
  let buyerToken: string;
  let buyerUser: any;
  let opsToken: string;
  let existingOrderId: string | undefined;

  test.beforeAll(async ({ request }) => {
    const [buyer, ops] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
      loginAndGetAccessToken(request, {
        username: E2E_ACCOUNTS.admin.username,
        password: E2E_ACCOUNTS.admin.password,
      }),
    ]);
    buyerToken = buyer.accessToken;
    buyerUser = buyer.user;
    opsToken = ops.accessToken;

    // Find an existing order to test proof endpoints
    const ordersRes = await request.get(`/api/orders/user/${buyerUser.id}`, {
      headers: authHeaders(buyerToken),
    });
    if (ordersRes.ok()) {
      const body = await ordersRes.json();
      const orders = body.data ?? body;
      if (Array.isArray(orders) && orders.length > 0) {
        existingOrderId = orders[0].id;
      }
    }
  });

  // ── Proof retrieval requires auth ─────────────────────────────
  test('proof retrieval rejects unauthenticated request', async ({ request }) => {
    const res = await request.get('/api/orders/fake-id/proof/order');
    expect([401, 403]).toContain(res.status());
  });

  // ── Proof URL retrieval requires auth ─────────────────────────
  test('proof-urls rejects unauthenticated request', async ({ request }) => {
    const res = await request.get('/api/orders/fake-id/proof-urls');
    expect([401, 403]).toContain(res.status());
  });

  // ── Batch proof URLs requires auth ────────────────────────────
  test('batch proof-urls rejects unauthenticated request', async ({ request }) => {
    const res = await request.post('/api/orders/proof-urls/batch', {
      data: { orderIds: ['fake'] },
    });
    expect([401, 403]).toContain(res.status());
  });

  // ── Get proof for existing order ──────────────────────────────
  test('buyer can request proof for own order', async ({ request }) => {
    test.skip(!existingOrderId, 'No existing order found');
    const res = await request.get(`/api/orders/${existingOrderId}/proof/order`, {
      headers: authHeaders(buyerToken),
    });
    // 200 if proof exists, 404 if not uploaded yet
    expect([200, 404]).toContain(res.status());
  });

  // ── Get proof-urls for existing order ─────────────────────────
  test('buyer can get proof URLs for own order', async ({ request }) => {
    test.skip(!existingOrderId, 'No existing order found');
    const res = await request.get(`/api/orders/${existingOrderId}/proof-urls`, {
      headers: authHeaders(buyerToken),
    });
    expect([200, 404]).toContain(res.status());
  });

  // ── Audit trail for existing order ────────────────────────────
  test('buyer can view audit trail for own order', async ({ request }) => {
    test.skip(!existingOrderId, 'No existing order found');
    const res = await request.get(`/api/orders/${existingOrderId}/audit`, {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Audit trail requires auth ─────────────────────────────────
  test('audit trail rejects unauthenticated request', async ({ request }) => {
    const res = await request.get('/api/orders/fake-id/audit');
    expect([401, 403]).toContain(res.status());
  });

  // ── Ops can view proof for any order ──────────────────────────
  test('ops can request proof for any order', async ({ request }) => {
    test.skip(!existingOrderId, 'No existing order found');
    const res = await request.get(`/api/orders/${existingOrderId}/proof/order`, {
      headers: authHeaders(opsToken),
    });
    expect([200, 404]).toContain(res.status());
  });

  // ── Signed proof with invalid token ───────────────────────────
  test('signed proof rejects invalid token', async ({ request }) => {
    const res = await request.get('/api/orders/proof/signed/invalid-hmac-token');
    expect([400, 401, 403, 404]).toContain(res.status());
  });

  // ── Order claim requires valid data ───────────────────────────
  test('order claim rejects empty data', async ({ request }) => {
    const res = await request.post('/api/orders/claim', {
      headers: authHeaders(buyerToken),
      data: {},
    });
    // Should fail validation, not 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── Reviewer name update ──────────────────────────────────────
  test('reviewer name update rejects unauthenticated', async ({ request }) => {
    const res = await request.patch('/api/orders/fake-id/reviewer-name', {
      data: { reviewerName: 'test' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
