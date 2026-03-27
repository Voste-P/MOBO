import { test, expect } from '@playwright/test';
import { loginAndGetAccessToken } from '../helpers/auth';
import { E2E_ACCOUNTS } from '../helpers/accounts';

test('admin realtime stream is ready', async ({ page, request }) => {
  const { accessToken } = await loginAndGetAccessToken(request, {
    username: E2E_ACCOUNTS.admin.username,
    password: E2E_ACCOUNTS.admin.password,
  });

  await page.goto('/');

  const result = await page.evaluate(async (token) => {
    const res = await fetch('/api/realtime/stream', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: text.slice(0, 300) };
    }

    const reader = res.body?.getReader();
    if (!reader) return { ok: false, status: res.status, detail: 'Missing response body reader' };

    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const deadline = Date.now() + 4_000;

    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('event: ready')) {
          return { ok: true, status: res.status };
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    return { ok: false, status: res.status, detail: 'Timed out waiting for SSE ready event' };
  }, accessToken);

  expect(result.ok, result.detail || 'Realtime stream check failed').toBeTruthy();
});
