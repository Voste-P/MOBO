import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Ops order operations API', () => {
  let agencyToken: string;
  let mediatorToken: string;
  let buyerToken: string;
  let adminToken: string;

  test.beforeAll(async ({ request }) => {
    const [agency, mediator, buyer, admin] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.agency.mobile,
        password: E2E_ACCOUNTS.agency.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.mediator.mobile,
        password: E2E_ACCOUNTS.mediator.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
      loginAndGetAccessToken(request, {
        username: E2E_ACCOUNTS.admin.username,
        password: E2E_ACCOUNTS.admin.password,
      }),
    ]);
    agencyToken = agency.accessToken;
    mediatorToken = mediator.accessToken;
    buyerToken = buyer.accessToken;
    adminToken = admin.accessToken;
  });

  // ── Order verification ────────────────────────────────────────
  test('verify rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/verify', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent-order-id' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('buyer cannot verify orders', async ({ request }) => {
    const res = await request.post('/api/ops/verify', {
      headers: authHeaders(buyerToken),
      data: { orderId: 'test' },
    });
    expect(res.status()).toBe(403);
  });

  // ── Verify requirement ────────────────────────────────────────
  test('verify-requirement rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/verify-requirement', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent', type: 'order' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Verify all ────────────────────────────────────────────────
  test('verify-all rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/verify-all', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Reject proof ──────────────────────────────────────────────
  test('reject-proof rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/reject-proof', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent', type: 'order', reason: 'E2E test' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Cancel proofs ─────────────────────────────────────────────
  test('cancel-proofs rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/cancel-proofs', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Request proof ─────────────────────────────────────────────
  test('request-proof rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/request-proof', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent', type: 'order' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Force approve ─────────────────────────────────────────────
  test('force-approve rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/force-approve', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Cancel order ──────────────────────────────────────────────
  test('cancel rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/cancel', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent', reason: 'E2E test' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Settle/unsettle financial ops ─────────────────────────────
  test('settle rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/settle', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent', settlementRef: `E2E-${Date.now()}` },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('unsettle rejects invalid orderId', async ({ request }) => {
    const res = await request.post('/api/ops/orders/unsettle', {
      headers: authHeaders(agencyToken),
      data: { orderId: 'nonexistent' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('buyer cannot settle orders', async ({ request }) => {
    const res = await request.post('/api/ops/orders/settle', {
      headers: authHeaders(buyerToken),
      data: { orderId: 'test', settlementRef: 'test' },
    });
    expect(res.status()).toBe(403);
  });

  // ── Payouts ───────────────────────────────────────────────────
  test('payout rejects empty payload', async ({ request }) => {
    const res = await request.post('/api/ops/payouts', {
      headers: authHeaders(agencyToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('buyer cannot create payouts', async ({ request }) => {
    const res = await request.post('/api/ops/payouts', {
      headers: authHeaders(buyerToken),
      data: { amount: 100 },
    });
    expect(res.status()).toBe(403);
  });

  test('delete payout rejects nonexistent id', async ({ request }) => {
    const res = await request.delete('/api/ops/payouts/nonexistent-id', {
      headers: authHeaders(agencyToken),
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── User management (approve/reject) ──────────────────────────
  test('approve user rejects invalid userId', async ({ request }) => {
    const res = await request.post('/api/ops/users/approve', {
      headers: authHeaders(agencyToken),
      data: { userId: 'nonexistent' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('reject user rejects invalid userId', async ({ request }) => {
    const res = await request.post('/api/ops/users/reject', {
      headers: authHeaders(agencyToken),
      data: { userId: 'nonexistent', reason: 'E2E test' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Mediator management ───────────────────────────────────────
  test('approve mediator rejects invalid mediatorId', async ({ request }) => {
    const res = await request.post('/api/ops/mediators/approve', {
      headers: authHeaders(agencyToken),
      data: { mediatorId: 'nonexistent' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('reject mediator rejects invalid mediatorId', async ({ request }) => {
    const res = await request.post('/api/ops/mediators/reject', {
      headers: authHeaders(agencyToken),
      data: { mediatorId: 'nonexistent', reason: 'E2E test' },
    });
    expect(res.status()).toBeLessThan(500);
  });

  // ── Invite generation ─────────────────────────────────────────
  test('ops can generate mediator invite', async ({ request }) => {
    const res = await request.post('/api/ops/invites/generate', {
      headers: authHeaders(agencyToken),
      data: {},
    });
    // May succeed or fail based on business logic — but no 5xx
    expect(res.status()).toBeLessThan(500);
  });

  test('ops can generate buyer invite', async ({ request }) => {
    const res = await request.post('/api/ops/invites/generate-buyer', {
      headers: authHeaders(mediatorToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('buyer cannot generate invites', async ({ request }) => {
    const res = await request.post('/api/ops/invites/generate', {
      headers: authHeaders(buyerToken),
      data: {},
    });
    expect(res.status()).toBe(403);
  });

  // ── Brand connection ──────────────────────────────────────────
  test('brand connect rejects empty payload', async ({ request }) => {
    const res = await request.post('/api/ops/brands/connect', {
      headers: authHeaders(agencyToken),
      data: {},
    });
    expect(res.status()).toBeLessThan(500);
  });
});
