import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Ticket lifecycle API', () => {
  let shopperToken: string;
  let mediatorToken: string;
  let createdTicketId: string | undefined;

  test.beforeAll(async ({ request }) => {
    const [shopper, mediator] = await Promise.all([
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.shopper.mobile,
        password: E2E_ACCOUNTS.shopper.password,
      }),
      loginAndGetAccessToken(request, {
        mobile: E2E_ACCOUNTS.mediator.mobile,
        password: E2E_ACCOUNTS.mediator.password,
      }),
    ]);
    shopperToken = shopper.accessToken;
    mediatorToken = mediator.accessToken;
  });

  // ── Issue types ────────────────────────────────────────────────
  test('can fetch ticket issue types', async ({ request }) => {
    const res = await request.get('/api/tickets/issue-types', {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.issueTypes ?? body)).toBeTruthy();
  });

  // ── Create ─────────────────────────────────────────────────────
  test('shopper can create a ticket', async ({ request }) => {
    const res = await request.post('/api/tickets', {
      headers: authHeaders(shopperToken),
      data: {
        issueType: 'Order Issue',
        description: `E2E ticket lifecycle test ${Date.now()}`,
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    createdTicketId = body.ticket?.id ?? body.id;
    expect(createdTicketId).toBeTruthy();
  });

  // ── List ───────────────────────────────────────────────────────
  test('shopper can list their tickets', async ({ request }) => {
    const res = await request.get('/api/tickets', {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data ?? body)).toBeTruthy();
  });

  // ── Read single ────────────────────────────────────────────────
  test('shopper can read the created ticket', async ({ request }) => {
    test.skip(!createdTicketId, 'No ticket was created');
    const res = await request.get(`/api/tickets/${createdTicketId}`, {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const ticket = body.ticket ?? body;
    expect(ticket.id ?? ticket._id).toBeTruthy();
  });

  // ── Update ─────────────────────────────────────────────────────
  test('shopper can update the ticket', async ({ request }) => {
    test.skip(!createdTicketId, 'No ticket was created');
    const res = await request.patch(`/api/tickets/${createdTicketId}`, {
      headers: authHeaders(shopperToken),
      data: { status: 'Resolved' },
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Comments ───────────────────────────────────────────────────
  test('shopper can add a comment', async ({ request }) => {
    test.skip(!createdTicketId, 'No ticket was created');
    const res = await request.post(`/api/tickets/${createdTicketId}/comments`, {
      headers: authHeaders(shopperToken),
      data: { message: `E2E comment ${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('shopper can list comments', async ({ request }) => {
    test.skip(!createdTicketId, 'No ticket was created');
    const res = await request.get(`/api/tickets/${createdTicketId}/comments`, {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Mediator can also create tickets ───────────────────────────
  test('mediator can create a ticket', async ({ request }) => {
    const res = await request.post('/api/tickets', {
      headers: authHeaders(mediatorToken),
      data: {
        issueType: 'Commission Delay',
        description: `E2E mediator ticket ${Date.now()}`,
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('mediator can list their tickets', async ({ request }) => {
    const res = await request.get('/api/tickets', {
      headers: authHeaders(mediatorToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Delete ─────────────────────────────────────────────────────
  test('shopper can delete the ticket', async ({ request }) => {
    test.skip(!createdTicketId, 'No ticket was created');
    const res = await request.delete(`/api/tickets/${createdTicketId}`, {
      headers: authHeaders(shopperToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  // ── Unauthenticated access blocked ────────────────────────────
  test('unauthenticated request cannot list tickets', async ({ request }) => {
    const res = await request.get('/api/tickets');
    expect([401, 403]).toContain(res.status());
  });
});
