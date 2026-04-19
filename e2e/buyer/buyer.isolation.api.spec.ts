import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Buyer API — cross-user isolation & data integrity', () => {
  let buyer1Token: string;
  let buyer1User: any;
  let buyer2Token: string;
  let buyer2User: any;

  test.beforeAll(async ({ request }) => {
    const [b1, b2] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper2.mobile,
        password: E2E_ACCOUNTS.shopper2.password,
      }),
    ]);
    buyer1Token = b1.accessToken;
    buyer1User = b1.user;
    buyer2Token = b2.accessToken;
    buyer2User = b2.user;
  });

  // ── Cross-user isolation ──────────────────────────────────────────
  test('buyer1 cannot see buyer2 orders', async ({ request }) => {
    const res = await request.get(`/api/orders/user/${buyer2User.id}`, {
      headers: authHeaders(buyer1Token),
    });
    // Should be 403 (forbidden) or empty result — not buyer2's data
    if (res.ok()) {
      const body = await res.json();
      const orders = body.data ?? body;
      // If request succeeds, backend should filter to only buyer1's own orders
      if (Array.isArray(orders) && orders.length > 0) {
        for (const order of orders) {
          expect(order.userId).not.toBe(buyer2User.id);
        }
      }
    } else {
      expect([403, 404]).toContain(res.status());
    }
  });

  test('buyer2 cannot see buyer1 orders', async ({ request }) => {
    const res = await request.get(`/api/orders/user/${buyer1User.id}`, {
      headers: authHeaders(buyer2Token),
    });
    if (res.ok()) {
      const body = await res.json();
      const orders = body.data ?? body;
      if (Array.isArray(orders) && orders.length > 0) {
        for (const order of orders) {
          expect(order.userId).not.toBe(buyer1User.id);
        }
      }
    } else {
      expect([403, 404]).toContain(res.status());
    }
  });

  // ── Profile isolation ─────────────────────────────────────────────
  test('each buyer sees only their own profile', async ({ request }) => {
    const [res1, res2] = await Promise.all([
      request.get('/api/auth/me', { headers: authHeaders(buyer1Token) }),
      request.get('/api/auth/me', { headers: authHeaders(buyer2Token) }),
    ]);
    expect(res1.ok()).toBeTruthy();
    expect(res2.ok()).toBeTruthy();

    const p1 = (await res1.json()).user;
    const p2 = (await res2.json()).user;
    expect(p1.id).toBe(buyer1User.id);
    expect(p2.id).toBe(buyer2User.id);
    expect(p1.id).not.toBe(p2.id);
  });

  // ── Notification isolation ────────────────────────────────────────
  test('buyer notifications are scoped to their user', async ({ request }) => {
    const res = await request.get('/api/notifications', {
      headers: authHeaders(buyer1Token),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const notifs = body.data ?? body;
    if (Array.isArray(notifs) && notifs.length > 0) {
      for (const n of notifs) {
        expect(n.userId).toBe(buyer1User.id);
      }
    }
  });
});
