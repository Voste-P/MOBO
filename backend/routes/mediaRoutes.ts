import { Router } from 'express';
import type { Env } from '../config/env.js';
import { logSecurityIncident, logErrorEvent, logPerformance } from '../config/appLogs.js';
import logger from '../config/logger.js';

const mediaLog = logger.child({ service: 'media-proxy' });
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Simple per-IP rate limiter for the public image proxy.
 * Allows `MAX_REQUESTS` requests per `WINDOW_MS` window per IP.
 */
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX_REQUESTS = 120; // generous limit for pages with many product cards
const RATE_MAX_IPS = 10_000; // cap tracked IPs to prevent unbounded memory
const ipHits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now >= entry.resetAt) {
    // Evict oldest entries if map is at capacity
    if (!entry && ipHits.size >= RATE_MAX_IPS) {
      const first = ipHits.keys().next().value;
      if (first !== undefined) ipHits.delete(first);
    }
    ipHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX_REQUESTS;
}

// Periodically clean up stale entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipHits) {
    if (now >= entry.resetAt) ipHits.delete(ip);
  }
}, RATE_WINDOW_MS * 2).unref();

/** Block requests to private / link-local / loopback addresses (SSRF protection). */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // Loopback
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return true;
  // Block encoded forms of loopback (e.g. 0x7f000001, 0177.0.0.1)
  if (/^0[xo]/.test(h) || /^\d+$/.test(h)) return true;
  // IPv6 private / link-local ranges
  if (h.startsWith('[')) {
    const inner = h.slice(1, -1);
    // fc00::/7 (unique local), fe80::/10 (link-local), ::1 (loopback)
    if (/^f[cd]/i.test(inner) || /^fe[89ab]/i.test(inner) || inner === '::1') return true;
  }
  // RFC-1918 / link-local / metadata (IPv4)
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // AWS metadata etc.
    if (parts[0] === 127) return true; // entire 127.0.0.0/8
    if (parts[0] === 0) return true;
  }
  // Block cloud metadata hostnames
  if (h === 'metadata.google.internal' || h === 'metadata.google.com') return true;
  return false;
}

export function mediaRoutes(_env: Env): Router {
  const router = Router();

  // Public endpoint — <img src="..."> tags cannot send Authorization headers.
  // SSRF protection (isPrivateHost) + per-IP rate limiting keep this safe.
  router.get('/media/image', async (req, res) => {
    const start = Date.now();
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    if (isRateLimited(clientIp)) {
      logSecurityIncident('RATE_LIMIT_HIT', {
        severity: 'medium',
        ip: clientIp,
        metadata: { endpoint: '/media/image', window: RATE_WINDOW_MS, limit: RATE_MAX_REQUESTS },
      });
      res.set('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
      res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'rate limit exceeded' } });
      return;
    }
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'url required' } });
      return;
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid url' } });
      return;
    }

    if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
      logSecurityIncident('SUSPICIOUS_PATTERN', {
        severity: 'high',
        ip: clientIp,
        metadata: { endpoint: '/media/image', reason: 'invalid_protocol', protocol: target.protocol, url: rawUrl },
      });
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid protocol' } });
      return;
    }

    if (isPrivateHost(target.hostname)) {
      logSecurityIncident('SUSPICIOUS_PATTERN', {
        severity: 'critical',
        ip: clientIp,
        metadata: { endpoint: '/media/image', reason: 'ssrf_blocked', hostname: target.hostname, url: rawUrl },
      });
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'private addresses not allowed' } });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      // Follow redirects safely: validate each hop against SSRF blocklist.
      // Amazon/Flipkart/Myntra images use 301/302 redirects heavily —
      // blocking redirects breaks every product image.
      const MAX_REDIRECTS = 5;
      let currentUrl = target.toString();

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',   // validate each hop
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            Referer: new URL(currentUrl).origin + '/',
          },
        });

        // Follow redirect: validate the target is safe
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) { res.status(404).end(); return; }
          try {
            const redirectTarget = new URL(location, currentUrl);
            if (!ALLOWED_PROTOCOLS.has(redirectTarget.protocol) || isPrivateHost(redirectTarget.hostname)) {
              logSecurityIncident('SUSPICIOUS_PATTERN', {
                severity: 'critical',
                ip: clientIp,
                metadata: { endpoint: '/media/image', reason: 'unsafe_redirect', from: currentUrl, to: location },
              });
              res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'unsafe redirect target' } });
              return;
            }
            currentUrl = redirectTarget.toString();
            continue; // follow the redirect
          } catch {
            res.status(404).end();
            return;
          }
        }

        if (!response.ok || !response.body) {
          res.status(404).end();
          return;
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength && contentLength > MAX_IMAGE_BYTES) {
          res.status(413).end();
          return;
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
          res.status(413).end();
          return;
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        res.setHeader('Vary', 'Accept');
        res.send(Buffer.from(arrayBuffer));

        logPerformance({
          operation: 'image-proxy',
          durationMs: Date.now() - start,
          metadata: { host: target.hostname, bytes: arrayBuffer.byteLength, contentType, hops: hop },
        });
        return;
      }

      // Exceeded maximum redirects
      logErrorEvent({ category: 'EXTERNAL_SERVICE', severity: 'medium', message: 'Image proxy exceeded max redirects', operation: 'image-proxy', error: 'too_many_redirects', metadata: { url: rawUrl, hops: MAX_REDIRECTS } });
      res.status(502).json({ error: { code: 'TOO_MANY_REDIRECTS', message: 'redirect chain too long' } });
    } catch (err) {
      mediaLog.debug('[media/image] proxy fetch failed', { url: rawUrl, error: String(err) });
      res.status(404).end();
    } finally {
      clearTimeout(timeout);
    }
  });

  return router;
}
