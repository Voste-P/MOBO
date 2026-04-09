import { test, expect } from '@playwright/test';

test.describe('Media proxy & SSRF protection API', () => {
  // ── Valid image proxy ─────────────────────────────────────────
  test('media proxy returns image for valid URL', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: 'https://via.placeholder.com/1x1.png' },
    });
    // May succeed (200) or fail based on network — should not 500
    expect(res.status()).toBeLessThan(500);
  });

  // ── SSRF protection: reject private IPs ───────────────────────
  test('media proxy blocks localhost URLs', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: 'http://127.0.0.1/secret' },
    });
    expect([400, 403]).toContain(res.status());
  });

  test('media proxy blocks 10.x.x.x URLs', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: 'http://10.0.0.1/internal' },
    });
    expect([400, 403]).toContain(res.status());
  });

  test('media proxy blocks 192.168.x.x URLs', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: 'http://192.168.1.1/admin' },
    });
    expect([400, 403]).toContain(res.status());
  });

  test('media proxy blocks 169.254.x.x metadata URLs', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect([400, 403]).toContain(res.status());
  });

  // ── Protocol validation ───────────────────────────────────────
  test('media proxy blocks file:// protocol', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: 'file:///etc/passwd' },
    });
    expect([400, 403]).toContain(res.status());
  });

  test('media proxy blocks ftp:// protocol', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: 'ftp://attacker.com/malicious' },
    });
    expect([400, 403]).toContain(res.status());
  });

  // ── Missing URL parameter ─────────────────────────────────────
  test('media proxy rejects missing url param', async ({ request }) => {
    const res = await request.get('/api/media/image');
    expect([400, 422]).toContain(res.status());
  });

  // ── Empty URL parameter ───────────────────────────────────────
  test('media proxy rejects empty url', async ({ request }) => {
    const res = await request.get('/api/media/image', {
      params: { url: '' },
    });
    expect([400, 422]).toContain(res.status());
  });
});
