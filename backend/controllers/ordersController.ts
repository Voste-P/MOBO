import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { prisma as db } from '../database/prisma.js';
import { orderLog, businessLog } from '../config/logger.js';
import { logChangeEvent, logAccessEvent, logPerformance, logErrorEvent } from '../config/appLogs.js';
import { pgOrder } from '../utils/pgMappers.js';
import { createOrderSchema, submitClaimSchema } from '../validations/orders.js';
import { rupeesToPaise } from '../utils/money.js';
import { toUiOrder, toUiOrderSummary } from '../utils/uiMappers.js';
import { orderListSelectLite, orderProofSelect, getProofFlags } from '../utils/querySelect.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { pushOrderEvent, isTerminalAffiliateStatus } from '../services/orderEvents.js';
import { transitionOrderWorkflow } from '../services/orderWorkflow.js';
import type { Role } from '../middleware/auth.js';
import { publishRealtime } from '../services/realtimeHub.js';
import { getRequester, isPrivileged } from '../services/authz.js';
import { isGeminiConfigured, verifyProofWithAi, verifyRatingScreenshotWithAi, verifyReturnWindowWithAi } from '../services/aiService.js';
import { finalizeApprovalIfReady } from './opsController.js';
import { createProofToken, verifyProofToken } from '../utils/signedProofUrl.js';

// UUID v4 regex — 8-4-4-4-12 hex with dashes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { writeAuditLog } from '../services/audit.js';

export function makeOrdersController(env: Env) {
  const MAX_PROOF_BYTES = 50 * 1024 * 1024;
  const MIN_PROOF_BYTES = (env.NODE_ENV !== 'production') ? 1 : 10 * 1024;

  const getDataUrlByteSize = (raw: string) => {
    const match = String(raw || '').match(/^data:[^;]+;base64,(.+)$/i);
    if (!match) return 0;
    const base64 = match[1] || '';
    return Math.floor((base64.length * 3) / 4);
  };

  const assertProofImageSize = (raw: string, label: string) => {
    const size = getDataUrlByteSize(raw);
    if (!size || size < MIN_PROOF_BYTES) {
      throw new AppError(400, 'INVALID_PROOF_IMAGE', `${label} is too small or invalid.`);
    }
    if (size > MAX_PROOF_BYTES) {
      const limitMb = Math.round(MAX_PROOF_BYTES / (1024 * 1024));
      throw new AppError(400, 'PROOF_TOO_LARGE', `${label} exceeds ${limitMb}MB.`);
    }
  };
  const findOrderForProof = async (orderId: string) => {
    const isUuid = UUID_RE.test(orderId);
    // Single query with OR to cover id, mongoId, AND externalOrderId
    const where = isUuid
      ? { OR: [{ id: orderId }, { mongoId: orderId }, { externalOrderId: orderId }] as any, isDeleted: false }
      : { OR: [{ mongoId: orderId }, { externalOrderId: orderId }] as any, isDeleted: false };
    const found = await db().order.findFirst({
      where: where as any,
      select: orderProofSelect,
    });
    return found ? pgOrder(found) : null;
  };
  const resolveProofValue = (order: any, proofType: string) => {
    if (proofType === 'order') return order.screenshots?.order || '';
    if (proofType === 'payment') return order.screenshots?.payment || '';
    if (proofType === 'rating') return order.screenshots?.rating || '';
    if (proofType === 'review') return order.reviewLink || order.screenshots?.review || '';
    if (proofType === 'returnwindow') return order.screenshots?.returnWindow || '';
    return '';
  };

  const sendProofResponse = (res: Response, rawValue: string) => {
    const raw = String(rawValue || '').trim();
    if (!raw) throw new AppError(404, 'PROOF_NOT_FOUND', 'Proof not found');

    if (/^https?:\/\//i.test(raw)) {
      // Return URL as JSON instead of redirecting (prevents open redirect via user-controlled data)
      res.json({ url: raw });
      return;
    }

    const dataMatch = raw.match(/^data:([^;]+);base64,(.+)$/i);
    if (dataMatch) {
      const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      const mime = ALLOWED_MIME.includes(dataMatch[1]?.toLowerCase() || '') ? dataMatch[1] : 'image/jpeg';
      const payload = dataMatch[2] || '';
      const buffer = Buffer.from(payload, 'base64');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', buffer.length.toString());
      res.send(buffer);
      return;
    }

    try {
      const buffer = Buffer.from(raw, 'base64');
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Length', buffer.length.toString());
      res.send(buffer);
    } catch {
      throw new AppError(415, 'UNSUPPORTED_PROOF_FORMAT', 'Unsupported proof format');
    }
  };

  /**
   * Auto-verify a proof step when AI confidence meets the auto-verify threshold.
   * Sets verification.{step}.verifiedAt, pushes AUTO_VERIFIED event, and calls
   * finalizeApprovalIfReady to potentially approve the entire order.
   */
  const autoVerifyStep = async (
    freshOrder: any,
    proofType: string,
    aiConfidence: number,
    threshold: number,
    envRef: Env,
  ): Promise<any> => {
    if (String(freshOrder.workflowStatus) !== 'UNDER_REVIEW') return freshOrder;
    if (aiConfidence < threshold) return freshOrder; // Below auto-verify threshold

    const v = (freshOrder.verification && typeof freshOrder.verification === 'object')
      ? { ...(freshOrder.verification as any) } : {} as any;

    // Determine the verification key: 'order' | 'rating' | 'review' | 'returnWindow'
    const vKey = proofType === 'order' ? 'order' : proofType;
    if (v[vKey]?.verifiedAt) return freshOrder; // already verified

    v[vKey] = v[vKey] ?? {};
    v[vKey].verifiedAt = new Date().toISOString();
    v[vKey].verifiedBy = 'SYSTEM_AI';
    v[vKey].autoVerified = true;
    v[vKey].aiConfidenceScore = aiConfidence;

    const evts = pushOrderEvent(
      Array.isArray(freshOrder.events) ? (freshOrder.events as any[]) : [],
      {
        type: 'VERIFIED',
        at: new Date(),
        actorUserId: 'SYSTEM_AI',
        metadata: { step: vKey, autoVerified: true, aiConfidenceScore: aiConfidence },
      },
    );
    // Guard: only update if order is still UNDER_REVIEW (prevents race conditions)
    const guardResult = await db().order.updateMany({
      where: { id: freshOrder.id, workflowStatus: 'UNDER_REVIEW' },
      data: { verification: v, events: evts as any },
    });
    if (guardResult.count === 0) return freshOrder; // Order was modified concurrently
    const updated = await db().order.findFirst({
      where: { id: freshOrder.id, isDeleted: false },
      include: { items: { where: { isDeleted: false } } },
    });
    if (!updated) return freshOrder;

    const finalize = await finalizeApprovalIfReady(updated!, 'SYSTEM_AI', envRef);
    orderLog.info('Auto-verified step by AI confidence', {
      orderId: freshOrder.mongoId,
      step: vKey,
      aiConfidenceScore: aiConfidence,
      threshold,
      approved: (finalize as any).approved,
    });

    if ((finalize as any).approved) {
      return await db().order.findFirst({
        where: { id: freshOrder.id, isDeleted: false },
        include: { items: { where: { isDeleted: false } } },
      });
    }
    return updated;
  };

  return {
    getOrderProof: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orderId = String(req.params.orderId || '').trim();
        const proofType = String(req.params.type || '').trim().toLowerCase();
        if (!orderId) throw new AppError(400, 'INVALID_ORDER_ID', 'Invalid order id');

        const allowedTypes = new Set(['order', 'payment', 'rating', 'review', 'returnwindow']);
        if (!allowedTypes.has(proofType)) {
          throw new AppError(400, 'INVALID_PROOF_TYPE', 'Invalid proof type');
        }

        const order = await findOrderForProof(orderId);
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const { roles, user, userId: _userId, pgUserId } = getRequester(req);
        if (!isPrivileged(roles)) {
          let allowed = false;

          if (roles.includes('brand')) {
            const sameBrand = String(order.brandUserId || '') === pgUserId;
            const brandName = String(order.brandName || '').trim();
            const sameBrandName = !!brandName && brandName === String(user?.name || '').trim();
            allowed = sameBrand || sameBrandName;
          }

          if (!allowed && roles.includes('agency')) {
            const agencyCode = String(user?.mediatorCode || '').trim();
            const agencyName = String(user?.name || '').trim();
            if (agencyName && String(order.agencyName || '').trim() === agencyName) {
              allowed = true;
            } else if (agencyCode && String(order.managerName || '').trim()) {
              const mediator = await db().user.findFirst({
                where: {
                  roles: { has: 'mediator' as any },
                  mediatorCode: String(order.managerName || '').trim(),
                  parentCode: agencyCode,
                  isDeleted: false,
                },
                select: { id: true },
              });
              allowed = !!mediator;
            }
          }

          if (!allowed && roles.includes('mediator')) {
            const mediatorCode = String(user?.mediatorCode || '').trim();
            allowed = !!mediatorCode && String(order.managerName || '').trim() === mediatorCode;
          }

          if (!allowed && roles.includes('shopper')) {
            allowed = String(order.userId || '') === pgUserId;
          }

          if (!allowed) throw new AppError(403, 'FORBIDDEN', 'Not allowed to access proof');
        }

        const proofValue = resolveProofValue(order, proofType);

        businessLog.info('Order proof viewed', { orderId, proofType, viewerId: req.auth?.userId, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'OrderProof',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'ORDER_PROOF_VIEWED', orderId, proofType },
        });

        sendProofResponse(res, proofValue);
      } catch (err) {
        logErrorEvent({
          message: 'getOrderProof failed',
          category: 'BUSINESS_LOGIC',
          severity: 'medium',
          userId: req.auth?.userId,
          ip: req.ip,
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        next(err);
      }
    },

    getOrderProofPublic: async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Require authentication — prevents unauthenticated enumeration of proof images.
        const requesterId = req.auth?.userId;
        if (!requesterId) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');

        const orderId = String(req.params.orderId || '').trim();
        const proofType = String(req.params.type || '').trim().toLowerCase();
        if (!orderId) throw new AppError(400, 'INVALID_ORDER_ID', 'Invalid order id');

        const allowedTypes = new Set(['order', 'payment', 'rating', 'review', 'returnwindow']);
        if (!allowedTypes.has(proofType)) {
          throw new AppError(400, 'INVALID_PROOF_TYPE', 'Invalid proof type');
        }

        const order = await findOrderForProof(orderId);
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const proofValue = resolveProofValue(order, proofType);

        businessLog.info('Order proof viewed (public)', { orderId, proofType });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'OrderProof',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'ORDER_PROOF_VIEWED_PUBLIC', orderId, proofType, public: true },
        });

        sendProofResponse(res, proofValue);
      } catch (err) {
        logErrorEvent({
          message: 'getOrderProofPublic failed',
          category: 'BUSINESS_LOGIC',
          severity: 'medium',
          userId: req.auth?.userId,
          ip: req.ip,
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        next(err);
      }
    },
    /**
     * Generate signed proof URLs for an order (used by CSV/Excel export).
     * Authenticated endpoint — returns signed tokens that can be opened without auth.
     */
    getSignedProofUrls: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orderId = String(req.params.orderId || '').trim();
        if (!orderId) throw new AppError(400, 'INVALID_ORDER_ID', 'Invalid order id');

        const order = await findOrderForProof(orderId);
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const proofTypes = ['order', 'payment', 'rating', 'review', 'returnWindow'] as const;
        const urls: Record<string, string | null> = {};

        for (const pt of proofTypes) {
          const val = resolveProofValue(order, pt.toLowerCase());
          if (val) {
            const token = createProofToken(orderId, pt.toLowerCase(), env);
            urls[pt] = token;
          } else {
            urls[pt] = null;
          }
        }

        res.json({ urls });
      } catch (err) {
        next(err);
      }
    },
    /**
     * Batch generate signed proof URLs for multiple orders.
     * POST body: { orderIds: string[] }
     * Returns: { tokens: Record<orderId, Record<proofType, string | null>> }
     */
    batchSignedProofUrls: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orderIds: string[] = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
        if (orderIds.length === 0) throw new AppError(400, 'MISSING_ORDER_IDS', 'orderIds array required');
        if (orderIds.length > 500) throw new AppError(400, 'TOO_MANY_ORDERS', 'Max 500 orders per batch');

        const { roles, user: _user, pgUserId } = getRequester(req);

        const proofTypes = ['order', 'payment', 'rating', 'review', 'returnwindow'] as const;
        const tokens: Record<string, Record<string, string | null>> = {};

        // Fetch all orders in one query
        const orders = await db().order.findMany({
          where: {
            OR: orderIds.map(id => UUID_RE.test(id) ? { id } : { mongoId: id }),
            isDeleted: false,
          },
          select: orderProofSelect,
        });

        // Map by both id and mongoId for quick lookup
        const orderMap = new Map<string, any>();
        for (const o of orders) {
          const mapped = pgOrder(o);
          orderMap.set(String(o.id), mapped);
          if (o.mongoId) orderMap.set(String(o.mongoId), mapped);
        }

        // Authorization: only privileged roles (admin/ops) can batch across all orders.
        // Non-privileged users can only generate URLs for their own orders.
        if (!isPrivileged(roles)) {
          for (const o of orders) {
            const mapped = orderMap.get(String(o.id));
            if (!mapped) continue;
            const isOwner = String(o.userId) === pgUserId;
            const isBrand = roles.includes('brand') && String(o.brandUserId) === pgUserId;
            if (!isOwner && !isBrand) {
              throw new AppError(403, 'FORBIDDEN', 'You can only generate proof URLs for your own orders');
            }
          }
        }

        for (const oid of orderIds) {
          const order = orderMap.get(oid);
          if (!order) { tokens[oid] = {}; continue; }
          const entry: Record<string, string | null> = {};
          for (const pt of proofTypes) {
            const val = resolveProofValue(order, pt);
            if (val) {
              entry[pt === 'returnwindow' ? 'returnWindow' : pt] = createProofToken(order.id || oid, pt, env);
            } else {
              entry[pt === 'returnwindow' ? 'returnWindow' : pt] = null;
            }
          }
          tokens[oid] = entry;
        }

        res.json({ tokens });
      } catch (err) {
        next(err);
      }
    },
    /**
     * Serve proof by signed token — no auth required.
     * Used by Excel/Google Sheets HYPERLINK formulas.
     */
    getProofBySigned: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const token = String(req.params.token || '').trim();
        if (!token) throw new AppError(400, 'INVALID_TOKEN', 'Missing token');

        const parsed = verifyProofToken(token, env);
        if (!parsed) throw new AppError(403, 'INVALID_OR_EXPIRED_TOKEN', 'Invalid or expired proof token');

        const order = await findOrderForProof(parsed.orderId);
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const proofValue = resolveProofValue(order, parsed.proofType);

        businessLog.info('Order proof viewed (signed)', {
          orderId: parsed.orderId,
          proofType: parsed.proofType,
        });

        sendProofResponse(res, proofValue);
      } catch (err) {
        logErrorEvent({
          message: 'getProofBySigned failed',
          category: 'BUSINESS_LOGIC',
          severity: 'medium',
          ip: req.ip,
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        next(err);
      }
    },
    getUserOrders: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = String(req.params.userId || '');
        if (!userId) throw new AppError(400, 'INVALID_USER_ID', 'Invalid userId');

        const requesterId = req.auth?.userId;
        const requesterRoles = req.auth?.roles ?? [];
        const privileged = requesterRoles.includes('admin') || requesterRoles.includes('ops');
        // userId may be a mongoId (public API id) while auth.userId is the PG UUID.
        const requesterMongoId = (req.auth as any)?.mongoId ?? '';
        if (!privileged && requesterId !== userId && (req.auth?.pgUserId ?? '') !== userId && requesterMongoId !== userId) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot access other user orders');
        }

        // Resolve mongoId/UUID → PG UUID for FK query
        const userWhere = UUID_RE.test(userId)
          ? { OR: [{ id: userId }, { mongoId: userId }] as any, isDeleted: false }
          : { mongoId: userId, isDeleted: false };
        const targetUser = await db().user.findFirst({ where: userWhere as any, select: { id: true } });
        if (!targetUser) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

        const { page, limit, skip, isPaginated } = parsePagination(req.query as Record<string, unknown>, { limit: 50 });
        const where = { userId: targetUser.id, isDeleted: false };

        const [orders, total] = await Promise.all([
          db().order.findMany({
            where,
            select: orderListSelectLite,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          db().order.count({ where }),
        ]);

        // Fetch lightweight proof boolean flags (avoids transferring base64 blobs)
        const proofFlags = await getProofFlags(db(), orders.map(o => o.id));
        const mapped = orders.map((o: any) => {
          try {
            const flags = proofFlags.get(o.id);
            const pg = pgOrder(o);
            if (flags) {
              pg.screenshots = {
                order: flags.hasOrderProof ? 'exists' : null,
                payment: null,
                review: flags.hasReviewProof ? 'exists' : null,
                rating: flags.hasRatingProof ? 'exists' : null,
                returnWindow: flags.hasReturnWindowProof ? 'exists' : null,
              };
            }
            return toUiOrderSummary(pg);
          }
          catch (e) { orderLog.error(`[orders/getOrders] toUiOrderSummary failed for ${o.id}`, { error: e }); return null; }
        }).filter(Boolean);

        businessLog.info('Orders listed', { userId, resultCount: mapped.length, total, page, limit, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Order',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'ORDERS_LISTED', targetUserId: userId, resultCount: mapped.length, total, page, limit },
        });

        res.json(paginatedResponse(mapped, total, page, limit, isPaginated));
      } catch (err) {
        logErrorEvent({
          message: 'getUserOrders failed',
          category: 'BUSINESS_LOGIC',
          severity: 'medium',
          userId: req.auth?.userId,
          ip: req.ip,
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        next(err);
      }
    },

    createOrder: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = createOrderSchema.parse(req.body);

        const requesterId = req.auth?.userId;
        const requesterRoles = req.auth?.roles ?? [];
        const _pgUserId = (req.auth as any)?.pgUserId ?? '';
        if (!requesterId) throw new AppError(401, 'UNAUTHENTICATED', 'Missing auth context');
        if (!requesterRoles.includes('shopper')) {
          throw new AppError(403, 'FORBIDDEN', 'Only buyers can create orders');
        }

        // Ownership check: body.userId may be a mongoId (public API id) while
        // req.auth.userId is always the PG UUID.  Compare against both to avoid
        // a false-positive 403 when the client sends the mongoId.
        const bodyUserId = String(body.userId);
        const requesterMongoId = (req.auth as any)?.mongoId ?? '';
        if (bodyUserId !== String(requesterId) && bodyUserId !== String(_pgUserId) && bodyUserId !== requesterMongoId) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot create orders for another user');
        }

        const userLookupWhere = UUID_RE.test(body.userId)
          ? { OR: [{ id: body.userId }, { mongoId: body.userId }] as any, isDeleted: false }
          : { mongoId: body.userId, isDeleted: false };
        const user = await db().user.findFirst({ where: userLookupWhere as any, select: { id: true, mongoId: true, name: true, mobile: true, status: true, parentCode: true } });
        if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
        if (user.status !== 'active') {
          throw new AppError(403, 'USER_NOT_ACTIVE', 'Your account is not active. Please contact support.');
        }
        const userPgId = user.id;
        const userMongoId = user.mongoId!;

        // Abuse prevention: basic velocity limits (per buyer).
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const [hourly, daily] = await Promise.all([
          db().order.count({ where: { userId: userPgId, createdAt: { gte: oneHourAgo }, isDeleted: false } }),
          db().order.count({ where: { userId: userPgId, createdAt: { gte: oneDayAgo }, isDeleted: false } }),
        ]);
        if (hourly >= 10 || daily >= 30) {
          throw new AppError(429, 'VELOCITY_LIMIT', 'Too many orders created. Please try later.');
        }

        const allowE2eBypass = env.NODE_ENV !== 'production';
        const resolvedExternalOrderId = body.externalOrderId || (allowE2eBypass ? `E2E-${Date.now()}` : undefined);

        if (resolvedExternalOrderId) {
          const dup = await db().order.findFirst({ where: { userId: userPgId, externalOrderId: resolvedExternalOrderId, isDeleted: false }, select: { id: true } });
          if (dup) {
            throw new AppError(
              409,
              'DUPLICATE_EXTERNAL_ORDER_ID',
              'This Order ID has already been submitted in our system.'
            );
          }
        }

        // NOTE: We allow buyers to place multiple orders for the same deal/product.
        // Real-world scenario: buyer orders from mom's Amazon, then brother's Amazon, etc.
        // The externalOrderId uniqueness check above prevents true duplicates (same order ID).

        const upstreamMediatorCode = String(user.parentCode || '').trim();
        if (!upstreamMediatorCode) {
          throw new AppError(409, 'MISSING_MEDIATOR_LINK', 'Your account is not linked to a mediator');
        }

        const item = body.items[0];
        if (!body.screenshots?.order) {
          throw new AppError(400, 'ORDER_PROOF_REQUIRED', 'Order proof image is required.');
        }
        assertProofImageSize(body.screenshots.order, 'Order proof');

        if (body.screenshots?.rating) {
          assertProofImageSize(body.screenshots.rating, 'Rating proof');
        }

        if (!resolvedExternalOrderId && !allowE2eBypass) {
          throw new AppError(400, 'ORDER_ID_REQUIRED', 'Order ID is required to validate proof.');
        }

        let aiOrderConfidence = 0;
        let aiUnavailable = false;
        if (allowE2eBypass) {
          // E2E/dev runs should not rely on external AI services.
        } else if (isGeminiConfigured(env)) {
          // Use the total paid amount (Grand Total) for verification, not item price.
          // The buyer enters the Grand Total from the order screenshot, which may include
          // shipping, marketplace fees, taxes etc.
          const expectedAmount = body.items.reduce(
            (acc: number, it: any) => acc + (Number(it.priceAtPurchase) || 0) * (Number(it.quantity) || 1),
            0
          );
          // Guard against NaN/Infinity from bad request data
          if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
            throw new AppError(400, 'INVALID_ORDER_AMOUNT', 'Unable to process your order. Please check the order details and try again.');
          }
          // Product name from deal/item for AI matching (user said 100% product name match required)
          const expectedProductName = String(item.title || '').trim();
          try {
            const aiStart = Date.now();
            const verification = await verifyProofWithAi(env, {
              imageBase64: body.screenshots.order,
              expectedOrderId: resolvedExternalOrderId || body.externalOrderId || '',
              expectedAmount,
              ...(expectedProductName ? { expectedProductName } : {}),
            });
            logPerformance({
              operation: 'AI_ORDER_PROOF_VERIFICATION',
              durationMs: Date.now() - aiStart,
              metadata: { orderId: resolvedExternalOrderId, confidenceScore: verification?.confidenceScore },
            });

            const confidenceThreshold = env.AI_PROOF_CONFIDENCE_THRESHOLD ?? 75;
            // Amount mismatch is expected (shipping, discounts, taxes) — don't hard-block.
            // Only require orderIdMatch + confidence threshold.
            if (!verification?.orderIdMatch || (verification?.confidenceScore ?? 0) < confidenceThreshold) {
              throw new AppError(
                422,
                'INVALID_ORDER_PROOF',
                'Your order proof could not be verified. Please upload a clear screenshot showing the order ID.'
              );
            }
            // Hard-block: product name must POSITIVELY match when expected product name is available.
            // Use !== true (not === false) so undefined/null also blocks — safety first.
            if (expectedProductName && verification?.productNameMatch !== true) {
              throw new AppError(
                422,
                'PRODUCT_NAME_MISMATCH',
                'The product in the screenshot does not match the selected deal. ' +
                `Expected "${expectedProductName}"` +
                (verification?.detectedProductName ? `, detected "${verification.detectedProductName}"` : '') +
                '. Please upload the correct order screenshot.'
              );
            }
            // Hard-block: cropped/incomplete screenshots are not acceptable
            if (verification?.screenshotCropped === true) {
              throw new AppError(
                422,
                'SCREENSHOT_INCOMPLETE',
                'Your order screenshot appears to be cropped or incomplete. ' +
                'Please upload a FULL screenshot showing the complete order page including the page header. ' +
                (verification?.discrepancyNote || '')
              );
            }
            aiOrderConfidence = verification?.confidenceScore ?? 0;
          } catch (aiErr: any) {
            // Re-throw validation errors (422s) — those are intentional user-facing blocks
            if (aiErr instanceof AppError) throw aiErr;
            // Infrastructure failure (Gemini down, OCR crash, timeout) — let order proceed
            // for manual review instead of blocking the buyer
            orderLog.warn('[createOrder] AI verification unavailable, proceeding for manual review', {
              error: aiErr?.message,
              orderId: resolvedExternalOrderId,
            });
            aiUnavailable = true;
          }
        } else {
          // AI not configured — proceed for manual review instead of hard-blocking
          orderLog.warn('[createOrder] AI not configured, order will require manual review');
          aiUnavailable = true;
        }
        const campaignWhere = UUID_RE.test(item.campaignId)
          ? { OR: [{ id: item.campaignId }, { mongoId: item.campaignId }], isDeleted: false }
          : { mongoId: item.campaignId, isDeleted: false };

        // [PERF] Parallel fetch: campaign + mediatorUser are independent
        const [campaign, mediatorUser] = await Promise.all([
          db().campaign.findFirst({ where: campaignWhere as any }),
          db().user.findFirst({
            where: { roles: { has: 'mediator' as any }, mediatorCode: upstreamMediatorCode, isDeleted: false },
            select: { parentCode: true },
          }),
        ]);
        if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');

        if (String((campaign as any).status || '').toLowerCase() !== 'active') {
          throw new AppError(409, 'CAMPAIGN_NOT_ACTIVE', 'Campaign is not active');
        }

        const upstreamAgencyCode = String((mediatorUser as any)?.parentCode || '').trim();

        // Resolve actual agency name for the order record
        let resolvedAgencyName = 'Partner Agency';
        if (upstreamAgencyCode) {
          const agencyUser = await db().user.findFirst({
            where: { roles: { has: 'agency' as any }, mediatorCode: upstreamAgencyCode, isDeleted: false },
            select: { name: true },
          });
          if (agencyUser?.name) resolvedAgencyName = String(agencyUser.name);
        }

        const allowedAgencyCodes = Array.isArray((campaign as any).allowedAgencyCodes)
          ? ((campaign as any).allowedAgencyCodes as string[]).map((c) => String(c))
          : [];

        const assignmentsRaw = (campaign.assignments && typeof campaign.assignments === 'object' && !Array.isArray(campaign.assignments))
          ? campaign.assignments as Record<string, any>
          : {};

        // Case-insensitive assignment lookup — keys are stored lowercase by assignSlots.
        const findAssignment = (code: string) => {
          if (!code) return undefined;
          if (Object.prototype.hasOwnProperty.call(assignmentsRaw, code)) return assignmentsRaw[code];
          const lower = code.toLowerCase();
          for (const [k, v] of Object.entries(assignmentsRaw)) {
            if (k.toLowerCase() === lower) return v;
          }
          return undefined;
        };

        const mediatorAssignment = upstreamMediatorCode ? findAssignment(upstreamMediatorCode) : undefined;
        const hasMediatorAssignment = mediatorAssignment !== undefined;
        const hasAgencyAccess = upstreamAgencyCode ? allowedAgencyCodes.includes(upstreamAgencyCode) : false;
        const campaignIsOpenToAll = (campaign as any).openToAll === true;

        if (!campaignIsOpenToAll && !hasAgencyAccess && !hasMediatorAssignment) {
          throw new AppError(403, 'FORBIDDEN', 'Campaign is not available for your network');
        }

        // Optimistic slot checks (re-verified atomically inside the transaction below)
        if ((campaign.usedSlots ?? 0) >= (campaign.totalSlots ?? 0)) {
          throw new AppError(409, 'SOLD_OUT', 'Sold Out Globally');
        }

        const assignmentVal = mediatorAssignment;
        const assigned = upstreamMediatorCode
          ? typeof assignmentVal === 'number'
            ? assignmentVal
            : Number((assignmentVal as any)?.limit ?? 0)
          : 0;

        // Commission snapshot: prefer published Deal record if productId is a Deal id.
        let commissionPaise = rupeesToPaise(item.commission);
        const dealWhere = UUID_RE.test(item.productId)
          ? { OR: [{ id: item.productId }, { mongoId: item.productId }] as any, isDeleted: false }
          : { mongoId: item.productId, isDeleted: false };

        // [PERF] Parallel fetch: mediatorSales + maybeDeal are independent
        const [mediatorSales, maybeDeal] = await Promise.all([
          // For "Open to All" campaigns, skip per-mediator limit check — only global slot limit applies
          (!campaignIsOpenToAll && upstreamMediatorCode && assigned > 0)
            ? db().order.count({
                where: {
                  managerName: upstreamMediatorCode,
                  items: { some: { campaignId: campaign.id } },
                  status: { not: 'Cancelled' as any },
                  isDeleted: false,
                },
              })
            : Promise.resolve(0),
          db().deal.findFirst({ where: dealWhere as any }),
        ]);

        if (!campaignIsOpenToAll && upstreamMediatorCode && assigned > 0 && mediatorSales >= assigned) {
          throw new AppError(
            409,
            'SOLD_OUT_FOR_PARTNER',
            'This product is currently sold out for your network. Please try again later.'
          );
        }

        if (maybeDeal) {
          commissionPaise = maybeDeal.commissionPaise;
        }

        // Atomic slot claim via raw SQL inside transaction to prevent overselling
        const claimSlot = async (tx: any) => {
          const claimed: any[] = await tx.$queryRaw`
            UPDATE "campaigns" SET "used_slots" = "used_slots" + 1
            WHERE id = ${campaign.id}::uuid AND "used_slots" < "total_slots" AND "is_deleted" = false
            RETURNING id
          `;
          if (!claimed.length) {
            throw new AppError(409, 'SOLD_OUT', 'Sold Out — another buyer claimed the last slot');
          }
        };

        const created = await db().$transaction(async (tx) => {
          // If this is an upgrade from a redirect-tracked pre-order, update that order instead of creating a new one.
          if (body.preOrderId) {
            const preOrderWhere = UUID_RE.test(body.preOrderId)
              ? { OR: [{ id: body.preOrderId }, { mongoId: body.preOrderId }] as any, userId: userPgId, isDeleted: false }
              : { mongoId: body.preOrderId, userId: userPgId, isDeleted: false };
            const existing = await tx.order.findFirst({
              where: preOrderWhere as any,
              include: { items: { where: { isDeleted: false } } },
            });
            if (!existing) throw new AppError(404, 'ORDER_NOT_FOUND', 'Pre-order not found');
            if (existing.frozen) throw new AppError(409, 'ORDER_FROZEN', 'Order is frozen and requires explicit reactivation');
            if (String(existing.workflowStatus) !== 'REDIRECTED') {
              throw new AppError(409, 'ORDER_STATE_MISMATCH', 'Pre-order is not in REDIRECTED state');
            }

            // Slot consumption happens on ORDERED — use atomic claim to prevent overselling.
            await claimSlot(tx);

            // Soft-delete old items, then recreate with new data
            await tx.orderItem.updateMany({ where: { orderId: existing.id }, data: { isDeleted: true } });

            const existingEvents = Array.isArray(existing.events) ? (existing.events as any[]) : [];
            const _updated = await tx.order.update({
              where: { id: existing.id },
              data: {
                brandUserId: campaign.brandUserId,
                items: {
                  create: body.items.map((it) => ({
                    productId: it.productId,
                    title: it.title,
                    image: it.image,
                    priceAtPurchasePaise: rupeesToPaise(it.priceAtPurchase),
                    commissionPaise,
                    campaignId: campaign.id,
                    dealType: it.dealType,
                    quantity: it.quantity,
                    platform: it.platform,
                    brandName: it.brandName,
                  })),
                },
                totalPaise: body.items.reduce(
                  (acc, it) => acc + rupeesToPaise(it.priceAtPurchase) * it.quantity,
                  0
                ),
                status: 'Ordered' as any,
                paymentStatus: 'Pending' as any,
                affiliateStatus: 'Unchecked' as any,
                managerName: upstreamMediatorCode,
                agencyName: resolvedAgencyName,
                buyerName: user.name,
                buyerMobile: user.mobile,
                brandName: item.brandName ?? campaign.brandName,
                externalOrderId: resolvedExternalOrderId,
                ...(body.reviewerName ? { reviewerName: body.reviewerName } : {}),
                // Merge screenshots: preserve existing proofs, overlay new ones
                screenshotOrder: body.screenshots?.order ?? existing.screenshotOrder,
                screenshotPayment: body.screenshots?.payment ?? existing.screenshotPayment,
                screenshotRating: body.screenshots?.rating ?? existing.screenshotRating,
                screenshotReview: body.screenshots?.review ?? existing.screenshotReview,
                screenshotReturnWindow: body.screenshots?.returnWindow ?? existing.screenshotReturnWindow,
                reviewLink: body.reviewLink,
                ...(body.orderDate && !isNaN(new Date(body.orderDate).getTime()) ? { orderDate: new Date(body.orderDate) } : {}),
                ...(body.soldBy ? { soldBy: body.soldBy } : {}),
                ...(body.extractedProductName ? { extractedProductName: body.extractedProductName } : {}),
                events: pushOrderEvent(existingEvents, {
                  type: 'ORDERED',
                  at: new Date(),
                  actorUserId: userMongoId,
                  metadata: { campaignId: String(campaign.mongoId ?? campaign.id), mediatorCode: upstreamMediatorCode },
                }) as any,
                updatedBy: userPgId,
              },
              include: { items: { where: { isDeleted: false } } },
            });

            // State machine: REDIRECTED -> ORDERED
            const transitioned = await transitionOrderWorkflow({
              orderId: existing.mongoId!,
              from: 'REDIRECTED' as any,
              to: 'ORDERED' as any,
              actorUserId: userMongoId,
              metadata: { source: 'createOrder(preOrderId)' },
              tx,
              env,
            });
            return transitioned;
          }

          // Atomic slot claim to prevent overselling under concurrency
          await claimSlot(tx);

          const order = await tx.order.create({
            data: {
              mongoId: randomUUID(),
              userId: userPgId,
              brandUserId: campaign.brandUserId,
              items: {
                create: body.items.map((it) => ({
                  productId: it.productId,
                  title: it.title,
                  image: it.image,
                  priceAtPurchasePaise: rupeesToPaise(it.priceAtPurchase),
                  commissionPaise,
                  campaignId: campaign.id,
                  dealType: it.dealType,
                  quantity: it.quantity,
                  platform: it.platform,
                  brandName: it.brandName,
                })),
              },
              totalPaise: body.items.reduce(
                (acc, it) => acc + rupeesToPaise(it.priceAtPurchase) * it.quantity,
                0
              ),
              workflowStatus: 'ORDERED' as any,
              status: 'Ordered' as any,
              paymentStatus: 'Pending' as any,
              affiliateStatus: 'Unchecked' as any,
              managerName: upstreamMediatorCode,
              agencyName: resolvedAgencyName,
              buyerName: user.name,
              buyerMobile: user.mobile,
              brandName: item.brandName ?? campaign.brandName,
              externalOrderId: resolvedExternalOrderId,
              ...(body.reviewerName ? { reviewerName: body.reviewerName } : {}),
              screenshotOrder: body.screenshots?.order ?? null,
              screenshotPayment: body.screenshots?.payment ?? null,
              screenshotRating: body.screenshots?.rating ?? null,
              screenshotReview: body.screenshots?.review ?? null,
              screenshotReturnWindow: body.screenshots?.returnWindow ?? null,
              reviewLink: body.reviewLink,
              ...(body.orderDate && !isNaN(new Date(body.orderDate).getTime()) ? { orderDate: new Date(body.orderDate) } : {}),
              ...(body.soldBy ? { soldBy: body.soldBy } : {}),
              ...(body.extractedProductName ? { extractedProductName: body.extractedProductName } : {}),
              events: pushOrderEvent([], {
                type: 'ORDERED',
                at: new Date(),
                actorUserId: userMongoId,
                metadata: { campaignId: String(campaign.mongoId ?? campaign.id), mediatorCode: upstreamMediatorCode },
              }) as any,
              createdBy: userPgId,
            },
            include: { items: { where: { isDeleted: false } } },
          });

          return order;
        }, { timeout: 15000 });

        // UI often submits the initial order screenshot at creation time.
        // If proof is already present, progress the strict workflow so Ops can verify.
        let finalOrder: any = created;
        const orderMongoId = created?.mongoId ?? '';
        const initialProofTypes: Array<'order' | 'rating' | 'review'> = [];
        if (body.screenshots?.order) initialProofTypes.push('order');
        if (body.screenshots?.rating) initialProofTypes.push('rating');
        if (body.reviewLink) initialProofTypes.push('review');

        if (initialProofTypes.length) {
          // Attach an auditable proof-submitted event.
          const currentEvents = Array.isArray(created?.events) ? (created.events as any[]) : [];
          const updatedEvents = pushOrderEvent(currentEvents, {
            type: 'PROOF_SUBMITTED',
            at: new Date(),
            actorUserId: requesterId,
            metadata: { type: initialProofTypes[0] },
          });
          await db().order.update({
            where: { id: created!.id },
            data: { events: updatedEvents as any },
          });

          const _afterProof = await transitionOrderWorkflow({
            orderId: orderMongoId,
            from: (created?.workflowStatus ?? 'ORDERED') as any,
            to: 'PROOF_SUBMITTED' as any,
            actorUserId: String(requesterId || ''),
            metadata: { proofType: initialProofTypes[0], source: 'createOrder' },
            env,
          });

          finalOrder = await transitionOrderWorkflow({
            orderId: orderMongoId,
            from: 'PROOF_SUBMITTED' as any,
            to: 'UNDER_REVIEW' as any,
            actorUserId: undefined,
            metadata: { system: true, source: 'createOrder' },
            env,
          });

          // ── Auto-verify by AI confidence ──────────────────────────────
          // When AI has verified the proof (passed all hard-block checks), auto-verify
          // the purchase step. The hard blocks (orderIdMatch, productNameMatch, etc.)
          // already ensure proof correctness — any surviving proof is "AI-approved".
          const autoThreshold = env.AI_AUTO_VERIFY_THRESHOLD ?? 90;
          if (aiOrderConfidence >= autoThreshold) {
            const freshOrder = await db().order.findFirst({
              where: { mongoId: orderMongoId, isDeleted: false },
              include: { items: { where: { isDeleted: false } } },
            });
            if (freshOrder && String(freshOrder.workflowStatus) === 'UNDER_REVIEW') {
              const v = (freshOrder.verification && typeof freshOrder.verification === 'object')
                ? { ...(freshOrder.verification as any) } : {} as any;
              if (!v.order?.verifiedAt) {
                v.order = v.order ?? {};
                v.order.verifiedAt = new Date().toISOString();
                v.order.verifiedBy = 'SYSTEM_AI';
                v.order.autoVerified = true;
                v.order.aiConfidenceScore = aiOrderConfidence;
                const evts = pushOrderEvent(
                  Array.isArray(freshOrder.events) ? (freshOrder.events as any[]) : [],
                  { type: 'VERIFIED', at: new Date(), actorUserId: 'SYSTEM_AI', metadata: { step: 'order', autoVerified: true, aiConfidenceScore: aiOrderConfidence } },
                );
                const updated = await db().order.update({
                  where: { id: freshOrder.id },
                  data: { verification: v, events: evts as any },
                  include: { items: { where: { isDeleted: false } } },
                });
                const finalize = await finalizeApprovalIfReady(updated!, 'SYSTEM_AI', env);
                orderLog.info('Auto-verified purchase by AI confidence', {
                  orderId: orderMongoId,
                  aiConfidenceScore: aiOrderConfidence,
                  autoThreshold,
                  approved: (finalize as any).approved,
                });
                if ((finalize as any).approved) {
                  finalOrder = await db().order.findFirst({
                    where: { id: freshOrder.id, isDeleted: false },
                    include: { items: { where: { isDeleted: false } } },
                  });
                } else {
                  finalOrder = updated;
                }
              }
            }
          }

          // Mark order verification data when AI was unavailable so reviewers know
          if (aiUnavailable) {
            const aiUnavailableOrder = await db().order.findFirst({
              where: { mongoId: orderMongoId, isDeleted: false },
              select: { id: true, verification: true },
            });
            if (aiUnavailableOrder) {
              const v = (aiUnavailableOrder.verification && typeof aiUnavailableOrder.verification === 'object')
                ? { ...(aiUnavailableOrder.verification as any) } : {} as any;
              v.aiUnavailable = true;
              v.aiUnavailableAt = new Date().toISOString();
              await db().order.update({
                where: { id: aiUnavailableOrder.id },
                data: { verification: v },
              });
            }
          }
        }

        // Audit trail — write BEFORE sending response so the audit entry is guaranteed
        // even if the client disconnects or the response write fails.
        await writeAuditLog({
          req,
          action: 'ORDER_CREATED',
          entityType: 'Order',
          entityId: orderMongoId,
          metadata: {
            campaignId: String(campaign.mongoId ?? campaign.id),
            total: body.items.reduce((a: number, it: any) => a + (Number(it.priceAtPurchase) || 0) * (Number(it.quantity) || 1), 0),
            externalOrderId: resolvedExternalOrderId,
          },
        }).catch((err: unknown) => { orderLog.warn('Audit log failed', { error: err instanceof Error ? err.message : String(err) }); });

        orderLog.info('Order created', { orderId: orderMongoId, userId: req.auth?.userId, campaignId: String(campaign.mongoId ?? campaign.id), externalOrderId: resolvedExternalOrderId, itemCount: body.items.length, ip: req.ip });
        logChangeEvent({
          actorUserId: req.auth?.userId,
          actorRoles: req.auth?.roles,
          actorIp: req.ip,
          entityType: 'Order',
          entityId: orderMongoId,
          action: 'ORDER_CREATED',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: {
            campaignId: String(campaign.mongoId ?? campaign.id),
            itemCount: body.items.length,
            externalOrderId: resolvedExternalOrderId,
          },
        });

        businessLog.info('Order created', { orderId: orderMongoId, userId: req.auth?.userId, campaignId: String(campaign.mongoId ?? campaign.id), itemCount: body.items.length, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Order',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'ORDER_CREATED', orderId: orderMongoId, externalOrderId: resolvedExternalOrderId },
        });

        res
          .status(201)
          .json(toUiOrder(pgOrder(finalOrder)));

        // Post-response: notify UIs (wrapped in try/catch since response already sent)
        try {
          const privilegedRoles: Role[] = ['admin', 'ops'];
          let brandMongoId = '';
          if (campaign.brandUserId) {
            const brandUser = await db().user.findUnique({ where: { id: campaign.brandUserId }, select: { mongoId: true } });
            brandMongoId = brandUser?.mongoId ?? '';
          }
          const audience = {
          roles: privilegedRoles,
          userIds: [userMongoId, brandMongoId].filter(Boolean),
          mediatorCodes: upstreamMediatorCode ? [upstreamMediatorCode] : undefined,
          agencyCodes: upstreamAgencyCode ? [upstreamAgencyCode] : undefined,
        };

        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });
        } catch (postErr) {
          orderLog.warn('Post-response notification failed', { error: postErr instanceof Error ? postErr.message : String(postErr) });
        }
      } catch (err) {
        logErrorEvent({
          message: 'createOrder failed',
          category: 'BUSINESS_LOGIC',
          severity: 'high',
          userId: req.auth?.userId,
          ip: req.ip,
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        next(err);
      }
    },

    submitClaim: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = submitClaimSchema.parse(req.body);
        const claimOrderWhere = UUID_RE.test(body.orderId)
          ? { OR: [{ id: body.orderId }, { mongoId: body.orderId }] as any, isDeleted: false }
          : { mongoId: body.orderId, isDeleted: false };
        const order = await db().order.findFirst({
          where: claimOrderWhere as any,
          include: { items: { where: { isDeleted: false } } },
        });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        if (order.frozen) {
          throw new AppError(409, 'ORDER_FROZEN', 'Order is frozen and requires explicit reactivation');
        }

        const requesterId = req.auth?.userId;
        const requesterPgId = (req.auth as any)?.pgUserId ?? '';
        const requesterRoles = req.auth?.roles ?? [];
        const privileged = requesterRoles.includes('admin') || requesterRoles.includes('ops');
        if (!privileged && order.userId !== requesterPgId) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot modify other user orders');
        }

        if (isTerminalAffiliateStatus(String(order.affiliateStatus))) {
          throw new AppError(409, 'ORDER_FINALIZED', 'This order is finalized and cannot be modified');
        }

        const wf = String(order.workflowStatus || 'CREATED');
        if (wf !== 'ORDERED' && wf !== 'UNDER_REVIEW' && wf !== 'PROOF_SUBMITTED' && wf !== 'APPROVED') {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot submit proof in state ${wf}`);
        }

        // verification is JSONB
        const verification = (order.verification && typeof order.verification === 'object') ? order.verification as any : {};

        // AI confidence captured from whichever proof type is uploaded; used for auto-verify.
        let claimAiConfidence = 0;

        // Step-gating: buyer can only upload review/rating AFTER purchase is verified by mediator.
        if (body.type === 'review' || body.type === 'rating') {
          const purchaseVerified = !!verification?.order?.verifiedAt;
          if (!purchaseVerified) {
            throw new AppError(409, 'PURCHASE_NOT_VERIFIED',
              'Purchase proof must be verified by your mediator before uploading additional proofs.');
          }

          // Validate that the deal type actually requires this proof.
          const dealTypes = (order.items ?? []).map((it: any) => String(it?.dealType || ''));
          const requiresReview = dealTypes.includes('Review');
          const requiresRating = dealTypes.includes('Rating');
          if (body.type === 'review' && !requiresReview) {
            throw new AppError(409, 'NOT_REQUIRED', 'This order does not require review proof.');
          }
          if (body.type === 'rating' && !requiresRating) {
            throw new AppError(409, 'NOT_REQUIRED', 'This order does not require rating proof.');
          }
        }

        // Return window step: gated behind purchase verification + rating/review proof upload
        if (body.type === 'returnWindow') {
          const purchaseVerified = !!verification?.order?.verifiedAt;
          if (!purchaseVerified) {
            throw new AppError(409, 'PURCHASE_NOT_VERIFIED',
              'Purchase proof must be verified before uploading return window proof.');
          }
          // For Rating/Review deals, rating/review proof must be UPLOADED (not necessarily verified)
          const dealTypes = (order.items ?? []).map((it: any) => String(it?.dealType || ''));
          const requiresRating = dealTypes.includes('Rating');
          const requiresReview = dealTypes.includes('Review');
          if (requiresRating && !order.screenshotRating) {
            throw new AppError(409, 'RATING_NOT_UPLOADED',
              'Rating proof must be uploaded before uploading return window proof.');
          }
          if (requiresReview && !order.reviewLink && !order.screenshotReview) {
            throw new AppError(409, 'REVIEW_NOT_UPLOADED',
              'Review proof must be uploaded before uploading return window proof.');
          }
        }

        // Duplicate screenshot detection: prevent buyer from submitting the same image
        // for different proof types. Only applies to image uploads (not review links).
        // EXCEPTION: order & returnWindow MAY be the same screenshot (late fulfillment scenario
        // where user fills order form late and return window is already visible in order screenshot).
        if (body.type !== 'review' && body.data) {
          const proofData = body.data.includes(',') ? body.data.split(',')[1]! : body.data;
          const existingScreenshots: Array<{ field: string; value: string | null }> = [
            { field: 'order', value: order.screenshotOrder },
            { field: 'rating', value: order.screenshotRating },
            { field: 'returnWindow', value: order.screenshotReturnWindow },
          ].filter(s => {
            if (s.field === body.type) return false; // skip self
            if (!s.value) return false;
            // Allow order ↔ returnWindow to be the same screenshot
            if ((s.field === 'order' && body.type === 'returnWindow') ||
                (s.field === 'returnWindow' && body.type === 'order')) return false;
            return true;
          });

          for (const existing of existingScreenshots) {
            const existingData = existing.value!.includes(',') ? existing.value!.split(',')[1]! : existing.value!;
            if (proofData === existingData) {
              throw new AppError(422, 'DUPLICATE_SCREENSHOT',
                `This screenshot is identical to your ${existing.field} proof. Please upload a different screenshot for ${body.type} proof.`);
            }
          }
        }

        // Build the update payload incrementally
        const updateData: any = {};
        let aiOrderVerification: any = null;

        if (body.type === 'review') {
          // Validate review link is a proper URL from a known marketplace
          const reviewUrl = String(body.data).trim();
          if (!/^https?:\/\//i.test(reviewUrl)) {
            throw new AppError(400, 'INVALID_REVIEW_LINK', 'Review link must be a valid HTTP(S) URL');
          }
          // Validate the link is from a recognized e-commerce platform (skip in test mode)
          if (env.NODE_ENV !== 'test') {
            const KNOWN_REVIEW_DOMAINS = [
              'amazon.in', 'amazon.com', 'flipkart.com', 'myntra.com', 'meesho.com',
              'ajio.com', 'jiomart.com', 'nykaa.com', 'tatacliq.com', 'snapdeal.com',
              'bigbasket.com', '1mg.com', 'croma.com', 'purplle.com', 'shopsy.in',
              'blinkit.com', 'zepto.co', 'lenskart.com', 'pharmeasy.in', 'swiggy.com',
            ];
            try {
              const parsedUrl = new URL(reviewUrl);
              const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
              const domainMatch = KNOWN_REVIEW_DOMAINS.some(d => host === d || host.endsWith('.' + d));
              if (!domainMatch) {
                throw new AppError(400, 'UNKNOWN_REVIEW_PLATFORM',
                  'Review link must be from a recognized marketplace (Amazon, Flipkart, Myntra, etc.)');
              }
              // Validate review link domain matches the order's platform (e.g. Amazon deal → amazon.in link)
              const orderPlatform = String((order.items?.[0] as any)?.platform || '').trim().toLowerCase();
              if (orderPlatform) {
                const PLATFORM_DOMAIN_MAP: Record<string, string[]> = {
                  amazon: ['amazon.in', 'amazon.com'],
                  flipkart: ['flipkart.com'],
                  myntra: ['myntra.com'],
                  meesho: ['meesho.com'],
                  ajio: ['ajio.com'],
                  jiomart: ['jiomart.com'],
                  nykaa: ['nykaa.com'],
                  blinkit: ['blinkit.com'],
                  zepto: ['zepto.co'],
                  snapdeal: ['snapdeal.com'],
                  lenskart: ['lenskart.com'],
                  croma: ['croma.com'],
                  purplle: ['purplle.com'],
                  bigbasket: ['bigbasket.com'],
                  swiggy: ['swiggy.com'],
                  pharmeasy: ['pharmeasy.in'],
                };
                const expectedDomains = PLATFORM_DOMAIN_MAP[orderPlatform]
                  ?? Object.entries(PLATFORM_DOMAIN_MAP).find(([k]) => orderPlatform.includes(k))?.[1];
                if (expectedDomains) {
                  const domainPlatformMatch = expectedDomains.some(d => host === d || host.endsWith('.' + d));
                  if (!domainPlatformMatch) {
                    throw new AppError(422, 'REVIEW_PLATFORM_MISMATCH',
                      `Review link is from "${host}" but this order is for ${(order.items?.[0] as any)?.platform || orderPlatform}. ` +
                      'Please submit a review link from the correct platform.');
                  }
                }
              }
            } catch (urlErr) {
              if (urlErr instanceof AppError) throw urlErr;
              throw new AppError(400, 'INVALID_REVIEW_LINK', 'Review link is not a valid URL');
            }
          }
          updateData.reviewLink = reviewUrl;
          // Auto-verify review links: URL validation confirms it's from a known marketplace.
          // Additionally verify the link is reachable (HEAD request with timeout) before
          // awarding auto-verify confidence. This prevents fraudulent dead links from
          // being auto-approved.
          if (env.NODE_ENV !== 'test') {
            try {
              const headResp = await fetch(reviewUrl, {
                method: 'HEAD',
                redirect: 'follow',
                signal: AbortSignal.timeout(8000),
              });
              if (headResp.ok || headResp.status === 405 || headResp.status === 403) {
                // 200/405 (method not allowed but URL exists)/403 (auth-gated) — link exists
                claimAiConfidence = env.AI_REVIEW_LINK_CONFIDENCE ?? 95;
              } else if ([301, 302, 303, 307, 308, 429].includes(headResp.status)) {
                // Redirects or rate-limited — URL exists but server didn't cooperate with HEAD
                claimAiConfidence = Math.max(80, (env.AI_REVIEW_LINK_CONFIDENCE ?? 95) - 10);
              } else {
                orderLog.warn('Review link HEAD returned non-OK status', {
                  orderId: order.mongoId, status: headResp.status, url: reviewUrl,
                });
                // Domain-validated link from known platform — moderate confidence
                claimAiConfidence = 70;
              }
            } catch {
              // Network error / timeout — domain was validated, assign moderate confidence
              orderLog.warn('Review link HEAD request failed', { orderId: order.mongoId, url: reviewUrl });
              claimAiConfidence = 70;
            }
          }
          if (order.rejectionType === 'review') {
            updateData.rejectionType = null;
            updateData.rejectionReason = null;
            updateData.rejectionAt = null;
            updateData.rejectionBy = null;
          }
        } else if (body.type === 'rating') {
          assertProofImageSize(body.data, 'Rating proof');

          // AI verification: check account name matches buyer + product name matches
          let ratingAiResult: any = null;
          if (isGeminiConfigured(env)) {
            const buyerUser = await db().user.findUnique({
              where: { id: order.userId },
              select: { name: true },
            });
            const buyerName = String(buyerUser?.name || order.buyerName || '').trim();
            const productName = String((order.items?.[0] as any)?.title || order.extractedProductName || '').trim();
            const reviewerName = String(body.reviewerName || order.reviewerName || '').trim();
            // Pass buyer's app account name as expectedBuyerName (secondary), and the
            // marketplace reviewer name as expectedReviewerName (PRIMARY match target).
            // The AI service matches PRIMARILY against expectedReviewerName when provided.
            if ((reviewerName || buyerName) && productName) {
              const aiStart = Date.now();
              ratingAiResult = await verifyRatingScreenshotWithAi(env, {
                imageBase64: body.data,
                expectedBuyerName: buyerName,
                expectedProductName: productName,
                ...(reviewerName ? { expectedReviewerName: reviewerName } : {}),
              });
              logPerformance({
                operation: 'AI_RATING_VERIFICATION',
                durationMs: Date.now() - aiStart,
                metadata: { orderId: order.mongoId, confidenceScore: ratingAiResult?.confidenceScore },
              });
              // Block submission if reviewer name is set and doesn't match (strict enforcement)
              if (ratingAiResult && reviewerName && !ratingAiResult.accountNameMatch
                && ratingAiResult.confidenceScore > 0) {
                throw new AppError(422, 'RATING_VERIFICATION_FAILED',
                  `Rating screenshot reviewer name does not match "${reviewerName}". ` +
                  `Detected: "${ratingAiResult.detectedAccountName || 'unknown'}". ` +
                  'Please upload a screenshot from the correct marketplace account. ' +
                  (ratingAiResult.discrepancyNote || ''));
              }
              // Block submission if product name alone mismatches (strict — any confidence > 0)
              if (ratingAiResult && !ratingAiResult.productNameMatch
                && ratingAiResult.confidenceScore > 0) {
                throw new AppError(422, 'RATING_VERIFICATION_FAILED',
                  'Rating screenshot product does not match this order. ' +
                  'Please upload the correct rating screenshot. ' +
                  (ratingAiResult.discrepancyNote || ''));
              }
              // Block submission if screenshot is cropped/incomplete (fraud prevention)
              if (ratingAiResult && ratingAiResult.screenshotCropped === true) {
                throw new AppError(422, 'SCREENSHOT_INCOMPLETE',
                  'Your rating screenshot appears to be cropped or incomplete. ' +
                  'Please upload a FULL screenshot showing the complete review page including the page header and account name. ' +
                  (ratingAiResult.discrepancyNote || ''));
              }
            }
          }

          updateData.screenshotRating = body.data;
          if (ratingAiResult) {
            claimAiConfidence = ratingAiResult.confidenceScore ?? 0;
            updateData.ratingAiVerification = {
              accountNameMatch: ratingAiResult.accountNameMatch,
              productNameMatch: ratingAiResult.productNameMatch,
              screenshotCropped: ratingAiResult.screenshotCropped,
              detectedAccountName: ratingAiResult.detectedAccountName,
              detectedProductName: ratingAiResult.detectedProductName,
              confidenceScore: ratingAiResult.confidenceScore,
              discrepancyNote: ratingAiResult.discrepancyNote,
            };

            // Audit trail: record AI rating verification for backtracking
            writeAuditLog({
              req,
              action: 'AI_RATING_VERIFICATION',
              entityType: 'Order',
              entityId: order.mongoId!,
              metadata: {
                accountNameMatch: ratingAiResult.accountNameMatch,
                productNameMatch: ratingAiResult.productNameMatch,
                screenshotCropped: ratingAiResult.screenshotCropped,
                confidenceScore: ratingAiResult.confidenceScore,
                detectedAccountName: ratingAiResult.detectedAccountName,
                detectedProductName: ratingAiResult.detectedProductName,
                discrepancyNote: ratingAiResult.discrepancyNote,
              },
            });
          }
          if (order.rejectionType === 'rating') {
            updateData.rejectionType = null;
            updateData.rejectionReason = null;
            updateData.rejectionAt = null;
            updateData.rejectionBy = null;
          }
        } else if (body.type === 'returnWindow') {
          assertProofImageSize(body.data, 'Return window proof');

          // AI verification: check order ID, product name, amount, sold by
          let returnWindowResult: any = null;
          if (isGeminiConfigured(env)) {
            const expectedOrderId = String(order.externalOrderId || '').trim();
            const expectedProductName = String((order.items?.[0] as any)?.title || '').trim();
            const expectedAmount = (order.items ?? []).reduce(
              (acc: number, it: any) => acc + (Number(it?.priceAtPurchasePaise) || 0) * (Number(it?.quantity) || 1), 0
            ) / 100;
            const expectedSoldBy = String(order.soldBy || '').trim();
            // Reviewer name: delivery/return window screenshots often show "Ship to" / "Deliver to"
            // which is the marketplace account holder's name. When buyer ordered from someone
            // else's account, pass the reviewer name so AI can verify that name in the screenshot.
            const rwReviewerName = String(body.reviewerName || order.reviewerName || '').trim();
            if (expectedOrderId) {
              const aiStart = Date.now();
              returnWindowResult = await verifyReturnWindowWithAi(env, {
                imageBase64: body.data,
                expectedOrderId,
                expectedProductName,
                expectedAmount,
                expectedSoldBy: expectedSoldBy || undefined,
                ...(rwReviewerName ? { expectedReviewerName: rwReviewerName } : {}),
              });
              logPerformance({
                operation: 'AI_RETURN_WINDOW_VERIFICATION',
                durationMs: Date.now() - aiStart,
                metadata: { orderId: order.mongoId, confidenceScore: returnWindowResult?.confidenceScore },
              });
              // Hard-block 1: Order ID must match
              if (returnWindowResult && !returnWindowResult.orderIdMatch
                && returnWindowResult.confidenceScore > 0) {
                throw new AppError(422, 'RETURN_WINDOW_VERIFICATION_FAILED',
                  'Return window screenshot order ID does not match this order. ' +
                  'Please upload the correct return window screenshot. ' +
                  (returnWindowResult.discrepancyNote || ''));
              }
              // Hard-block 2: Product name must match
              if (returnWindowResult && !returnWindowResult.productNameMatch
                && returnWindowResult.confidenceScore > 0) {
                throw new AppError(422, 'RETURN_WINDOW_VERIFICATION_FAILED',
                  'Return window screenshot product does not match this order. ' +
                  'Please upload the correct return window screenshot. ' +
                  (returnWindowResult.discrepancyNote || ''));
              }
              // Hard-block 3: Seller/Sold by must match (when available)
              if (returnWindowResult && expectedSoldBy && !returnWindowResult.soldByMatch
                && returnWindowResult.confidenceScore > 0) {
                throw new AppError(422, 'RETURN_WINDOW_VERIFICATION_FAILED',
                  `Return window screenshot seller does not match "${expectedSoldBy}". ` +
                  'Please upload the correct return window screenshot. ' +
                  (returnWindowResult.discrepancyNote || ''));
              }
              // Hard-block 4: Reviewer name must match (when provided)
              if (returnWindowResult && rwReviewerName && !returnWindowResult.reviewerNameMatch
                && returnWindowResult.confidenceScore > 0) {
                throw new AppError(422, 'RETURN_WINDOW_VERIFICATION_FAILED',
                  `Return window screenshot account name does not match reviewer "${rwReviewerName}". ` +
                  `Detected: "${returnWindowResult.detectedAccountName || 'unknown'}". ` +
                  'Please upload a screenshot from the correct marketplace account. ' +
                  (returnWindowResult.discrepancyNote || ''));
              }
              // Hard-block 5: Screenshot must not be cropped/incomplete
              if (returnWindowResult && returnWindowResult.screenshotCropped === true) {
                throw new AppError(422, 'SCREENSHOT_INCOMPLETE',
                  'Your return window screenshot appears to be cropped or incomplete. ' +
                  'Please upload a FULL screenshot showing the complete delivery/return page including the page header. ' +
                  (returnWindowResult.discrepancyNote || ''));
              }
              // Return window open/closed, amount — stored for mediator review, NOT blocking
            }
          }

          updateData.screenshotReturnWindow = body.data;
          if (returnWindowResult) {
            claimAiConfidence = returnWindowResult.confidenceScore ?? 0;
            updateData.returnWindowAiVerification = returnWindowResult;
            // Audit trail: record AI return-window verification for backtracking
            writeAuditLog({
              req,
              action: 'AI_RETURN_WINDOW_VERIFICATION',
              entityType: 'Order',
              entityId: order.mongoId!,
              metadata: {
                orderIdMatch: returnWindowResult.orderIdMatch,
                productNameMatch: returnWindowResult.productNameMatch,
                amountMatch: returnWindowResult.amountMatch,
                soldByMatch: returnWindowResult.soldByMatch,
                reviewerNameMatch: returnWindowResult.reviewerNameMatch,
                screenshotCropped: returnWindowResult.screenshotCropped,
                confidenceScore: returnWindowResult.confidenceScore,
              },
            });
          }
          if (order.rejectionType === 'returnWindow') {
            updateData.rejectionType = null;
            updateData.rejectionReason = null;
            updateData.rejectionAt = null;
            updateData.rejectionBy = null;
          }
        } else if (body.type === 'order') {
          assertProofImageSize(body.data, 'Order proof');
          const expectedOrderId = String(order.externalOrderId || '').trim();

          if (env.NODE_ENV === 'test') {
            // Test runs should not rely on external AI services.
          } else if (isGeminiConfigured(env) && expectedOrderId) {
            const expectedAmount = (order.items ?? []).reduce(
              (acc: number, it: any) => acc + (Number(it?.priceAtPurchasePaise) || 0) * (Number(it?.quantity) || 1), 0
            ) / 100;
            const expectedProductName = String((order.items?.[0] as any)?.title || order.extractedProductName || '').trim();
            const expectedPlatform = String((order.items?.[0] as any)?.platform || '').trim();
            // Guard against NaN/Infinity from corrupted order data
            if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
              orderLog.warn(`[ordersController] Skipping AI re-upload verification: invalid expectedAmount=${expectedAmount} for order=${order.mongoId}`);
            } else {
              const aiStart = Date.now();
              aiOrderVerification = await verifyProofWithAi(env, {
                imageBase64: body.data,
                expectedOrderId,
                expectedAmount,
                ...(expectedProductName ? { expectedProductName } : {}),
                ...(expectedPlatform ? { expectedPlatform } : {}),
              });
              logPerformance({
                operation: 'AI_ORDER_REUPLOAD_VERIFICATION',
                durationMs: Date.now() - aiStart,
                metadata: { orderId: order.mongoId, confidenceScore: aiOrderVerification?.confidenceScore },
              });
              // Block re-upload if order ID clearly doesn't match (fraud prevention)
              if (aiOrderVerification && !aiOrderVerification.orderIdMatch
                && aiOrderVerification.confidenceScore > 0) {
                throw new AppError(422, 'ORDER_VERIFICATION_FAILED',
                  'Order screenshot does not match: the order ID in the screenshot does not match this order. ' +
                  (aiOrderVerification.discrepancyNote || ''));
              }
              // Block re-upload if product name doesn't match (fraud prevention)
              if (aiOrderVerification && expectedProductName
                && aiOrderVerification.productNameMatch !== true) {
                throw new AppError(422, 'ORDER_VERIFICATION_FAILED',
                  'Order screenshot product does not match this order. ' +
                  'Please upload the correct order screenshot. ' +
                  (aiOrderVerification.discrepancyNote || ''));
              }
              // Block re-upload if platform doesn't match (fraud prevention — e.g. Amazon deal with Flipkart screenshot)
              if (aiOrderVerification && expectedPlatform
                && aiOrderVerification.platformMatch === false
                && aiOrderVerification.confidenceScore > 0) {
                throw new AppError(422, 'PLATFORM_MISMATCH',
                  `Order screenshot is from "${aiOrderVerification.detectedPlatform || 'unknown platform'}" but this order is for ${expectedPlatform}. ` +
                  'Please upload a screenshot from the correct platform. ' +
                  (aiOrderVerification.discrepancyNote || ''));
              }
              // Block re-upload if screenshot is cropped/incomplete (fraud prevention)
              if (aiOrderVerification && aiOrderVerification.screenshotCropped === true) {
                throw new AppError(422, 'SCREENSHOT_INCOMPLETE',
                  'Your order screenshot appears to be cropped or incomplete. ' +
                  'Please upload a FULL screenshot showing the complete order page including the page header. ' +
                  (aiOrderVerification.discrepancyNote || ''));
              }
            }
          }

          updateData.screenshotOrder = body.data;
          // Persist AI purchase proof verification result
          if (aiOrderVerification) {
            claimAiConfidence = aiOrderVerification.confidenceScore ?? 0;
            updateData.orderAiVerification = {
              orderIdMatch: aiOrderVerification.orderIdMatch,
              amountMatch: aiOrderVerification.amountMatch,
              productNameMatch: aiOrderVerification.productNameMatch,
              platformMatch: aiOrderVerification.platformMatch,
              screenshotCropped: aiOrderVerification.screenshotCropped,
              detectedOrderId: aiOrderVerification.detectedOrderId,
              detectedAmount: aiOrderVerification.detectedAmount,
              detectedProductName: aiOrderVerification.detectedProductName,
              detectedPlatform: aiOrderVerification.detectedPlatform,
              confidenceScore: aiOrderVerification.confidenceScore,
              discrepancyNote: aiOrderVerification.discrepancyNote,
              verificationMethod: aiOrderVerification.verificationMethod,
            };
          }
          if (order.rejectionType === 'order') {
            updateData.rejectionType = null;
            updateData.rejectionReason = null;
            updateData.rejectionAt = null;
            updateData.rejectionBy = null;
          }

          // Audit trail: record AI purchase proof verification for backtracking
          if (aiOrderVerification) {
            writeAuditLog({
              req,
              action: 'AI_PURCHASE_PROOF_VERIFICATION',
              entityType: 'Order',
              entityId: order.mongoId!,
              metadata: {
                orderIdMatch: aiOrderVerification.orderIdMatch,
                amountMatch: aiOrderVerification.amountMatch,
                productNameMatch: aiOrderVerification.productNameMatch,
                platformMatch: aiOrderVerification.platformMatch,
                screenshotCropped: aiOrderVerification.screenshotCropped,
                confidenceScore: aiOrderVerification.confidenceScore,
                detectedPlatform: aiOrderVerification.detectedPlatform,
                verificationMethod: aiOrderVerification.verificationMethod,
              },
            });
          }
        }

        // Filter missingProofRequests
        const currentMPR = Array.isArray(order.missingProofRequests) ? (order.missingProofRequests as any[]) : [];
        updateData.missingProofRequests = currentMPR.filter(
          (r: any) => String(r?.type) !== String(body.type)
        );

        // Persist marketplace reviewer/profile name if provided alongside any proof upload.
        // Lock the name after first submission — buyer cannot change it between proof uploads
        // to prevent using different accounts for different proofs.
        // Uses atomic conditional update to prevent race conditions from concurrent uploads.
        if (body.reviewerName) {
          if (!order.reviewerName) {
            // Atomic: only set if still null (prevents race where two concurrent uploads both see null)
            const atomicResult = await db().order.updateMany({
              where: { id: order.id, reviewerName: null },
              data: { reviewerName: body.reviewerName },
            });
            if (atomicResult.count === 0) {
              // Another request set it first — re-fetch and verify it matches
              const freshOrder = await db().order.findUnique({ where: { id: order.id }, select: { reviewerName: true } });
              if (freshOrder?.reviewerName && body.reviewerName.trim().toLowerCase() !== String(freshOrder.reviewerName).trim().toLowerCase()) {
                throw new AppError(409, 'REVIEWER_NAME_LOCKED',
                  `Reviewer name is locked to "${freshOrder.reviewerName}" from your first proof upload. Use the same marketplace account for all proofs.`);
              }
            }
            // Don't set updateData.reviewerName — already persisted atomically above
          } else if (body.reviewerName.trim().toLowerCase() !== String(order.reviewerName).trim().toLowerCase()) {
            orderLog.warn('Reviewer name change attempt blocked', {
              orderId: order.mongoId,
              existingName: order.reviewerName,
              attemptedName: body.reviewerName,
            });
            throw new AppError(409, 'REVIEWER_NAME_LOCKED',
              `Reviewer name is locked to "${order.reviewerName}" from your first proof upload. Use the same marketplace account for all proofs.`);
          }
        }

        const affiliateStatus = String(order.affiliateStatus || '');
        if (affiliateStatus === 'Fraud_Alert') {
          throw new AppError(409, 'ORDER_FRAUD_FLAGGED', 'This order is flagged for fraud and requires admin review');
        }
        if (affiliateStatus === 'Rejected') {
          updateData.affiliateStatus = 'Unchecked';
        }

        // Push event
        const currentEvents = Array.isArray(order.events) ? (order.events as any[]) : [];
        updateData.events = pushOrderEvent(currentEvents, {
          type: 'PROOF_SUBMITTED',
          at: new Date(),
          actorUserId: requesterId,
          metadata: {
            type: body.type,
            ...(body.type === 'order' && aiOrderVerification ? { aiVerification: aiOrderVerification } : {}),
          },
        });

        await db().order.update({ where: { id: order.id }, data: updateData });

        // If order is already APPROVED (e.g. during cooling period), save the proof
        // without rewinding the workflow. This handles orders approved before
        // returnWindow was required, and late proof uploads for already-approved orders.
        // Also auto-verify the proof step if AI passed hard-block validation.
        if (wf === 'APPROVED') {
          // Auto-verify the submitted proof step for audit trail completeness
          if (claimAiConfidence > 0) {
            const v = (order.verification && typeof order.verification === 'object')
              ? { ...(order.verification as any) } : {} as any;
            const vKey = body.type === 'order' ? 'order' : body.type;
            if (!v[vKey]?.verifiedAt) {
              v[vKey] = v[vKey] ?? {};
              v[vKey].verifiedAt = new Date().toISOString();
              v[vKey].verifiedBy = 'SYSTEM_AI';
              v[vKey].autoVerified = true;
              v[vKey].aiConfidenceScore = claimAiConfidence;
              await db().order.update({
                where: { id: order.id },
                data: { verification: v },
              });
            }
          }
          const refreshed = await db().order.findFirst({ where: { id: order.id, isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
          res.json(toUiOrder(pgOrder(refreshed)));
          try {
            const privilegedRoles: Role[] = ['admin', 'ops'];
            const managerCode = String(order.managerName || '').trim();
            const [mediatorUser, orderUser, brandUser] = await Promise.all([
              managerCode
                ? db().user.findFirst({
                  where: { roles: { has: 'mediator' as any }, mediatorCode: managerCode, isDeleted: false },
                  select: { parentCode: true },
                })
                : null,
              db().user.findUnique({ where: { id: order.userId }, select: { mongoId: true } }),
              order.brandUserId
                ? db().user.findUnique({ where: { id: order.brandUserId }, select: { mongoId: true } })
                : null,
            ]);
            const upstreamAgencyCode = String(mediatorUser?.parentCode || '').trim();
            const audience = {
              roles: privilegedRoles,
              userIds: [orderUser?.mongoId ?? '', brandUser?.mongoId ?? ''].filter(Boolean),
              mediatorCodes: managerCode ? [managerCode] : undefined,
              agencyCodes: upstreamAgencyCode ? [upstreamAgencyCode] : undefined,
            };
            publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
            await writeAuditLog({ req, action: 'PROOF_SUBMITTED', entityType: 'Order', entityId: order.mongoId!, metadata: { proofType: body.type, approvedLateUpload: true } });
            logChangeEvent({ actorUserId: req.auth?.userId, actorRoles: req.auth?.roles, actorIp: req.ip, entityType: 'Order', entityId: order.mongoId!, action: 'STATUS_CHANGE', requestId: String((res as any).locals?.requestId || ''), metadata: { proofType: body.type, action: 'PROOF_SUBMITTED_AFTER_APPROVAL' } });
          } catch (postErr) {
            orderLog.warn('Post-response notification failed (approved late upload)', { error: postErr instanceof Error ? postErr.message : String(postErr) });
          }
          return;
        }

        // Strict state machine progression for first proof submission:
        // ORDERED -> PROOF_SUBMITTED -> UNDER_REVIEW
        // If already UNDER_REVIEW, we just persist the new proof without rewinding workflow.
        if (wf === 'UNDER_REVIEW') {
          let refreshed = await db().order.findFirst({ where: { id: order.id, isDeleted: false }, include: { items: { where: { isDeleted: false } } } });

          // ── Auto-verify by AI confidence (submitClaim, already UNDER_REVIEW) ──
          // Any proof that passed AI hard-block validation (confidence > 0) is auto-verified.
          const autoThreshold = env.AI_AUTO_VERIFY_THRESHOLD ?? 90;
          if (claimAiConfidence >= autoThreshold && refreshed) {
            refreshed = await autoVerifyStep(refreshed, body.type, claimAiConfidence, autoThreshold, env);
          }

          res.json(toUiOrder(pgOrder(refreshed)));

          // Post-response: notify UIs and write audit trail for re-upload
          try {
            const privilegedRoles: Role[] = ['admin', 'ops'];
            const managerCode = String(order.managerName || '').trim();
            const [mediatorUser, orderUser, brandUser] = await Promise.all([
              managerCode
                ? db().user.findFirst({
                  where: { roles: { has: 'mediator' as any }, mediatorCode: managerCode, isDeleted: false },
                  select: { parentCode: true },
                })
                : null,
              db().user.findUnique({ where: { id: order.userId }, select: { mongoId: true } }),
              order.brandUserId
                ? db().user.findUnique({ where: { id: order.brandUserId }, select: { mongoId: true } })
                : null,
            ]);
            const upstreamAgencyCode = String(mediatorUser?.parentCode || '').trim();
            const audience = {
              roles: privilegedRoles,
              userIds: [orderUser?.mongoId ?? '', brandUser?.mongoId ?? ''].filter(Boolean),
              mediatorCodes: managerCode ? [managerCode] : undefined,
              agencyCodes: upstreamAgencyCode ? [upstreamAgencyCode] : undefined,
            };
            publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
            await writeAuditLog({ req, action: 'PROOF_SUBMITTED', entityType: 'Order', entityId: order.mongoId!, metadata: { proofType: body.type, reUpload: true } });
            logChangeEvent({ actorUserId: req.auth?.userId, actorRoles: req.auth?.roles, actorIp: req.ip, entityType: 'Order', entityId: order.mongoId!, action: 'STATUS_CHANGE', requestId: String((res as any).locals?.requestId || ''), metadata: { proofType: body.type, action: 'PROOF_RESUBMITTED' } });
          } catch (postErr) {
            orderLog.warn('Post-response notification failed (re-upload)', { error: postErr instanceof Error ? postErr.message : String(postErr) });
          }
          return;
        }

        const _afterProof = await transitionOrderWorkflow({
          orderId: order.mongoId!,
          from: order.workflowStatus as any,
          to: 'PROOF_SUBMITTED' as any,
          actorUserId: String(requesterId || ''),
          metadata: { proofType: body.type },
          env,
        });

        const afterReview = await transitionOrderWorkflow({
          orderId: order.mongoId!,
          from: 'PROOF_SUBMITTED' as any,
          to: 'UNDER_REVIEW' as any,
          actorUserId: undefined,
          metadata: { system: true },
          env,
        });

        // ── Auto-verify by AI confidence (submitClaim, new UNDER_REVIEW) ──
        let claimFinalOrder: any = afterReview;
        const autoThreshold2 = env.AI_AUTO_VERIFY_THRESHOLD ?? 90;
        if (claimAiConfidence >= autoThreshold2 && afterReview) {
          const freshOrder = await db().order.findFirst({
            where: { id: order.id, isDeleted: false },
            include: { items: { where: { isDeleted: false } } },
          });
          if (freshOrder) {
            claimFinalOrder = await autoVerifyStep(freshOrder, body.type, claimAiConfidence, autoThreshold2, env);
          }
        }

        res.json(toUiOrder(pgOrder(claimFinalOrder)));

        // Post-response: notify UIs (wrapped in try/catch since response already sent)
        try {
        const privilegedRoles: Role[] = ['admin', 'ops'];
        const managerCode = String(order.managerName || '').trim();
        // Parallelize all user lookups — mediator, order owner, brand user
        const [mediatorUser, orderUser, brandUser] = await Promise.all([
          managerCode
            ? db().user.findFirst({
              where: { roles: { has: 'mediator' as any }, mediatorCode: managerCode, isDeleted: false },
              select: { parentCode: true },
            })
            : null,
          db().user.findUnique({ where: { id: order.userId }, select: { mongoId: true } }),
          order.brandUserId
            ? db().user.findUnique({ where: { id: order.brandUserId }, select: { mongoId: true } })
            : null,
        ]);
        const upstreamAgencyCode = String(mediatorUser?.parentCode || '').trim();

        const audience = {
          roles: privilegedRoles,
          userIds: [orderUser?.mongoId ?? '', brandUser?.mongoId ?? ''].filter(Boolean),
          mediatorCodes: managerCode ? [managerCode] : undefined,
          agencyCodes: upstreamAgencyCode ? [upstreamAgencyCode] : undefined,
        };

        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        // Audit log: proof submission
        await writeAuditLog({
          req, action: 'PROOF_SUBMITTED', entityType: 'Order',
          entityId: order.mongoId!,
          metadata: { proofType: body.type },
        }).catch((err: unknown) => { orderLog.warn('Audit log failed', { error: err instanceof Error ? err.message : String(err) }); });

        businessLog.info('Proof submitted', { orderId: order.mongoId, proofType: body.type, userId: req.auth?.userId, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Order',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'PROOF_SUBMITTED', orderId: order.mongoId, proofType: body.type },
        });

        logChangeEvent({
          actorUserId: req.auth?.userId,
          actorRoles: req.auth?.roles,
          actorIp: req.ip,
          entityType: 'Order',
          entityId: order.mongoId!,
          action: 'STATUS_CHANGE',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { proofType: body.type, action: 'PROOF_SUBMITTED' },
        });
        } catch (postErr) {
          orderLog.warn('Post-response notification failed (submitClaim)', { error: postErr instanceof Error ? postErr.message : String(postErr) });
        }
        return;
      } catch (err) {
        logErrorEvent({
          message: 'submitClaim failed',
          category: 'BUSINESS_LOGIC',
          severity: 'high',
          userId: req.auth?.userId,
          ip: req.ip,
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        next(err);
      }
    },

    /** Set reviewer/marketplace account name on an existing order (one-time, cannot change after). */
    setReviewerName: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orderId = String(req.params.orderId || '').trim();
        if (!orderId) throw new AppError(400, 'INVALID_ORDER_ID', 'Missing order ID');

        const rawName = String(req.body?.reviewerName ?? '').replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim();
        if (!rawName || rawName.length > 200) {
          throw new AppError(400, 'INVALID_REVIEWER_NAME', 'Please enter a valid marketplace account name (1-200 characters).');
        }

        const requesterId = req.auth?.userId;
        if (!requesterId) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

        // Look up the order
        const orderWhere = UUID_RE.test(orderId)
          ? { OR: [{ id: orderId }, { mongoId: orderId }] as any, isDeleted: false }
          : { mongoId: orderId, isDeleted: false };
        const order = await db().order.findFirst({
          where: orderWhere as any,
          select: { id: true, mongoId: true, userId: true, reviewerName: true },
        });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        // Only the order owner can set the reviewer name.
        // order.userId is the PG UUID; requesterId may be either PG UUID or mongoId.
        const ownerPgId = String(order.userId);
        const requesterPgId = String(req.auth?.pgUserId ?? requesterId);
        if (ownerPgId !== requesterPgId && ownerPgId !== String(requesterId)) {
          throw new AppError(403, 'FORBIDDEN', 'You can only update your own orders');
        }

        // Cannot change if already set (anti-cheat: reviewer name is immutable once committed)
        if (order.reviewerName) {
          throw new AppError(409, 'REVIEWER_NAME_ALREADY_SET', 'Marketplace account name is already set and cannot be changed.');
        }

        // Atomic conditional update: only set if still null
        const updated = await db().order.updateMany({
          where: { id: order.id, reviewerName: null, isDeleted: false },
          data: { reviewerName: rawName },
        });

        if (!updated.count) {
          throw new AppError(409, 'REVIEWER_NAME_ALREADY_SET', 'Marketplace account name was already set by another request.');
        }

        writeAuditLog({
          req,
          action: 'order.set_reviewer_name',
          entityType: 'Order',
          entityId: order.mongoId ?? order.id,
          metadata: { reviewerName: rawName },
        });

        businessLog.info(`[Order] Reviewer name set for order ${order.mongoId}: "${rawName}"`, {
          actorUserId: requesterId, orderId: order.mongoId, reviewerName: rawName,
        });

        res.json({ success: true, reviewerName: rawName });
      } catch (err) {
        logErrorEvent({
          message: 'setReviewerName failed',
          category: 'BUSINESS_LOGIC',
          severity: 'medium',
          userId: req.auth?.userId,
          ip: req.ip,
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        next(err);
      }
    },
  };
}
