import { Router } from 'express';
import type { Env } from '../config/env.js';
import type { Role } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { subscribeRealtime, type RealtimeEvent } from '../services/realtimeHub.js';
import { realtimeLog } from '../config/logger.js';
import { logAccessEvent, logPerformance, logErrorEvent } from '../config/appLogs.js';

function writeSse(res: any, evt: { event: string; data?: any }): boolean {
  // Never throw from a realtime emitter callback.
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${evt.event}\n`);
    if (typeof evt.data !== 'undefined') {
      const payload = typeof evt.data === 'string' ? evt.data : JSON.stringify(evt.data);
      // SSE allows multi-line data; keep it single-line JSON.
      res.write(`data: ${payload}\n`);
    }
    res.write('\n');
    // If the runtime supports it, flush bytes immediately.
    if (typeof (res as any).flush === 'function') (res as any).flush();
    return true;
  } catch {
    return false;
  }
}

function shouldDeliver(evt: RealtimeEvent, ctx: { userId: string; roles: Role[]; mediatorCode?: string; parentCode?: string; brandCode?: string }): boolean {
  const aud = evt.audience;
  // Fail closed: realtime events must declare an explicit audience.
  // Use { audience: { broadcast: true } } for broadcasts.
  if (!aud) return false;
  if (aud.broadcast) return true;
  if (Array.isArray(aud.userIds) && aud.userIds.includes(ctx.userId)) return true;
  if (Array.isArray(aud.roles) && aud.roles.some((r) => ctx.roles.includes(r))) return true;

  // Multi-tenant audience targeting by code fields — use pre-normalised Sets for O(1) lookups
  const mediatorCodeNorm = (ctx.mediatorCode || '').trim().toLowerCase();
  const parentCodeNorm = (ctx.parentCode || '').trim().toLowerCase();
  const brandCodeNorm = (ctx.brandCode || '').trim().toLowerCase();

  if (mediatorCodeNorm && ctx.roles.includes('agency') && aud._agencySet?.has(mediatorCodeNorm)) return true;
  if (mediatorCodeNorm && ctx.roles.includes('mediator') && aud._mediatorSet?.has(mediatorCodeNorm)) return true;
  if (brandCodeNorm && ctx.roles.includes('brand') && aud._brandSet?.has(brandCodeNorm)) return true;
  if (parentCodeNorm && aud._parentSet?.has(parentCodeNorm)) return true;

  return false;
}

export function realtimeRoutes(env: Env) {
  const r = Router();

  /** Per-user SSE connection tracker — prevents a single user from exhausting server resources. */
  const userConnections = new Map<string, number>();
  const MAX_SSE_PER_USER = 5;

  // Lightweight health check for the realtime subsystem.
  // Does not require auth and does not open a long-lived SSE stream.
  r.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', transport: 'sse' });
  });

  // Streaming endpoint for realtime UI updates.
  // Auth is via standard Bearer token header (same as REST routes).
  r.get('/stream', requireAuth(env), (req, res) => {
    const requestId = String((res.locals as any)?.requestId || res.getHeader?.('x-request-id') || '').trim();

    // Avoid proxy / load balancer / Node defaults closing the connection.
    try {
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).setTimeout?.(0);
    } catch {
      // ignore
    }

    // Important headers for SSE.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    // Some proxies buffer by default.
    res.setHeader('X-Accel-Buffering', 'no');
    // Allow CORS credentials for SSE (browsers enforce this).
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Flush headers if supported (depends on runtime).
    if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

    const userId = String(req.auth?.userId || '');
    const roles = (req.auth?.roles || []) as Role[];
    const mediatorCode = String((req.auth?.user as any)?.mediatorCode || '').trim();
    const parentCode = String((req.auth?.user as any)?.parentCode || '').trim();
    const brandCode = String((req.auth?.user as any)?.brandCode || '').trim();

    // Enforce per-user connection limit to prevent resource exhaustion
    const currentCount = userConnections.get(userId) || 0;
    if (currentCount >= MAX_SSE_PER_USER) {
      realtimeLog.warn('SSE per-user limit reached', { userId, currentCount });
      res.status(429).json({ error: 'Too many SSE connections' });
      return;
    }
    userConnections.set(userId, currentCount + 1);

    realtimeLog.info('SSE stream opened', { requestId, userId, roles });

    logAccessEvent('RESOURCE_ACCESS', {
      userId,
      roles,
      ip: req.ip,
      resource: 'SSE_STREAM',
      requestId,
      metadata: { action: 'connect', mediatorCode, brandCode },
    });

    let cleaned = false;
    let ping: ReturnType<typeof setInterval> | null = null;
    let maxLifetimeTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let eventsDelivered = 0;
    const streamStart = Date.now();

    // Maximum stream lifetime: 4 hours. Forces client to reconnect,
    // preventing indefinite connections from exhausting server resources.
    const MAX_STREAM_LIFETIME_MS = 4 * 60 * 60 * 1000;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (ping) clearInterval(ping);
      } catch {
        // ignore
      }
      try {
        if (maxLifetimeTimer) clearTimeout(maxLifetimeTimer);
      } catch {
        // ignore
      }
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
      try {
        if (!res.writableEnded) res.end();
      } catch {
        // ignore
      }
      // Decrement per-user connection count
      const remaining = (userConnections.get(userId) || 1) - 1;
      if (remaining <= 0) userConnections.delete(userId);
      else userConnections.set(userId, remaining);

      realtimeLog.info('SSE stream closed', { requestId, userId, eventsDelivered });

      logPerformance({
        operation: 'sse-stream',
        durationMs: Date.now() - streamStart,
        metadata: { userId, eventsDelivered, requestId },
      });
    };

    // Initial handshake.
    try {
      res.write(': connected\n\n');
      if (typeof (res as any).flush === 'function') (res as any).flush();
    } catch (err) {
      logErrorEvent({
        message: 'SSE handshake failed',
        category: 'NETWORK',
        error: err instanceof Error ? err : new Error(String(err)),
        severity: 'medium',
        metadata: { userId, requestId },
      });
      cleanup();
      return;
    }

    if (!writeSse(res, { event: 'ready', data: { ts: new Date().toISOString() } })) {
      cleanup();
      return;
    }

    unsubscribe = subscribeRealtime((evt) => {
      if (!shouldDeliver(evt, { userId, roles, mediatorCode, parentCode, brandCode })) return;
      const ok = writeSse(res, { event: evt.type, data: { ts: evt.ts, payload: evt.payload } });
      if (ok) {
        eventsDelivered++;
      } else {
        cleanup();
      }
    });

    // Keepalive ping so intermediaries don’t close idle connections.
    ping = setInterval(() => {
      if (!writeSse(res, { event: 'ping', data: { ts: new Date().toISOString() } })) {
        cleanup();
      }
    }, 25_000);
    // Close the stream after the maximum lifetime.
    // The client should auto-reconnect via EventSource.
    maxLifetimeTimer = setTimeout(() => {
      realtimeLog.info('SSE stream max lifetime reached', { requestId, userId });
      writeSse(res, { event: 'reconnect', data: { reason: 'max_lifetime' } });
      cleanup();
    }, MAX_STREAM_LIFETIME_MS);
    maxLifetimeTimer.unref();
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  return r;
}
