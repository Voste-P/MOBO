import { expect, test } from '@playwright/test';
import { E2E_ACCOUNTS } from '../helpers/accounts';
import { loginAndGetAccessToken } from '../helpers/auth';

test('mediator cannot request brand connection (agency-only)', async ({ request }) => {
  const { accessToken } = await loginAndGetAccessToken(request, E2E_ACCOUNTS.mediator);

  const res = await request.post('/api/ops/brands/connect', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { brandCode: 'BRD_TEST' },
  });

  expect([401, 403]).toContain(res.status());
});
