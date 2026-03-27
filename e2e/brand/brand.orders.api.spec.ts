import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('Brand orders & campaigns API', () => {
  let brandToken: string;

  test.beforeAll(async ({ request }) => {
    const brand = await loginAndGetAccessToken(request, {
      mobile: E2E_ACCOUNTS.brand.mobile,
      password: E2E_ACCOUNTS.brand.password,
    });
    brandToken = brand.accessToken;
  });

  test('brand can list their orders', async ({ request }) => {
    const res = await request.get('/api/brand/orders', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand can list agencies', async ({ request }) => {
    const res = await request.get('/api/brand/agencies', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });

  test('brand can view inventory fill stats', async ({ request }) => {
    const res = await request.get('/api/brand/inventory-fill', {
      headers: authHeaders(brandToken),
    });
    expect(res.ok()).toBeTruthy();
  });
});
