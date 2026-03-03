import { Router } from 'express';

import type { Env } from '../config/env.js';
import { prisma, isPrismaAvailable, pingPg } from '../database/prisma.js';
import { isReady } from '../config/lifecycle.js';
import { logAvailabilityEvent } from '../config/appLogs.js';

// Build-time metadata — injected via env or fallback to runtime values.
const BUILD_SHA = process.env.GIT_SHA || 'unknown';
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();

async function isHttpOk(url: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function hasE2EUsers(): Promise<boolean> {
  const requiredMobiles = ['9000000000', '9000000001', '9000000002', '9000000003', '9000000004', '9000000005'];

  if (isPrismaAvailable()) {
    try {
      const count = await prisma().user.count({
        where: { mobile: { in: requiredMobiles }, isDeleted: false },
      });
      if (count >= requiredMobiles.length) return true;
    } catch {
      return false;
    }
  }

  return false;
}

export function healthRoutes(env: Env): Router {
  const router = Router();

  // ── Liveness probe (/health/live) ────────────────────────────────
  // Returns 200 if the process is alive. No I/O — cannot hang.
  // K8s: livenessProbe → if this fails, container is restarted.
  router.get('/health/live', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.status(200).json({ status: 'alive' });
  });

  // ── Readiness probe (/health/ready) ──────────────────────────────
  // Returns 200 only when the server is fully initialized AND the DB is connected.
  // K8s: readinessProbe → if this fails, pod is removed from service endpoints.
  router.get('/health/ready', async (_req, res) => {
    const pgOk = isReady && await pingPg();
    if (!pgOk) {
      logAvailabilityEvent('HEALTH_CHECK_FAIL', {
        component: 'readiness-probe',
        status: 'degraded',
        metadata: { server: isReady ? 'up' : 'starting', database: pgOk ? 'connected' : 'disconnected' },
      });
    }
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.status(pgOk ? 200 : 503).json({
      status: pgOk ? 'ready' : 'not_ready',
      checks: {
        server: isReady ? 'up' : 'starting',
        database: pgOk ? 'connected' : 'disconnected',
      },
    });
  });

  // ── Full health (/health) — detailed for dashboards ──────────────
  router.get('/health', async (req, res) => {
    const pgOk = await pingPg();
    const uptimeSec = Math.floor(process.uptime());
    const mem = process.memoryUsage();
    const memMB = Math.round(mem.rss / 1024 / 1024);

    // Only expose internal diagnostics to admin/ops tokens or local requests.
    const isPrivileged = (req as any).auth?.roles?.some?.((r: string) => r === 'admin' || r === 'ops');
    const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

    const base = {
      status: pgOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      database: { status: pgOk ? 'connected' : 'disconnected' },
    };

    // Public callers get minimal info — no PID, node version, memory.
    if (!isPrivileged && !isLocal) {
      res.status(pgOk ? 200 : 503).json(base);
      return;
    }

    res.status(pgOk ? 200 : 503).json({
      ...base,
      version: BUILD_SHA,
      buildTime: BUILD_TIME,
      uptime: uptimeSec,
      memoryMB: memMB,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      pid: process.pid,
      nodeVersion: process.version,
    });
  });

  // ── E2E readiness (dev/test only) ────────────────────────────────
  router.get('/health/e2e', async (_req, res) => {
    if (env.NODE_ENV === 'production') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      const pgOk = await pingPg();
      const dbOk = pgOk;

      const portals = [
        { name: 'buyer', url: 'http://127.0.0.1:3001/' },
        { name: 'mediator', url: 'http://127.0.0.1:3002/' },
        { name: 'agency', url: 'http://127.0.0.1:3003/' },
        { name: 'brand', url: 'http://127.0.0.1:3004/' },
        { name: 'admin', url: 'http://127.0.0.1:3005/' },
      ];

      const [buyerOk, mediatorOk, agencyOk, brandOk, adminOk] = await Promise.all(
        portals.map((p) => isHttpOk(p.url))
      );

      const e2eUsersOk = env.NODE_ENV === 'test' ? await hasE2EUsers() : true;

      const allOk = dbOk && buyerOk && mediatorOk && agencyOk && brandOk && adminOk && e2eUsersOk;

      res.status(allOk ? 200 : 503).json({
        status: allOk ? 'ok' : 'starting',
        database: { ok: dbOk, postgres: pgOk },
        seed: { e2eUsersOk },
        portals: {
          buyer: buyerOk,
          mediator: mediatorOk,
          agency: agencyOk,
          brand: brandOk,
          admin: adminOk,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logAvailabilityEvent('HEALTH_CHECK_FAIL', {
        component: 'e2e-readiness',
        status: 'down',
        metadata: { error: String(err) },
      });
      res.status(503).json({ status: 'error', message: String(err) });
    }
  });
  return router;
}
