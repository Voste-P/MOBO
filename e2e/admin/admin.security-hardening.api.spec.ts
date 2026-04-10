import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Security hardening — large payload & injection', () => {
  let buyerToken: string;

  test.beforeAll(async ({ request }) => {
    const buyer = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.shopper.mobile,
      password: E2E_ACCOUNTS.shopper.password,
    });
    buyerToken = buyer.accessToken;
  });

  // ── Large payload should NOT be blocked by security middleware ──────
  test('large base64 payload is accepted (not blocked by deep scan)', async ({ request }) => {
    // Generate a 600KB+ base64 string to exceed the 512KB threshold
    const largeBase64 = 'A'.repeat(600_000);
    const res = await request.post('/api/products', {
      headers: {
        ...authHeaders(buyerToken),
        'Content-Type': 'application/json',
      },
      data: { screenshot: largeBase64 },
    });
    // Should not be 400 with "invalid characters" — security scan is skipped
    // Accept 400 (validation error), 403 (RBAC), or 422 — but NOT a security block
    if (res.status() === 400) {
      const body = await res.json();
      expect(body.error?.code).not.toBe('BAD_REQUEST');
    }
    // Essentially: the request should reach the route handler, not get blocked in middleware
    expect(res.status()).not.toBe(500);
  });

  // ── Small malicious payloads are still blocked ─────────────────────
  test('SQL injection in body is blocked', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: {
        username: "admin'; DROP TABLE users;--",
        password: 'anything',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error?.message).toContain('invalid characters');
  });

  test('path traversal in query is blocked', async ({ request }) => {
    const res = await request.get('/api/products?file=../../../../etc/passwd', {
      headers: authHeaders(buyerToken),
    });
    expect(res.status()).toBe(400);
  });

  test('NoSQL injection operator is blocked', async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: {
        username: { '$gt': '' },
        password: { '$gt': '' },
      },
    });
    expect(res.status()).toBe(400);
  });

  test('XSS script tag in body is blocked', async ({ request }) => {
    const res = await request.post('/api/tickets', {
      headers: authHeaders(buyerToken),
      data: {
        issueType: 'Order Issue',
        description: '<script>alert("xss")</script>',
      },
    });
    expect(res.status()).toBe(400);
  });

  // ── Response timing header is present ──────────────────────────────
  test('response includes X-Response-Time header', async ({ request }) => {
    const res = await request.get('/api/products', {
      headers: authHeaders(buyerToken),
    });
    expect(res.ok()).toBeTruthy();
    const timing = res.headers()['x-response-time'];
    expect(timing).toBeTruthy();
    expect(timing).toMatch(/^\d+(\.\d+)?ms$/);
  });
});
