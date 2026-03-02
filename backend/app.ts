import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';

import type { Env } from './config/env.js';
import { parseCorsOrigins } from './config/env.js';
import { httpLog, logEvent } from './config/logger.js';
import { logSecurityIncident, logPerformance } from './config/appLogs.js';
import { healthRoutes } from './routes/healthRoutes.js';
import { authRoutes } from './routes/authRoutes.js';
import { adminRoutes } from './routes/adminRoutes.js';
import { opsRoutes } from './routes/opsRoutes.js';
import { productsRoutes } from './routes/productsRoutes.js';
import { aiRoutes } from './routes/aiRoutes.js';
import { sheetsRoutes } from './routes/sheetsRoutes.js';
import { googleRoutes } from './routes/googleRoutes.js';
import { ordersRoutes } from './routes/ordersRoutes.js';
import { ticketsRoutes } from './routes/ticketsRoutes.js';
import { brandRoutes } from './routes/brandRoutes.js';
import { notificationsRoutes } from './routes/notificationsRoutes.js';
import { realtimeRoutes } from './routes/realtimeRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { securityAuditMiddleware, responseTimingMiddleware } from './middleware/security.js';
import { mediaRoutes } from './routes/mediaRoutes.js';
import { initAiServiceConfig } from './services/aiService.js';

// Pre-compiled CORS wildcard matchers — built once at startup, not per-request.
type CorsMatcher = (origin: string, host: string) => boolean;
const corsMatcherCache = new Map<string, CorsMatcher[]>();

function buildCorsMatchers(allowed: string[]): CorsMatcher[] {
  const key = allowed.join(',');
  if (corsMatcherCache.has(key)) return corsMatcherCache.get(key)!;

  const matchers: CorsMatcher[] = [];

  for (const entryRaw of allowed) {
    const entry = String(entryRaw || '').trim();
    if (!entry) { matchers.push(() => false); continue; }

    // Exact match (full origin string).
    if (!entry.includes('*') && (entry.startsWith('http://') || entry.startsWith('https://'))) {
      matchers.push((origin: string) => entry === origin);

      // Auto-allow Vercel preview/branch deployments.
      // e.g. https://mobobrand.vercel.app → also allow
      //      https://mobobrand-git-*-*.vercel.app
      //      https://mobobrand-*-*.vercel.app
      const vercelMatch = entry.match(/^(https?):\/\/([a-z0-9-]+)\.vercel\.app$/);
      if (vercelMatch) {
        const proto = vercelMatch[1];
        const slug = vercelMatch[2];
        const previewRe = new RegExp(`^${proto}://${slug}(-[a-z0-9-]+)?\\.vercel\\.app$`);
        matchers.push((origin: string) => previewRe.test(origin));
      }
      continue;
    }

    // Wildcard — pre-compile regex once.
    if (entry.includes('*')) {
      const escaped = entry
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      const re = new RegExp(`^${escaped}$`);
      matchers.push((origin: string, host: string) => re.test(origin) || re.test(host));
      continue;
    }

    // Hostname suffix match.
    if (entry.startsWith('.')) {
      matchers.push((_origin: string, host: string) => host.endsWith(entry));
      continue;
    }

    // Hostname exact match.
    matchers.push((_origin: string, host: string) => host === entry);
  }

  corsMatcherCache.set(key, matchers);
  return matchers;
}

function isOriginAllowed(origin: string, allowed: string[]): boolean {
  if (!origin) return true;
  if (!allowed.length) return true;
  if (allowed.includes('*')) return true;

  let originUrl: URL | null = null;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const originHost = originUrl.hostname;
  const matchers = buildCorsMatchers(allowed);
  return matchers.some((m) => m(origin, originHost));
}

// ── In-flight request tracking (for graceful shutdown drain) ─────
let inFlightRequests = 0;
let drainResolve: (() => void) | null = null;

export function getInFlightCount() { return inFlightRequests; }

export function waitForDrain(timeoutMs: number): Promise<void> {
  if (inFlightRequests <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    drainResolve = resolve;
    setTimeout(resolve, timeoutMs);
  });
}

export function createApp(env: Env) {
  const app = express();

  // Sync AI service config from env (OCR pool size, circuit breaker thresholds)
  initAiServiceConfig(env);

  app.disable('x-powered-by');

  // Track in-flight requests for graceful shutdown draining.
  // Must be registered BEFORE routes so every request is counted.
  app.use((req, res, next) => {
    inFlightRequests++;
    res.on('close', () => {
      inFlightRequests--;
      if (inFlightRequests <= 0 && drainResolve) drainResolve();
    });
    next();
  });

  // Response timing headers for performance monitoring.
  app.use(responseTimingMiddleware());

  // Ensure every response carries a request identifier for log correlation.
  // Validate format to prevent log injection / CRLF attacks.
  const UUID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
  app.use((req, res, next) => {
    const provided = String(req.header('x-request-id') || '').trim();
    const requestId = provided && UUID_PATTERN.test(provided) ? provided : crypto.randomUUID();
    res.setHeader('x-request-id', requestId);
    res.locals.requestId = requestId;
    next();
  });

  // Most deployments run behind a reverse proxy (NGINX, load balancer).
  // This ensures `req.ip` and rate-limits behave correctly.
  app.set('trust proxy', 1);

  // Structured request logging via Winston with correlation ID propagation.
  // Silent in tests (Winston logger is configured to be silent in test mode).
  // GOD-LEVEL: Includes user journey context (userId, role) from auth middleware.
  const SLOW_REQUEST_THRESHOLD_MS = 3000;
  app.use((req, res, next) => {
    const start = Date.now();
    const requestId = String(res.locals.requestId || '');
    const correlationId = String(req.header('x-correlation-id') || requestId);
    res.locals.correlationId = correlationId;
    if (correlationId) res.setHeader('x-correlation-id', correlationId);

    res.on('finish', () => {
      const ms = Date.now() - start;
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

      // Auth context is available here because handlers have already executed.
      const userId = req.auth?.userId;
      const role = req.auth?.roles?.join(',');

      logEvent(level, `${req.method} ${req.originalUrl} -> ${status}`, {
        domain: 'http',
        eventName: 'REQUEST_COMPLETED',
        requestId,
        correlationId,
        method: req.method,
        route: req.originalUrl,
        statusCode: status,
        duration: ms,
        ip: req.ip,
        userId,
        role,
        metadata: {
          userAgent: req.get('user-agent'),
          contentLength: res.get('content-length'),
        },
      });

      // NOTE: Per-endpoint access events are logged in each controller handler
      // with rich journey context (action, metadata). No duplicate middleware
      // access log needed here — the REQUEST_COMPLETED event above covers
      // HTTP telemetry.

      // Performance tracking for slow requests
      if (ms > SLOW_REQUEST_THRESHOLD_MS) {
        httpLog.warn(`Slow request detected: ${req.method} ${req.originalUrl} took ${ms}ms`, {
          requestId,
          correlationId,
          durationMs: ms,
          threshold: SLOW_REQUEST_THRESHOLD_MS,
        });
        logPerformance({
          operation: `${req.method} ${req.originalUrl}`,
          durationMs: ms,
          slowThresholdMs: SLOW_REQUEST_THRESHOLD_MS,
          metadata: { userId, role, statusCode: status, ip: req.ip },
        });
      }
    });
    next();
  });
  // Helmet defaults are good, but for an API service we explicitly:
  // - disable CSP (frontends are served separately)
  // - only enable HSTS in production
  // - enforce strict referrer policy
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );
  // Permissions-Policy: restrict sensitive browser APIs (not part of Helmet types)
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Prevent intermediary caches from storing sensitive API responses.
    // Individual routes (e.g. public product listings) can override this.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  // ── Compression ────────────────────────────────────────────────
  // Gzip responses >1 KB for ~3-5x size reduction on JSON payloads.
  // Skip SSE streams (realtime) — they use chunked transfer encoding.
  app.use(compression({
    threshold: 1024,
    level: 6,
    filter: (req, res) => {
      if (req.path.startsWith('/api/realtime/')) return false;
      return compression.filter(req, res);
    },
  }));

  // ── Request timeout ────────────────────────────────────────────────
  // Prevents hung handlers from holding connections indefinitely.
  // This is a safety net — individual routes can set shorter timeouts.
  const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30_000;
  app.use((req, res, next) => {
    // Skip SSE streams — they're intentionally long-lived.
    if (req.path.startsWith('/api/realtime/')) return next();
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        httpLog.warn('Request timeout', {
          method: req.method,
          path: req.originalUrl,
          timeoutMs: REQUEST_TIMEOUT_MS,
          ip: req.ip,
        });
        res.status(504).json({
          error: { code: 'GATEWAY_TIMEOUT', message: 'The request took too long. Please try again.' },
        });
      }
    }, REQUEST_TIMEOUT_MS);
    // Don't prevent process exit.
    timer.unref();
    res.on('close', () => clearTimeout(timer));
    next();
  });

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: env.NODE_ENV === 'production' ? 300 : 10_000,
      standardHeaders: true,
      legacyHeaders: false,
      // Exempt SSE stream from rate limit — it's a single long-lived connection.
      skip: (req) => req.path === '/api/realtime/stream' || req.path === '/api/realtime/health',
      handler: (_req, res) => {
        httpLog.warn('Rate limit exceeded', { ip: _req.ip });
        logSecurityIncident('RATE_LIMIT_HIT', {
          severity: 'medium',
          ip: _req.ip,
          route: _req.originalUrl,
          method: _req.method,
          requestId: String(res.locals.requestId || ''),
        });
        res.setHeader('Retry-After', '60');
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
        });
      },
    })
  );

  // Stricter limiter for authentication endpoints to reduce brute-force risk.
  const authLimiter = rateLimit({
    windowMs: 5 * 60_000,
    limit: env.NODE_ENV === 'production' ? 30 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.setHeader('Retry-After', '300');
      res.status(429).json({
        error: { code: 'AUTH_RATE_LIMITED', message: 'Too many login attempts. Please wait a few minutes and try again.' },
      });
    },
  });

  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);

  // If a request presents an Origin header and it is not allowed, fail closed.
  // This complements the CORS middleware (which otherwise may simply omit headers
  // while still allowing the request to be processed server-side).
  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin && !isOriginAllowed(origin, corsOrigins)) {
      logSecurityIncident('CORS_VIOLATION', {
        severity: 'medium',
        ip: req.ip,
        route: req.originalUrl,
        method: req.method,
        requestId: String(res.locals.requestId || ''),
        metadata: { origin },
      });
      return res.status(403).json({
        error: 'origin_not_allowed',
      });
    }
    next();
  });
  app.use(
    cors({
      origin: (origin, cb) => cb(null, isOriginAllowed(String(origin || ''), corsOrigins)),
      credentials: true,
      optionsSuccessStatus: 204,
    })
  );

  // Skip body parsers for SSE stream — no request body and parsers can interfere
  // with long-lived streaming connections (a common cause of 400 errors on SSE).
  const skipBodyParser = (req: express.Request) =>
    req.path.startsWith('/api/realtime/');
  app.use((req, res, next) => {
    if (skipBodyParser(req)) return next();
    express.json({ limit: env.REQUEST_BODY_LIMIT })(req, res, next);
  });
  app.use((req, res, next) => {
    if (skipBodyParser(req)) return next();
    express.urlencoded({ extended: false, limit: env.REQUEST_BODY_LIMIT })(req, res, next);
  });

  // Security audit: log and block suspicious patterns in requests (after body parsing).
  // Active in all environments for defense-in-depth.
  app.use(securityAuditMiddleware());

  app.use('/api', healthRoutes(env));
  app.use('/api/auth', authLimiter, authRoutes(env));
  app.use('/api/admin', adminRoutes(env));
  app.use('/api/ops', opsRoutes(env));
  app.use('/api/brand', brandRoutes(env));
  app.use('/api', productsRoutes(env));
  app.use('/api', ordersRoutes(env));
  app.use('/api', ticketsRoutes(env));
  app.use('/api/notifications', notificationsRoutes(env));
  app.use('/api/realtime', realtimeRoutes(env));
  app.use('/api', mediaRoutes(env));
  app.use('/api/ai', aiRoutes(env));
  app.use('/api/sheets', sheetsRoutes(env));
  app.use('/api/google', googleRoutes(env));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
