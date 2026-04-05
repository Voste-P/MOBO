import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Env } from '../config/env.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';
import { makeOrdersController } from '../controllers/ordersController.js';
import { prisma } from '../database/prisma.js';
import { idWhere } from '../utils/idWhere.js';
import { logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { businessLog } from '../config/logger.js';

export function ordersRoutes(env: Env): Router {
  const router = Router();
  const orders = makeOrdersController(env);

  // Rate limit for authenticated order endpoints to prevent abuse
  const orderWriteLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === 'production' ? 30 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Authorization middleware: ensure users can only access their own orders
  // Only admin/ops are truly privileged; other roles are checked in the controller
  const ownerOrPrivileged = (req: any, res: any, next: any) => {
    const requestedUserId = req.params.userId;
    const auth = req.auth;
    const roles: string[] = auth?.roles ?? [];
    const isPrivileged = roles.some((r: string) => ['admin', 'ops'].includes(r));
    // requestedUserId is the PG UUID.
    const isOwner = auth?.userId === requestedUserId
      || auth?.pgUserId === requestedUserId
      ;
    if (!isPrivileged && !isOwner) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
    next();
  };

  // UI expects these endpoints to exist.
  router.get('/orders/user/:userId', requireAuth(env), ownerOrPrivileged, orders.getUserOrders);
  router.post('/orders', requireAuth(env), orderWriteLimiter, orders.createOrder);
  router.post('/orders/claim', requireAuth(env), requireRoles('shopper'), orderWriteLimiter, orders.submitClaim);
  router.patch('/orders/:orderId/reviewer-name', requireAuth(env), orderWriteLimiter, orders.setReviewerName);
  // Rate limit proof retrieval to prevent brute-force enumeration
  const proofReadLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === 'production' ? 60 : 5000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => String(req.auth?.userId || req.ip || 'unknown'),
  });

  router.get('/orders/:orderId/proof/:type', requireAuth(env), proofReadLimiter, (_req, res, next) => {
    // Proof screenshots are immutable once uploaded — cache aggressively
    res.setHeader('Cache-Control', 'private, max-age=3600, immutable');
    next();
  }, orders.getOrderProof);

  // Signed proof URL generation (authenticated — used by CSV/Excel export)
  router.get('/orders/:orderId/proof-urls', requireAuth(env), orders.getSignedProofUrls);
  router.post('/orders/proof-urls/batch', requireAuth(env), orders.batchSignedProofUrls);

  // Public signed proof endpoint — validates HMAC token, no auth needed.
  // Used by Excel/Google Sheets HYPERLINK formulas.
  const signedProofLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.NODE_ENV === 'production' ? 120 : 5000,
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.get('/orders/proof/signed/:token', signedProofLimiter, (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, max-age=3600, immutable');
    next();
  }, orders.getProofBySigned);

  // Public proof endpoint removed — use authenticated or signed endpoint above.
  // Old: router.get('/public/orders/:orderId/proof/:type', publicProofLimiter, orders.getOrderProofPublic);

  // Audit trail for a specific order — privileged roles or the order owner (buyer)
  // Agency/mediator users are scoped to orders within their lineage.
  router.get('/orders/:orderId/audit', requireAuth(env), async (req, res, next) => {
    try {
      const roles: string[] = (req as any).auth?.roles ?? [];
      const userId: string = (req as any).auth?.userId ?? '';
      const isAdmin = roles.some((r: string) => ['admin', 'ops'].includes(r));

      const orderId = String(req.params.orderId);

      // Everyone except admin/ops must pass ownership checks
      if (!isAdmin) {
        const db = prisma();
        // Fetch order and requesting user in parallel — single DB round-trip each
        const [order, reqUser] = await Promise.all([
          db.order.findFirst({
            where: idWhere(orderId),
            select: { id: true, userId: true, brandUserId: true, brandName: true, agencyName: true, managerName: true },
          }),
          db.user.findFirst({
            where: idWhere(userId),
            select: { id: true, name: true, mediatorCode: true },
          }),
        ]);
        if (!order) {
          return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
        }

        let allowed = false;

        if (roles.includes('shopper')) {
          allowed = !!reqUser && order.userId === reqUser.id;
        }

        if (!allowed && roles.includes('brand')) {
          const sameBrandId = !!reqUser && (order.brandUserId === reqUser.id || order.brandUserId === userId);
          const sameBrandName = !!reqUser?.name && String(order.brandName || '').trim() === String(reqUser.name || '').trim();
          allowed = sameBrandId || sameBrandName;
        }

        if (!allowed && roles.includes('agency')) {
          const agencyName = String(reqUser?.name || '').trim();
          const agencyCode = String(reqUser?.mediatorCode || '').trim();
          if (agencyName && String(order.agencyName || '').trim() === agencyName) {
            allowed = true;
          } else if (agencyCode && order.managerName) {
            const mediator = await db.user.findFirst({
              where: {
                roles: { has: 'mediator' },
                mediatorCode: String(order.managerName).trim(),
                parentCode: agencyCode,
                isDeleted: false,
              },
              select: { id: true },
            });
            allowed = !!mediator;
          }
        }

        if (!allowed && roles.includes('mediator')) {
          const mediatorCode = String(reqUser?.mediatorCode || '').trim();
          allowed = !!mediatorCode && String(order.managerName || '').trim() === mediatorCode;
        }

        if (!allowed) {
          return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient role for audit access' } });
        }
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const skip = (page - 1) * limit;

      const db = prisma();

      // Fetch AuditLog entries for this order from PG
      const logs = await db.auditLog.findMany({
        where: { entityType: 'Order', entityId: orderId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      });

      // Also return inline order.events for a combined timeline
      const orderDoc = await db.order.findFirst({
        where: idWhere(orderId),
        select: { events: true },
      });
      const events = Array.isArray((orderDoc as any)?.events) ? (orderDoc as any).events : [];

      res.json({ logs, events, page, limit });

      businessLog.info(`[${String(roles?.[0] || 'User').charAt(0).toUpperCase() + String(roles?.[0] || 'User').slice(1)}] User ${userId} viewed audit trail — order ${String(req.params.orderId)}, ${logs.length} logs, ${events.length} events`, { actorUserId: userId, orderId: String(req.params.orderId), logCount: logs.length, eventCount: events.length, ip: req.ip });
      logAccessEvent('RESOURCE_ACCESS', {
        userId,
        roles,
        ip: req.ip,
        resource: 'OrderAudit',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'AUDIT_TRAIL_VIEWED', orderId: String(req.params.orderId), logCount: logs.length, eventCount: events.length },
      });
    } catch (err) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: (req as any).auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'orders/audit' } });
      next(err);
    }
  });

  return router;
}
