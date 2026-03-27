import { expect, test } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';
import { loginAndGetAccessToken } from '../helpers/auth';

test('agency can request brand connection (idempotent)', async ({ request }) => {
  const { accessToken } = await loginAndGetAccessToken(request, E2E_ACCOUNTS.agency);

  const res = await request.post('/api/ops/brands/connect', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { brandCode: 'BRD_TEST' },
  });

  if (res.ok()) {
    const payload = await res.json().catch(() => null);
    expect(payload).toBeTruthy();
    return;
  }

  // If already connected/pending, backend may return a structured error; treat as success.
  const payload = await res.json().catch(() => null);
  expect(payload?.error?.code).toBe('ALREADY_REQUESTED');
});
