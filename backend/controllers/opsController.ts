import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import type { Role } from '../middleware/auth.js';
import { prisma as db } from '../database/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { orderLog, pushLog, businessLog, walletLog } from '../config/logger.js';
import { logChangeEvent, logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { pgUser, pgOrder, pgCampaign, pgDeal, pgWallet } from '../utils/pgMappers.js';
import {
  approveByIdSchema,
  assignSlotsSchema,
  createCampaignSchema,
  cancelOrderProofsSchema,
  payoutMediatorSchema,
  publishDealSchema,
  rejectByIdSchema,
  rejectOrderProofSchema,
  requestMissingProofSchema,
  settleOrderSchema,
  unsettleOrderSchema,
  updateCampaignStatusSchema,
  verifyOrderRequirementSchema,
  verifyOrderSchema,
  opsOrdersQuerySchema,
  opsMediatorQuerySchema,
  opsCodeQuerySchema,
  opsCampaignsQuerySchema,
  opsDealsQuerySchema,
  copyCampaignSchema,
  declineOfferSchema,
  forceApproveOrderSchema,
  cancelOrderSchema,
} from '../validations/ops.js';
import { rupeesToPaise } from '../utils/money.js';
import { toUiCampaign, toUiDeal, toUiOrder, toUiOrderSummary, toUiUser, safeIso } from '../utils/uiMappers.js';
import { orderListSelectLite, getProofFlags, userListSelect, campaignListSelect, dealListSelect } from '../utils/querySelect.js';
import { idWhere } from '../utils/idWhere.js';
import { ensureWallet, applyWalletDebit, applyWalletCredit } from '../services/walletService.js';
import { getRequester, isPrivileged, requireAnyRole } from '../services/authz.js';
import { listMediatorCodesForAgency, getAgencyCodeForMediatorCode, getAgencyCodesForMediatorCodes, isAgencyActive, isMediatorActive } from '../services/lineage.js';
import { pushOrderEvent } from '../services/orderEvents.js';
import { writeAuditLog } from '../services/audit.js';
import { requestBrandConnectionSchema } from '../validations/connections.js';
import { transitionOrderWorkflow } from '../services/orderWorkflow.js';
import { publishRealtime } from '../services/realtimeHub.js';
import { sendPushToUser } from '../services/pushNotifications.js';
import { normalizeMediatorCode } from '../utils/mediatorCode.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { authCacheInvalidate } from '../utils/authCache.js';

async function buildOrderAudience(order: any, agencyCode?: string) {
  const privilegedRoles: Role[] = ['admin', 'ops'];
  const managerCode = String(order?.managerName || '').trim();
  const normalizedAgencyCode = String(agencyCode || '').trim();

  // Resolve PG UUIDs â†’ mongoIds for realtime (frontend matches by JWT sub = mongoId)
  const [buyerUser, brandUser] = await Promise.all([
    order?.userId ? db().user.findUnique({ where: { id: order.userId }, select: { mongoId: true } }) : null,
    order?.brandUserId ? db().user.findUnique({ where: { id: order.brandUserId }, select: { mongoId: true } }) : null,
  ]);
  const buyerMongoId = buyerUser?.mongoId ?? '';
  const brandMongoId = brandUser?.mongoId ?? '';

  return {
    roles: privilegedRoles,
    userIds: [buyerMongoId, brandMongoId].filter(Boolean),
    mediatorCodes: managerCode ? [managerCode] : undefined,
    agencyCodes: normalizedAgencyCode ? [normalizedAgencyCode] : undefined,
    buyerMongoId,
  };
}

export function getRequiredStepsForOrder(order: any): Array<'review' | 'rating' | 'returnWindow'> {
  const dealTypes = (order.items ?? [])
    .map((it: any) => String(it?.dealType || ''))
    .filter(Boolean);
  const requiresReview = dealTypes.includes('Review');
  const requiresRating = dealTypes.includes('Rating');
  // All deal types (including Discount/purchase) require return window proof
  const requiresReturnWindow = true;
  return [
    ...(requiresReview ? (['review'] as const) : []),
    ...(requiresRating ? (['rating'] as const) : []),
    ...(requiresReturnWindow ? (['returnWindow'] as const) : []),
  ];
}

export function hasProofForRequirement(order: any, type: 'review' | 'rating' | 'returnWindow'): boolean {
  if (type === 'review') return !!(order.reviewLink || order.screenshotReview);
  if (type === 'returnWindow') return !!order.screenshotReturnWindow;
  return !!order.screenshotRating;
}

export function isRequirementVerified(order: any, type: 'review' | 'rating' | 'returnWindow'): boolean {
  const v = (order.verification && typeof order.verification === 'object') ? order.verification as any : {};
  return !!v[type]?.verifiedAt;
}

/**
 * Shared authorization + suspension guard for order-scoped ops handlers.
 * Verifies: frozen check, role-based scope (mediator/agency hierarchy), mediator/agency active status.
 * Returns the resolved agencyCode for realtime audience building.
 */
async function assertOrderAccess(order: any, roles: string[], requester: any): Promise<string> {
  if ((order as any).frozen) {
    throw new AppError(409, 'ORDER_FROZEN', 'Order is frozen and requires explicit reactivation');
  }

  if (!isPrivileged(roles)) {
    if (roles.includes('mediator')) {
      if (String(order.managerName).trim() !== String(requester?.mediatorCode).trim()) {
        throw new AppError(403, 'FORBIDDEN', 'Cannot verify orders outside your network');
      }
    } else if (roles.includes('agency')) {
      const allowed = await listMediatorCodesForAgency(String(requester?.mediatorCode || '').trim());
      if (!allowed.includes(String(order.managerName).trim())) {
        throw new AppError(403, 'FORBIDDEN', 'Cannot verify orders outside your network');
      }
    } else {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
    }
  }

  const managerCode = String(order.managerName || '');
  if (!(await isMediatorActive(managerCode))) {
    throw new AppError(409, 'FROZEN_SUSPENSION', 'Mediator is suspended; order is frozen');
  }
  const agencyCode = (await getAgencyCodeForMediatorCode(managerCode)) || '';
  if (agencyCode && !(await isAgencyActive(agencyCode))) {
    throw new AppError(409, 'FROZEN_SUSPENSION', 'Agency is suspended; order is frozen');
  }
  return agencyCode;
}

export async function finalizeApprovalIfReady(order: any, actorUserId: string, env: Env) {
  const wf = String(order.workflowStatus || 'CREATED');
  if (wf !== 'UNDER_REVIEW') return { approved: false, reason: 'NOT_UNDER_REVIEW' };

  const verification = (order.verification && typeof order.verification === 'object') ? order.verification as any : {};
  if (!verification.order?.verifiedAt) {
    return { approved: false, reason: 'PURCHASE_NOT_VERIFIED' };
  }

  if (!Array.isArray(order.items) || order.items.length === 0) {
    return { approved: false, reason: 'NO_ITEMS' };
  }

  const required = getRequiredStepsForOrder(order);
  const missingProofs = required.filter((t) => !hasProofForRequirement(order, t));
  if (missingProofs.length) return { approved: false, reason: 'MISSING_PROOFS', missingProofs };

  const missingVerifications = required.filter((t) => !isRequirementVerified(order, t));
  if (missingVerifications.length) {
    return { approved: false, reason: 'MISSING_VERIFICATIONS', missingVerifications };
  }

  const COOLING_PERIOD_DAYS = env.COOLING_PERIOD_DAYS ?? 14;
  const settleDate = new Date();
  settleDate.setDate(settleDate.getDate() + COOLING_PERIOD_DAYS);
  const currentEvents = Array.isArray(order.events) ? (order.events as any[]) : [];

  orderLog.info('All proofs verified â€” approving order', {
    orderId: order.mongoId,
    coolingDays: COOLING_PERIOD_DAYS,
    settlementDate: settleDate.toISOString(),
    verifiedSteps: required,
    actorUserId,
  });

  // Use updateMany with workflowStatus guard to prevent duplicate events on concurrent verify.
  // If count is 0, another request already approved or modified the order — idempotent return.
  const updated = await db().order.updateMany({
    where: { id: order.id, workflowStatus: 'UNDER_REVIEW' },
    data: {
      affiliateStatus: 'Pending_Cooling',
      expectedSettlementDate: settleDate,
      events: pushOrderEvent(currentEvents, {
        type: 'VERIFIED',
        at: new Date(),
        actorUserId,
        metadata: { step: 'finalize' },
      }),
    },
  });

  if (updated.count === 0) {
    // Re-check: if the order was already APPROVED by a concurrent request, treat as success
    const recheck = await db().order.findFirst({
      where: { id: order.id, isDeleted: false },
      select: { workflowStatus: true },
    });
    if (recheck?.workflowStatus === 'APPROVED') {
      return { approved: true, reason: 'ALREADY_APPROVED' };
    }
    return { approved: false, reason: 'CONCURRENT_UPDATE' };
  }

  await transitionOrderWorkflow({
    orderId: order.mongoId!,
    from: 'UNDER_REVIEW',
    to: 'APPROVED',
    actorUserId: String(actorUserId || ''),
    metadata: { source: 'finalizeApprovalIfReady' },
    env,
  });

  return { approved: true };
}
export function makeOpsController(env: Env) {
  return {
    requestBrandConnection: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = requestBrandConnectionSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);
        if (!roles.includes('agency')) {
          throw new AppError(403, 'FORBIDDEN', 'Only agencies can request brand connection');
        }

        const agencyCode = String((requester as any)?.mediatorCode || '').trim();
        if (!agencyCode) throw new AppError(409, 'MISSING_AGENCY_CODE', 'Agency is missing a code');

        const brand = await db().user.findFirst({
          where: { brandCode: body.brandCode, roles: { has: 'brand' as any }, isDeleted: false },
          select: { id: true, mongoId: true, status: true, connectedAgencies: true },
        });
        if (!brand) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
        if (brand.status !== 'active') throw new AppError(409, 'BRAND_SUSPENDED', 'Brand is not active');

        // Check if already connected
        if (Array.isArray(brand.connectedAgencies) && brand.connectedAgencies.includes(agencyCode)) {
          throw new AppError(409, 'ALREADY_REQUESTED', 'Connection already exists or is already pending');
        }

        const agencyName = String((requester as any)?.name || 'Agency');

        // [PERF] Parallel fetch: pendingCount + existingPending are independent
        const [pendingCount, existingPending] = await Promise.all([
          db().pendingConnection.count({ where: { userId: brand.id, isDeleted: false } }),
          db().pendingConnection.findFirst({ where: { userId: brand.id, agencyCode, isDeleted: false } }),
        ]);
        if (pendingCount >= 100) {
          throw new AppError(409, 'TOO_MANY_PENDING', 'Brand has too many pending connection requests');
        }
        if (existingPending) {
          throw new AppError(409, 'ALREADY_REQUESTED', 'Connection already exists or is already pending');
        }

        const requesterMongoId = String((requester as any)?._id || '');
        await db().pendingConnection.create({
          data: {
            userId: brand.id,
            agencyId: requesterMongoId,
            agencyName,
            agencyCode,
            timestamp: new Date(),
          },
        });

        await writeAuditLog({
          req,
          action: 'BRAND_CONNECTION_REQUESTED',
          entityType: 'User',
          entityId: brand.mongoId!,
          metadata: { agencyCode, brandCode: body.brandCode },
        });
        businessLog.info('Brand connection requested', { brandCode: body.brandCode, agencyCode, brandId: brand.mongoId, requestedBy: req.auth?.userId });
        logChangeEvent({ actorUserId: String(req.auth?.userId || ''), entityType: 'PendingConnection', entityId: brand.mongoId!, action: 'BRAND_CONNECTION_REQUESTED', metadata: { agencyCode, brandCode: body.brandCode, agencyName } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'PendingConnection', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'BRAND_CONNECTION_REQUESTED', brandCode: body.brandCode } });

        const privilegedRoles: Role[] = ['admin', 'ops'];
        const brandMongoId = brand.mongoId ?? '';
        const audience = {
          roles: privilegedRoles,
          userIds: [brandMongoId, requesterMongoId].filter(Boolean),
          agencyCodes: agencyCode ? [agencyCode] : undefined,
        };
        publishRealtime({ type: 'users.changed', ts: new Date().toISOString(), payload: { userId: brandMongoId }, audience });
        publishRealtime({
          type: 'users.changed',
          ts: new Date().toISOString(),
          payload: { userId: requesterMongoId },
          audience,
        });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/requestBrandConnection' } });
        next(err);
      }
    },
    getMediators: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const queryParams = opsMediatorQuerySchema.parse(req.query);
        const requested = queryParams.agencyCode || '';

        const agencyCode = isPrivileged(roles) ? requested : String((user as any)?.mediatorCode || '');
        if (!agencyCode) throw new AppError(400, 'INVALID_AGENCY_CODE', 'agencyCode required');
        if (!isPrivileged(roles)) requireAnyRole(roles, 'agency');

        const where: any = {
          roles: { has: 'mediator' as any },
          parentCode: agencyCode,
          isDeleted: false,
        };
        if (queryParams.search) {
          const search = queryParams.search;
          where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { mobile: { contains: search, mode: 'insensitive' } },
            { mediatorCode: { contains: search, mode: 'insensitive' } },
          ];
        }

        const { limit, skip } = parsePagination(req.query as any, { limit: 100, maxLimit: 500 });

        const mediators = await db().user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: { ...userListSelect, wallets: { where: { isDeleted: false }, take: 1, select: { id: true, availablePaise: true, pendingPaise: true } } },
        });

        const mediatorList = mediators.map((m: any) => {
          const wallet = m.wallets?.[0];
          return toUiUser(pgUser(m), wallet ? pgWallet(wallet) : undefined);
        });
        res.json(mediatorList);

        businessLog.info('Mediators listed', { userId: req.auth?.userId, resultCount: mediatorList.length, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Mediator',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'MEDIATORS_LISTED', endpoint: 'getMediators', resultCount: mediatorList.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getMediators' } });
        next(err);
      }
    },

    getCampaigns: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const queryParams = opsCampaignsQuerySchema.parse(req.query);
        const requested = queryParams.mediatorCode || undefined;
        const code = isPrivileged(roles) ? requested : String((user as any)?.mediatorCode || '');

        const { limit: cLimit, skip: cSkip } = parsePagination(req.query as any, { limit: 100, maxLimit: 500 });
        const statusFilter = queryParams.status && queryParams.status !== 'all' ? queryParams.status : null;

        let campaigns: any[];
        if (code) {
          // Use raw SQL for JSONB key-exists check (assignments ? code)
          let matchingIds: string[];
          if (!isPrivileged(roles) && roles.includes('agency')) {
            const mediatorCodes = await listMediatorCodesForAgency(code);
            const allCodes = [code, ...mediatorCodes].filter(Boolean);
            const rows = statusFilter
              ? await db().$queryRaw<{ id: string }[]>`
                  SELECT id FROM "campaigns" WHERE "is_deleted" = false AND status = ${statusFilter}
                  AND (${code} = ANY("allowed_agency_codes")
                       OR "open_to_all" = true
                       OR EXISTS (SELECT 1 FROM unnest(${allCodes}::text[]) AS mc WHERE jsonb_exists(assignments, mc)))
                `
              : await db().$queryRaw<{ id: string }[]>`
                  SELECT id FROM "campaigns" WHERE "is_deleted" = false
                  AND (${code} = ANY("allowed_agency_codes")
                       OR "open_to_all" = true
                       OR EXISTS (SELECT 1 FROM unnest(${allCodes}::text[]) AS mc WHERE jsonb_exists(assignments, mc)))
                `;
            matchingIds = rows.map((r) => r.id);
          } else {
            const rows = statusFilter
              ? await db().$queryRaw<{ id: string }[]>`
                  SELECT id FROM "campaigns" WHERE "is_deleted" = false AND status = ${statusFilter}
                  AND (${code} = ANY("allowed_agency_codes") OR jsonb_exists(assignments, ${code}) OR "open_to_all" = true)
                `
              : await db().$queryRaw<{ id: string }[]>`
                  SELECT id FROM "campaigns" WHERE "is_deleted" = false
                  AND (${code} = ANY("allowed_agency_codes") OR jsonb_exists(assignments, ${code}) OR "open_to_all" = true)
                `;
            matchingIds = rows.map((r) => r.id);
          }

          campaigns = matchingIds.length
            ? await db().campaign.findMany({
              where: { id: { in: matchingIds } },
              orderBy: { createdAt: 'desc' },
              skip: cSkip,
              take: cLimit,
              select: campaignListSelect,
            })
            : [];
        } else {
          campaigns = await db().campaign.findMany({
            where: {
              isDeleted: false,
              ...(statusFilter ? { status: statusFilter as any } : {}),
            },
            orderBy: { createdAt: 'desc' },
            skip: cSkip,
            take: cLimit,
            select: campaignListSelect,
          });
        }

        const requesterMediatorCode = roles.includes('mediator') ? String((user as any)?.mediatorCode || '').trim() : '';

        const normalizeCode = (v: unknown) => String(v || '').trim();
        const findAssignmentForMediator = (assignments: any, mediatorCode: string) => {
          const target = normalizeCode(mediatorCode);
          if (!target) return null;
          const obj = assignments && typeof assignments === 'object' ? assignments : {};
          if (Object.prototype.hasOwnProperty.call(obj, target)) return (obj as any)[target] ?? null;
          const targetLower = target.toLowerCase();
          for (const [k, v] of Object.entries(obj)) {
            if (String(k).trim().toLowerCase() === targetLower) return v as any;
          }
          return null;
        };

        const ui = campaigns.map((c: any) => {
          const mapped = toUiCampaign(pgCampaign(c));
          if (requesterMediatorCode) {
            const assignment = findAssignmentForMediator(c.assignments, requesterMediatorCode);
            const commissionPaise = Number((assignment as any)?.commissionPaise ?? 0);
            (mapped as any).assignmentCommission = Math.round(commissionPaise) / 100;
            const assignmentPayoutPaise = Number((assignment as any)?.payout ?? c.payoutPaise ?? 0);
            (mapped as any).assignmentPayout = Math.round(assignmentPayoutPaise) / 100;
          }
          return mapped;
        });
        res.json(ui);

        businessLog.info('Campaigns listed', { userId: req.auth?.userId, resultCount: ui.length, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Campaign',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'CAMPAIGNS_LISTED', endpoint: 'getCampaigns', resultCount: ui.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getCampaigns' } });
        next(err);
      }
    },

    getDeals: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const queryParams = opsDealsQuerySchema.parse(req.query);
        const requestedCode = queryParams.mediatorCode || '';

        let mediatorCodes: string[] = [];
        if (isPrivileged(roles)) {
          if (!requestedCode) throw new AppError(400, 'INVALID_CODE', 'mediatorCode required');
          const requestedRole = queryParams.role || '';
          if (requestedRole === 'agency') {
            mediatorCodes = await listMediatorCodesForAgency(requestedCode);
          } else {
            mediatorCodes = [requestedCode];
          }
        } else if (roles.includes('mediator')) {
          mediatorCodes = [String((user as any)?.mediatorCode || '')];
        } else if (roles.includes('agency')) {
          mediatorCodes = await listMediatorCodesForAgency(String((user as any)?.mediatorCode || ''));
        } else {
          throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
        }

        mediatorCodes = mediatorCodes.map((code) => normalizeMediatorCode(code)).filter(Boolean);
        if (!mediatorCodes.length) {
          res.json([]);
          return;
        }

        const { limit: dLimit, skip: dSkip } = parsePagination(req.query as any, { limit: 100, maxLimit: 500 });
        const deals = await db().deal.findMany({
          where: {
            mediatorCode: { in: mediatorCodes },
            isDeleted: false,
          },
          orderBy: { createdAt: 'desc' },
          skip: dSkip,
          take: dLimit,
          select: dealListSelect,
        });

        const dealList = deals.map((d: any) => toUiDeal(pgDeal(d)));
        res.json(dealList);

        businessLog.info('Deals listed', { userId: req.auth?.userId, resultCount: dealList.length, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Deal',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'DEALS_LISTED', endpoint: 'getDeals', resultCount: dealList.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getDeals' } });
        next(err);
      }
    },
    getOrders: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const queryParams = opsOrdersQuerySchema.parse(req.query);
        const requestedCode = queryParams.mediatorCode || '';

        let managerCodes: string[] = [];
        if (isPrivileged(roles)) {
          if (!requestedCode) throw new AppError(400, 'INVALID_CODE', 'mediatorCode required');
          const requestedRole = queryParams.role || '';
          if (requestedRole === 'agency') {
            managerCodes = await listMediatorCodesForAgency(requestedCode);
          } else {
            managerCodes = [requestedCode];
          }
        } else if (roles.includes('mediator')) {
          managerCodes = [String((user as any)?.mediatorCode || '')];
        } else if (roles.includes('agency')) {
          managerCodes = await listMediatorCodesForAgency(String((user as any)?.mediatorCode || ''));
        } else {
          throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
        }

        managerCodes = managerCodes.filter(Boolean);
        if (!managerCodes.length) {
          res.json([]);
          return;
        }

        const { page: oPage, limit: oLimit, skip: oSkip, isPaginated: oIsPaginated } = parsePagination(req.query, { limit: 200 });
        const oWhere = { managerName: { in: managerCodes }, isDeleted: false };
        const uniqueCodes = [...new Set(managerCodes)];
        // Orders, count, and mediator names are all independent — run in parallel
        const [orders, oTotal, mediatorUsers] = await Promise.all([
          db().order.findMany({
            where: oWhere,
            select: orderListSelectLite,
            orderBy: { createdAt: 'desc' },
            skip: oSkip,
            take: oLimit,
          }),
          db().order.count({ where: oWhere }),
          uniqueCodes.length > 0
            ? db().user.findMany({
                where: { mediatorCode: { in: uniqueCodes }, isDeleted: false },
                select: { mediatorCode: true, name: true },
              })
            : Promise.resolve([]),
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
          catch (e) { orderLog.error(`[getOrders] toUiOrderSummary failed for order ${o.id}`, { error: e }); return null; }
        }).filter(Boolean);

        // Enrich orders with actual mediator display names (managerName stores mediator code)
        if (uniqueCodes.length > 0) {
          const codeToName = new Map<string, string>();
          for (const m of mediatorUsers) {
            if (m.mediatorCode && m.name) codeToName.set(m.mediatorCode, m.name);
          }
          for (const order of mapped) {
            if (order && typeof order === 'object') {
              const code = (order as any).managerName || '';
              (order as any).mediatorCode = code;
              const resolvedName = codeToName.get(code);
              if (resolvedName) (order as any).managerName = resolvedName;
            }
          }
        }

        res.json(paginatedResponse(mapped, oTotal, oPage, oLimit, oIsPaginated));

        businessLog.info('Orders listed', { userId: req.auth?.userId, resultCount: mapped.length, total: oTotal, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Order',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'ORDERS_LISTED', endpoint: 'getOrders', resultCount: mapped.length, total: oTotal },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getOrders' } });
        next(err);
      }
    },

    getPendingUsers: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const queryParams = opsCodeQuerySchema.parse(req.query);
        const requested = queryParams.code || '';
        const code = isPrivileged(roles) ? requested : String((user as any)?.mediatorCode || '');
        if (!code) throw new AppError(400, 'INVALID_CODE', 'code required');

        const where: any = {
          role: 'shopper',
          parentCode: code,
          isVerifiedByMediator: false,
          isDeleted: false,
        };
        if (queryParams.search) {
          const search = queryParams.search;
          where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { mobile: { contains: search, mode: 'insensitive' } },
          ];
        }

        const { limit: puLimit, skip: puSkip } = parsePagination(req.query as any, { limit: 100, maxLimit: 500 });
        const users = await db().user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: puSkip,
          take: puLimit,
          select: { ...userListSelect, wallets: { where: { isDeleted: false }, take: 1, select: { id: true, availablePaise: true, pendingPaise: true } } },
        });

        res.json(users.map((u: any) => {
          const wallet = u.wallets?.[0];
          return toUiUser(pgUser(u), wallet ? pgWallet(wallet) : undefined);
        }));
        businessLog.info('Pending users listed', { userId: req.auth?.userId, resultCount: users.length, code, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'PendingUsers', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'PENDING_USERS_LISTED', resultCount: users.length } });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getPendingUsers' } });
        next(err);
      }
    },

    getVerifiedUsers: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const queryParams = opsCodeQuerySchema.parse(req.query);
        const requested = queryParams.code || '';
        const code = isPrivileged(roles) ? requested : String((user as any)?.mediatorCode || '');
        if (!code) throw new AppError(400, 'INVALID_CODE', 'code required');

        const where: any = {
          role: 'shopper',
          parentCode: code,
          isVerifiedByMediator: true,
          isDeleted: false,
        };
        if (queryParams.search) {
          const search = queryParams.search;
          where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { mobile: { contains: search, mode: 'insensitive' } },
          ];
        }

        const { limit: vuLimit, skip: vuSkip } = parsePagination(req.query as any, { limit: 100, maxLimit: 500 });
        const users = await db().user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: vuSkip,
          take: vuLimit,
          select: { ...userListSelect, wallets: { where: { isDeleted: false }, take: 1, select: { id: true, availablePaise: true, pendingPaise: true } } },
        });

        res.json(users.map((u: any) => {
          const wallet = u.wallets?.[0];
          return toUiUser(pgUser(u), wallet ? pgWallet(wallet) : undefined);
        }));

        businessLog.info('Verified users listed', { userId: req.auth?.userId, resultCount: users.length, code, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'User',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'VERIFIED_USERS_LISTED', endpoint: 'getVerifiedUsers', resultCount: users.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getVerifiedUsers' } });
        next(err);
      }
    },

    getLedger: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, userId: _userId, pgUserId, user } = getRequester(req);

        const payoutWhere: any = { isDeleted: false };

        if (!isPrivileged(roles)) {
          if (roles.includes('mediator')) {
            payoutWhere.beneficiaryUserId = pgUserId;
          } else if (roles.includes('agency')) {
            const agencyCode = String((user as any)?.mediatorCode || '').trim();
            if (!agencyCode) {
              res.json([]);
              return;
            }
            const mediatorCodes = await listMediatorCodesForAgency(agencyCode);
            if (!mediatorCodes.length) {
              res.json([]);
              return;
            }
            const mediators = await db().user.findMany({
              where: { roles: { has: 'mediator' as any }, mediatorCode: { in: mediatorCodes }, isDeleted: false },
              select: { id: true },
            });
            payoutWhere.beneficiaryUserId = { in: mediators.map((m: any) => m.id) };
          } else {
            throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
          }
        }

        const { page, limit, skip, isPaginated } = parsePagination(req.query, { limit: 100 });
        const [payouts, payoutTotal] = await Promise.all([
          db().payout.findMany({
            where: payoutWhere,
            orderBy: { requestedAt: 'desc' },
            take: limit,
            skip,
            select: { id: true, mongoId: true, beneficiaryUserId: true, amountPaise: true, requestedAt: true, createdAt: true, status: true, providerRef: true },
          }),
          db().payout.count({ where: payoutWhere }),
        ]);

        const beneficiaryIds = payouts.map((p: any) => p.beneficiaryUserId).filter(Boolean);
        const users = await db().user.findMany({
          where: { id: { in: beneficiaryIds }, isDeleted: false },
          select: { id: true, mongoId: true, name: true, mediatorCode: true },
        });
        const byId = new Map(users.map((u: any) => [String(u.id), u]));

        const mapped = payouts.map((p: any) => {
          const u = byId.get(String(p.beneficiaryUserId));
          return {
            id: p.mongoId ?? p.id,
            mediatorName: u?.name ?? 'Mediator',
            mediatorCode: u?.mediatorCode,
            amount: Math.round((p.amountPaise ?? 0) / 100),
            date: safeIso(p.requestedAt ?? p.createdAt) ?? new Date().toISOString(),
            status: p.status === 'paid' ? 'Success' : String(p.status),
            ref: p.providerRef || '',
          };
        });
        res.json(paginatedResponse(mapped, payoutTotal, page, limit, isPaginated));

        businessLog.info('Payout ledger listed', { userId: req.auth?.userId, resultCount: mapped.length, total: payoutTotal, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Payout',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'LEDGER_LISTED', endpoint: 'getLedger', resultCount: mapped.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getLedger' } });
        next(err);
      }
    },

    approveMediator: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user: requester } = getRequester(req);
        const body = approveByIdSchema.parse(req.body);

        const mediator = await db().user.findFirst({ where: { ...idWhere(body.id), isDeleted: false }, select: { id: true, mongoId: true, parentCode: true, mediatorCode: true, kycStatus: true, status: true } });
        if (!mediator) {
          throw new AppError(404, 'USER_NOT_FOUND', 'Mediator not found');
        }

        const canApprove =
          isPrivileged(roles) ||
          (roles.includes('agency') && String(mediator.parentCode) === String((requester as any)?.mediatorCode));

        if (!canApprove) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot approve mediators outside your network');
        }
        const _user = await db().user.update({
          where: { id: mediator.id },
          data: { kycStatus: 'verified', status: 'active' },
        });

        await writeAuditLog({ req, action: 'MEDIATOR_APPROVED', entityType: 'User', entityId: mediator.mongoId! });
        businessLog.info('Mediator approved', { mediatorId: mediator.mongoId, mediatorCode: mediator.mediatorCode, agencyCode: String(mediator.parentCode || ''), approvedBy: req.auth?.userId });
        logChangeEvent({ actorUserId: String(req.auth?.userId || ''), entityType: 'User', entityId: mediator.mongoId!, action: 'STATUS_CHANGE', changedFields: ['kycStatus', 'status'], before: { kycStatus: mediator.kycStatus, status: mediator.status }, after: { kycStatus: 'verified', status: 'active' }, metadata: { role: 'mediator' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'User', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'MEDIATOR_APPROVED', mediatorId: mediator.mongoId } });

        const agencyCode = String(mediator.parentCode || '').trim();
        const mediatorMongoId = mediator.mongoId ?? '';
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'users.changed',
          ts,
          payload: { userId: mediatorMongoId, kind: 'mediator', status: 'active', agencyCode },
          audience: {
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'mediator.approved', userId: mediatorMongoId, agencyCode },
          audience: {
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/approveMediator' } });
        next(err);
      }
    },

    rejectMediator: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user: requester } = getRequester(req);
        const body = rejectByIdSchema.parse(req.body);

        const mediator = await db().user.findFirst({ where: { ...idWhere(body.id), isDeleted: false }, select: { id: true, mongoId: true, parentCode: true, mediatorCode: true, kycStatus: true, status: true } });
        if (!mediator) {
          throw new AppError(404, 'USER_NOT_FOUND', 'Mediator not found');
        }

        const canReject =
          isPrivileged(roles) ||
          (roles.includes('agency') && String(mediator.parentCode) === String((requester as any)?.mediatorCode));
        if (!canReject) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot reject mediators outside your network');
        }

        const _user = await db().user.update({
          where: { id: mediator.id },
          data: { kycStatus: 'rejected', status: 'suspended' },
        });

        // Evict auth cache so the suspended mediator can't act on stale tokens
        authCacheInvalidate(mediator.mongoId!);
        authCacheInvalidate(mediator.id);

        await writeAuditLog({ req, action: 'MEDIATOR_REJECTED', entityType: 'User', entityId: mediator.mongoId! });
        businessLog.info('Mediator rejected', { mediatorId: mediator.mongoId, kycStatus: 'rejected', status: 'suspended' });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'User', entityId: mediator.mongoId!, action: 'MEDIATOR_REJECTED', changedFields: ['kycStatus', 'status'], before: { kycStatus: mediator.kycStatus, status: mediator.status }, after: { kycStatus: 'rejected', status: 'suspended' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'User', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'MEDIATOR_REJECTED', mediatorId: mediator.mongoId } });

        const agencyCode = String(mediator.parentCode || '').trim();
        const mediatorMongoId = mediator.mongoId ?? '';
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'users.changed',
          ts,
          payload: { userId: mediatorMongoId, kind: 'mediator', status: 'suspended', agencyCode },
          audience: {
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'mediator.rejected', userId: mediatorMongoId, agencyCode },
          audience: {
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/rejectMediator' } });
        next(err);
      }
    },

    approveUser: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = approveByIdSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const buyerBefore = await db().user.findFirst({ where: { ...idWhere(body.id), isDeleted: false }, select: { id: true, mongoId: true, parentCode: true, status: true } });
        if (!buyerBefore) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
        const upstreamMediatorCode = String(buyerBefore.parentCode || '').trim();

        if (roles.includes('mediator') && !isPrivileged(roles)) {
          if (String(upstreamMediatorCode) !== String((requester as any)?.mediatorCode)) {
            throw new AppError(403, 'FORBIDDEN', 'Cannot approve users outside your network');
          }
        }

        if (roles.includes('agency') && !isPrivileged(roles) && !roles.includes('mediator')) {
          const agencyCode = String((requester as any)?.mediatorCode || '').trim();
          if (!agencyCode) throw new AppError(403, 'FORBIDDEN', 'Agency code not found');
          const subMediators = await listMediatorCodesForAgency(agencyCode);
          if (!subMediators.includes(upstreamMediatorCode)) {
            throw new AppError(403, 'FORBIDDEN', 'Cannot approve users outside your agency network');
          }
        }

        const user = await db().user.update({
          where: { id: buyerBefore.id },
          data: { isVerifiedByMediator: true },
        });

        authCacheInvalidate(buyerBefore.id);
        authCacheInvalidate(buyerBefore.mongoId!);

        const userMongoId = user.mongoId ?? '';
        await writeAuditLog({ req, action: 'BUYER_APPROVED', entityType: 'User', entityId: userMongoId });
        businessLog.info('Buyer approved', { userId: userMongoId, mediatorCode: upstreamMediatorCode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'User', entityId: userMongoId, action: 'BUYER_APPROVED', changedFields: ['isVerifiedByMediator'], before: { isVerifiedByMediator: false }, after: { isVerifiedByMediator: true } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'User', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'BUYER_APPROVED', buyerId: userMongoId } });

        const agencyCode = upstreamMediatorCode ? (await getAgencyCodeForMediatorCode(upstreamMediatorCode)) || '' : '';
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'users.changed',
          ts,
          payload: { userId: userMongoId, kind: 'buyer', status: 'approved', mediatorCode: upstreamMediatorCode },
          audience: {
            userIds: [userMongoId],
            ...(upstreamMediatorCode ? { mediatorCodes: [upstreamMediatorCode] } : {}),
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'buyer.approved', userId: userMongoId, mediatorCode: upstreamMediatorCode },
          audience: {
            ...(upstreamMediatorCode ? { mediatorCodes: [upstreamMediatorCode] } : {}),
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/approveUser' } });
        next(err);
      }
    },

    rejectUser: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = rejectByIdSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const buyerBefore = await db().user.findFirst({ where: { ...idWhere(body.id), isDeleted: false }, select: { id: true, mongoId: true, parentCode: true, status: true } });
        if (!buyerBefore) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
        const upstreamMediatorCode = String(buyerBefore.parentCode || '').trim();

        if (roles.includes('mediator') && !isPrivileged(roles)) {
          if (String(upstreamMediatorCode) !== String((requester as any)?.mediatorCode)) {
            throw new AppError(403, 'FORBIDDEN', 'Cannot reject users outside your network');
          }
        }

        if (roles.includes('agency') && !isPrivileged(roles) && !roles.includes('mediator')) {
          const agencyCode = String((requester as any)?.mediatorCode || '').trim();
          if (!agencyCode) throw new AppError(403, 'FORBIDDEN', 'Agency code not found');
          const subMediators = await listMediatorCodesForAgency(agencyCode);
          if (!subMediators.includes(upstreamMediatorCode)) {
            throw new AppError(403, 'FORBIDDEN', 'Cannot reject users outside your agency network');
          }
        }

        const user = await db().user.update({
          where: { id: buyerBefore.id },
          data: { status: 'suspended' },
        });

        // Evict auth cache so the rejected buyer can't act on stale tokens
        authCacheInvalidate(buyerBefore.mongoId!);
        authCacheInvalidate(buyerBefore.id);

        const userMongoId = user.mongoId ?? '';
        await writeAuditLog({ req, action: 'USER_REJECTED', entityType: 'User', entityId: userMongoId });
        businessLog.info('User rejected', { userId: userMongoId, mediatorCode: upstreamMediatorCode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'User', entityId: userMongoId, action: 'USER_REJECTED', changedFields: ['status'], before: { status: buyerBefore.status }, after: { status: 'suspended' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'User', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'USER_REJECTED', buyerId: userMongoId } });

        const agencyCode = upstreamMediatorCode ? (await getAgencyCodeForMediatorCode(upstreamMediatorCode)) || '' : '';
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'users.changed',
          ts,
          payload: { userId: userMongoId, kind: 'buyer', status: 'rejected', mediatorCode: upstreamMediatorCode },
          audience: {
            userIds: [userMongoId],
            ...(upstreamMediatorCode ? { mediatorCodes: [upstreamMediatorCode] } : {}),
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'buyer.rejected', userId: userMongoId, mediatorCode: upstreamMediatorCode },
          audience: {
            ...(upstreamMediatorCode ? { mediatorCodes: [upstreamMediatorCode] } : {}),
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/rejectUser' } });
        next(err);
      }
    },

    verifyOrderClaim: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = verifyOrderSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);
        const order = await db().order.findFirst({ where: { ...idWhere(body.orderId), isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const wf = String((order as any).workflowStatus || 'CREATED');
        if (wf !== 'UNDER_REVIEW') {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot verify in state ${wf}`);
        }

        const pgMapped = pgOrder(order);
        const v = (order.verification && typeof order.verification === 'object') ? { ...(order.verification as any) } : {} as any;

        if (v.order?.verifiedAt) {
          return res.json({
            ok: true,
            approved: false,
            reason: 'ALREADY_VERIFIED',
            order: toUiOrder(pgMapped),
          });
        }

        v.order = v.order ?? {};
        v.order.verifiedAt = new Date().toISOString();
        v.order.verifiedBy = req.auth?.userId;

        const required = getRequiredStepsForOrder(pgMapped);
        const missingProofs = required.filter((t) => !hasProofForRequirement(pgMapped, t));
        const newEvents = pushOrderEvent(order.events as any, {
          type: 'VERIFIED',
          at: new Date(),
          actorUserId: req.auth?.userId,
          metadata: { step: 'order', missingProofs },
        });
        const updatedOrder = await db().order.update({ where: { id: order.id }, data: { verification: v, events: newEvents as any }, include: { items: { where: { isDeleted: false } } } });
        const finalize = await finalizeApprovalIfReady(updatedOrder!, String(req.auth?.userId || ''), env);

        await writeAuditLog({ req, action: 'ORDER_VERIFIED', entityType: 'Order', entityId: order.mongoId! });
        orderLog.info('Order claim verified', { orderId: order.mongoId, step: 'order', approved: (finalize as any).approved, workflowStatus: wf });
        businessLog.info('Order claim verified', { orderId: order.mongoId, step: 'order', approved: (finalize as any).approved, verifiedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'ORDER_CLAIM_VERIFIED', changedFields: ['verification', 'workflowStatus'], before: { workflowStatus: wf }, after: { workflowStatus: (finalize as any).approved ? 'APPROVED' : wf } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'VERIFY_ORDER_CLAIM', orderId: order.mongoId } });

        const audience = await buildOrderAudience(updatedOrder!, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        const buyerId = audience.buyerMongoId;
        if (buyerId) {
          const finResult = finalize as any;
          let pushBody = 'Your purchase proof has been verified.';
          if (finResult.approved) {
            pushBody = 'All proofs verified! Your cashback is now in the cooling period.';
          } else if (finResult.missingProofs?.length) {
            pushBody = `Purchase verified! Please upload your ${(finResult.missingProofs as string[]).join(' & ')} proof to continue.`;
          }
          await sendPushToUser({
            env, userId: buyerId, app: 'buyer',
            payload: { title: 'Proof Verified', body: pushBody, url: '/orders' },
          }).catch((err: unknown) => { pushLog.warn('Push failed for verifyOrder', { err, buyerId }); });
        }

        // Only re-fetch if finalize modified the order; otherwise use the update result
        const finalOrder = (finalize as any).approved
          ? await db().order.findFirst({ where: { id: order.id, isDeleted: false }, include: { items: { where: { isDeleted: false } } } })
          : updatedOrder;
        res.json({
          ok: true,
          approved: (finalize as any).approved,
          ...(finalize as any),
          order: finalOrder ? toUiOrder(pgOrder(finalOrder)) : undefined,
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/verifyOrderClaim' } });
        next(err);
      }
    },

    verifyOrderRequirement: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = verifyOrderRequirementSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const order = await db().order.findFirst({ where: { ...idWhere(body.orderId), isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const wf = String((order as any).workflowStatus || 'CREATED');
        if (wf !== 'UNDER_REVIEW') {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot verify in state ${wf}`);
        }

        const pgMapped = pgOrder(order);
        const v = (order.verification && typeof order.verification === 'object') ? { ...(order.verification as any) } : {} as any;

        if (!v.order?.verifiedAt) {
          throw new AppError(409, 'PURCHASE_NOT_VERIFIED', 'Purchase proof must be verified first');
        }

        const required = getRequiredStepsForOrder(pgMapped);
        if (!required.includes(body.type)) {
          throw new AppError(409, 'NOT_REQUIRED', `This order does not require ${body.type} verification`);
        }

        if (!hasProofForRequirement(pgMapped, body.type)) {
          throw new AppError(409, 'MISSING_PROOF', `Missing ${body.type} proof`);
        }

        if (isRequirementVerified(pgMapped, body.type)) {
          return res.json({
            ok: true,
            approved: false,
            reason: 'ALREADY_VERIFIED',
            order: toUiOrder(pgMapped),
          });
        }

        v[body.type] = v[body.type] ?? {};
        v[body.type].verifiedAt = new Date().toISOString();
        v[body.type].verifiedBy = req.auth?.userId;

        const newEvents = pushOrderEvent(order.events as any, {
          type: 'VERIFIED',
          at: new Date(),
          actorUserId: req.auth?.userId,
          metadata: { step: body.type },
        });
        const updatedOrder = await db().order.update({ where: { id: order.id }, data: { verification: v, events: newEvents as any }, include: { items: { where: { isDeleted: false } } } });
        const finalize = await finalizeApprovalIfReady(updatedOrder!, String(req.auth?.userId || ''), env);
        await writeAuditLog({ req, action: 'ORDER_VERIFIED', entityType: 'Order', entityId: order.mongoId! });
        orderLog.info('Order requirement verified', { orderId: order.mongoId, step: body.type, approved: (finalize as any).approved });
        businessLog.info('Order requirement verified', { orderId: order.mongoId, step: body.type, approved: (finalize as any).approved, verifiedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'REQUIREMENT_VERIFIED', changedFields: ['verification', body.type], before: { verified: false }, after: { verified: true, step: body.type } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'REQUIREMENT_VERIFIED', orderId: order.mongoId, step: body.type, approved: (finalize as any).approved } });

        const audience = await buildOrderAudience(updatedOrder!, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        const buyerId = audience.buyerMongoId;
        if (buyerId) {
          const finResult = finalize as any;
          let pushBody = `Your ${body.type} proof has been verified.`;
          if (finResult.approved) {
            pushBody = 'All proofs verified! Your cashback is now in the cooling period.';
          }
          await sendPushToUser({
            env, userId: buyerId, app: 'buyer',
            payload: { title: 'Proof Verified', body: pushBody, url: '/orders' },
          }).catch((err: unknown) => { pushLog.warn('Push failed for verifyRequirement', { err, buyerId }); });
        }

        // Only re-fetch if finalize modified the order; otherwise use the update result
        const finalOrder = (finalize as any).approved
          ? await db().order.findFirst({ where: { id: order.id, isDeleted: false }, include: { items: { where: { isDeleted: false } } } })
          : updatedOrder;
        res.json({
          ok: true,
          approved: (finalize as any).approved,
          ...(finalize as any),
          order: finalOrder ? toUiOrder(pgOrder(finalOrder)) : undefined,
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/verifyOrderRequirement' } });
        next(err);
      }
    },

    /**
     * Verify ALL steps for an order in a single call.
     * Verifies purchase proof first, then any remaining requirements (review/rating/returnWindow).
     * Only succeeds when all required proofs have been uploaded by the buyer.
     */
    verifyAllSteps: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = verifyOrderSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);
        const order = await db().order.findFirst({ where: { ...idWhere(body.orderId), isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const wf = String((order as any).workflowStatus || 'CREATED');
        if (wf !== 'UNDER_REVIEW') {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot verify in state ${wf}`);
        }

        const pgMapped = pgOrder(order);
        const required = getRequiredStepsForOrder(pgMapped);
        const missingProofs = required.filter((t) => !hasProofForRequirement(pgMapped, t));
        if (missingProofs.length) {
          throw new AppError(409, 'MISSING_PROOFS', `Missing proofs: ${missingProofs.join(', ')}`);
        }

        const v = (order.verification && typeof order.verification === 'object') ? { ...(order.verification as any) } : {} as any;
        let evts = order.events as any;

        if (!v.order?.verifiedAt) {
          v.order = v.order ?? {};
          v.order.verifiedAt = new Date().toISOString();
          v.order.verifiedBy = req.auth?.userId;
          evts = pushOrderEvent(evts, {
            type: 'VERIFIED',
            at: new Date(),
            actorUserId: req.auth?.userId,
            metadata: { step: 'order' },
          });
        }

        for (const type of required) {
          if (!isRequirementVerified(pgMapped, type)) {
            v[type] = v[type] ?? {};
            v[type].verifiedAt = new Date().toISOString();
            v[type].verifiedBy = req.auth?.userId;
            evts = pushOrderEvent(evts, {
              type: 'VERIFIED',
              at: new Date(),
              actorUserId: req.auth?.userId,
              metadata: { step: type },
            });
          }
        }

        const updatedOrder = await db().order.update({ where: { id: order.id }, data: { verification: v, events: evts as any }, include: { items: { where: { isDeleted: false } } } });
        const finalize = await finalizeApprovalIfReady(updatedOrder!, String(req.auth?.userId || ''), env);
        await writeAuditLog({ req, action: 'ORDER_VERIFIED', entityType: 'Order', entityId: order.mongoId! });
        orderLog.info('All order steps verified', { orderId: order.mongoId, stepsVerified: required, approved: (finalize as any).approved });
        businessLog.info('All order steps verified', { orderId: order.mongoId, stepsVerified: required, approved: (finalize as any).approved, verifiedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'ALL_STEPS_VERIFIED', changedFields: ['verification', 'workflowStatus'], before: { workflowStatus: wf }, after: { workflowStatus: (finalize as any).approved ? 'APPROVED' : wf, stepsVerified: required } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'VERIFY_ALL_STEPS', orderId: order.mongoId } });

        const audience = await buildOrderAudience(updatedOrder!, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        const buyerId = audience.buyerMongoId;
        if (buyerId) {
          await sendPushToUser({
            env, userId: buyerId, app: 'buyer',
            payload: { title: 'Deal Verified!', body: 'All proofs verified! Your cashback is now in the cooling period.', url: '/orders' },
          }).catch((err: unknown) => { pushLog.warn('Push failed for verifyAllOrder', { err, userId: buyerId }); });
        }

        // Only re-fetch if finalize modified the order; otherwise use the update result
        const finalOrder = (finalize as any).approved
          ? await db().order.findFirst({ where: { id: order.id, isDeleted: false }, include: { items: { where: { isDeleted: false } } } })
          : updatedOrder;
        res.json({
          ok: true,
          approved: (finalize as any).approved,
          ...(finalize as any),
          order: finalOrder ? toUiOrder(pgOrder(finalOrder)) : undefined,
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/verifyAllSteps' } });
        next(err);
      }
    },

    rejectOrderProof: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = rejectOrderProofSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const order = await db().order.findFirst({ where: { ...idWhere(body.orderId), isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const wf = String((order as any).workflowStatus || 'CREATED');
        const rejectableStates = ['UNDER_REVIEW', 'APPROVED'];
        if (!rejectableStates.includes(wf)) {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot reject in state ${wf}`);
        }

        const wasApproved = wf === 'APPROVED';

        const pgMapped = pgOrder(order);
        const v = (order.verification && typeof order.verification === 'object') ? { ...(order.verification as any) } : {} as any;
        const updateData: any = {};

        if (body.type === 'order') {
          if (!order.screenshotOrder) {
            throw new AppError(409, 'MISSING_PROOF', 'Missing order proof');
          }
          if (v.order?.verifiedAt) {
            throw new AppError(409, 'ALREADY_VERIFIED', 'Order proof already verified');
          }
          updateData.screenshotOrder = null;
          if (v.order) { v.order = undefined; }
        } else {
          if (!v.order?.verifiedAt) {
            throw new AppError(409, 'PURCHASE_NOT_VERIFIED', 'Purchase proof must be verified first');
          }
          const required = getRequiredStepsForOrder(pgMapped);
          if (!required.includes(body.type)) {
            throw new AppError(409, 'NOT_REQUIRED', `This order does not require ${body.type} verification`);
          }
          if (!hasProofForRequirement(pgMapped, body.type)) {
            throw new AppError(409, 'MISSING_PROOF', `Missing ${body.type} proof`);
          }
          if (body.type === 'review') {
            updateData.reviewLink = null;
            updateData.screenshotReview = null;
            if (v.review) { v.review = undefined; }
          }
          if (body.type === 'rating') {
            updateData.screenshotRating = null;
            if (v.rating) { v.rating = undefined; }
            updateData.ratingAiVerification = null;
          }
          if (body.type === 'returnWindow') {
            updateData.screenshotReturnWindow = null;
            if (v.returnWindow) { v.returnWindow = undefined; }
          }
        }

        updateData.rejectionType = body.type;
        updateData.rejectionReason = body.reason;
        updateData.rejectionAt = new Date();
        updateData.rejectionBy = req.auth?.userId;
        // When rejecting from APPROVED, reset to Unchecked so buyer can re-upload;
        // from UNDER_REVIEW the status is terminal Rejected (mediator can still cancel later).
        updateData.affiliateStatus = wasApproved ? 'Unchecked' : 'Rejected';
        if (wasApproved) {
          updateData.expectedSettlementDate = null;
        }
        updateData.verification = v;

        // Release campaign slot when order proof (purchase) is rejected
        if (body.type === 'order') {
          const campaignId = order.items?.[0]?.campaignId;
          if (campaignId) {
            await db().$executeRaw`UPDATE "campaigns" SET "used_slots" = GREATEST("used_slots" - 1, 0) WHERE id = ${campaignId}::uuid AND "is_deleted" = false`;
          }
        }

        const newEvents = pushOrderEvent(order.events as any, {
          type: 'REJECTED',
          at: new Date(),
          actorUserId: req.auth?.userId,
          metadata: { step: body.type, reason: body.reason },
        });
        updateData.events = newEvents;

        await db().order.update({ where: { id: order.id }, data: updateData });

        // When rejecting from APPROVED, transition back to ORDERED so buyer can re-upload
        if (wasApproved) {
          await transitionOrderWorkflow({
            orderId: order.mongoId!,
            from: 'APPROVED' as any,
            to: 'ORDERED' as any,
            actorUserId: String(req.auth?.userId || ''),
            metadata: { source: 'rejectOrderProof', reason: body.reason, proofType: body.type },
            env,
          });
        }

        await writeAuditLog({
          req,
          action: 'ORDER_REJECTED',
          entityType: 'Order',
          entityId: order.mongoId!,
          metadata: { proofType: body.type, reason: body.reason },
        });
        orderLog.info('Order proof rejected', { orderId: order.mongoId, proofType: body.type, reason: body.reason });
        businessLog.info('Order proof rejected', { orderId: order.mongoId, proofType: body.type, reason: body.reason, rejectedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'PROOF_REJECTED', changedFields: ['affiliateStatus', 'rejectionType', 'rejectionReason'], before: { affiliateStatus: order.affiliateStatus }, after: { affiliateStatus: wasApproved ? 'Unchecked' : 'Rejected', rejectionType: body.type, rejectionReason: body.reason } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'REJECT_ORDER_PROOF', orderId: order.mongoId, proofType: body.type } });

        if (body.type === 'order') {
          const campaignId = order.items?.[0]?.campaignId;
          if (campaignId) {
            writeAuditLog({
              req,
              action: 'CAMPAIGN_SLOT_RELEASED',
              entityType: 'Campaign',
              entityId: String(campaignId),
              metadata: { orderId: order.mongoId ?? order.id, reason: 'proof_rejected' },
            }).catch(() => { });
          }
        }

        const audience = await buildOrderAudience(order, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        const buyerId = audience.buyerMongoId;
        if (buyerId) {
          await sendPushToUser({
            env,
            userId: buyerId,
            app: 'buyer',
            payload: {
              title: wasApproved ? 'Proof recalled â€” re-upload needed' : 'Proof rejected',
              body: body.reason || 'Please re-upload the required proof.',
              url: '/orders',
            },
          }).catch((err: unknown) => { pushLog.warn('Push failed for rejectProof', { err, buyerId }); });
        }

        // Notify mediator when proof is rejected from APPROVED state
        if (wasApproved && audience.mediatorCodes?.length) {
          for (const code of audience.mediatorCodes) {
            sendPushToUser({
              env,
              userId: code,
              app: 'mediator',
              payload: {
                title: 'Approved order recalled',
                body: `Proof rejected after approval: ${body.reason || 'Re-upload requested'}`,
                url: '/orders',
              },
            }).catch((err: unknown) => { pushLog.warn('Push failed for mediator rejectProof', { err, mediatorCode: code }); });
          }
        }

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/rejectOrderProof' } });
        next(err);
      }
    },

    /**
     * Cancel all proofs for an order and request the buyer to re-upload everything.
     * Unlike reject (which is terminal), this resets the order back to ORDERED state
     * so the buyer can start fresh with all proof uploads.
     */
    cancelOrderProofs: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = cancelOrderProofsSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const order = await db().order.findFirst({
          where: { ...idWhere(body.orderId), isDeleted: false },
          include: { items: { where: { isDeleted: false } } },
        });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const wf = String((order as any).workflowStatus || 'CREATED');
        if (wf !== 'UNDER_REVIEW' && wf !== 'PROOF_SUBMITTED' && wf !== 'APPROVED') {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot cancel proofs in state ${wf}`);
        }

        const newEvents = pushOrderEvent(order.events as any, {
          type: 'PROOFS_CANCELLED',
          at: new Date(),
          actorUserId: req.auth?.userId,
          metadata: { reason: body.reason },
        });

        await db().order.update({
          where: { id: order.id },
          data: {
            // Clear all proof screenshots
            screenshotOrder: null,
            screenshotRating: null,
            screenshotReview: null,
            screenshotReturnWindow: null,
            reviewLink: null,
            // Clear all verification data
            verification: {},
            // Clear AI verification data
            ratingAiVerification: Prisma.DbNull,
            returnWindowAiVerification: Prisma.DbNull,
            orderAiVerification: Prisma.DbNull,
            // Reset reviewer name so buyer can set a new one
            reviewerName: null,
            // Reset status
            affiliateStatus: 'Unchecked' as any,
            // Clear rejection fields
            rejectionType: null,
            rejectionReason: null,
            rejectionAt: null,
            rejectionBy: null,
            // Clear missing proof requests
            missingProofRequests: [],
            // Clear settlement date if cancelling from APPROVED
            ...(wf === 'APPROVED' ? { expectedSettlementDate: null } : {}),
            // Store cancellation info
            events: newEvents as any,
          },
        });

        // Transition workflow back to ORDERED so buyer can re-upload
        await transitionOrderWorkflow({
          orderId: order.mongoId!,
          from: wf as any,
          to: 'ORDERED' as any,
          actorUserId: String(req.auth?.userId || ''),
          metadata: { source: 'cancelOrderProofs', reason: body.reason },
          env,
        });

        await writeAuditLog({
          req,
          action: 'PROOFS_CANCELLED',
          entityType: 'Order',
          entityId: order.mongoId!,
          metadata: { reason: body.reason, previousWorkflow: wf },
        });
        orderLog.info('Order proofs cancelled for re-upload', { orderId: order.mongoId, reason: body.reason });
        businessLog.info('Order proofs cancelled for re-upload', { orderId: order.mongoId, reason: body.reason, cancelledBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'PROOFS_CANCELLED', changedFields: ['affiliateStatus', 'workflowStatus', 'verification'], before: { affiliateStatus: order.affiliateStatus, workflowStatus: wf }, after: { affiliateStatus: 'Unchecked', workflowStatus: 'ORDERED' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CANCEL_ORDER_PROOFS', orderId: order.mongoId } });

        const audience = await buildOrderAudience(order, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        const buyerId = audience.buyerMongoId;
        if (buyerId) {
          await sendPushToUser({
            env,
            userId: buyerId,
            app: 'buyer',
            payload: {
              title: 'Re-upload Required',
              body: body.reason || 'Your proofs have been cancelled. Please re-upload all proofs.',
              url: '/orders',
            },
          }).catch((err: unknown) => { pushLog.warn('Push failed for cancelOrderProofs', { err, buyerId }); });
        }

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/cancelOrderProofs' } });
        next(err);
      }
    },

    requestMissingProof: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = requestMissingProofSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const order = await db().order.findFirst({ where: { ...idWhere(body.orderId), isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const pgMapped = pgOrder(order);
        const required = getRequiredStepsForOrder(pgMapped);
        if (!required.includes(body.type)) {
          throw new AppError(409, 'NOT_REQUIRED', `This order does not require ${body.type} proof`);
        }
        if (hasProofForRequirement(pgMapped, body.type)) {
          res.json({ ok: true, alreadySatisfied: true });
          return;
        }

        const existingRequests = Array.isArray((order as any).missingProofRequests)
          ? (order as any).missingProofRequests
          : [];

        const alreadyRequested = existingRequests.some(
          (r: any) => String(r?.type) === body.type
        );
        if (!alreadyRequested) {
          const newRequests = [...existingRequests, {
            type: body.type,
            note: body.note,
            requestedAt: new Date().toISOString(),
            requestedBy: req.auth?.userId,
          }];
          const newEvents = pushOrderEvent(order.events as any, {
            type: 'MISSING_PROOF_REQUESTED',
            at: new Date(),
            actorUserId: req.auth?.userId,
            metadata: { requestMissing: body.type, note: body.note },
          });
          await db().order.update({
            where: { id: order.id },
            data: { missingProofRequests: newRequests as any, events: newEvents as any },
          });
        }

        const audience = await buildOrderAudience(order, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        await writeAuditLog({
          req,
          action: 'MISSING_PROOF_REQUESTED',
          entityType: 'Order',
          entityId: order.mongoId!,
          metadata: { proofType: body.type, note: body.note },
        });
        orderLog.info('Missing proof requested', { orderId: order.mongoId, proofType: body.type, note: body.note });
        businessLog.info('Missing proof requested', { orderId: order.mongoId, proofType: body.type, note: body.note, requestedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'MISSING_PROOF_REQUESTED', changedFields: ['missingProofRequests'], before: {}, after: { requestedType: body.type, note: body.note } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'MISSING_PROOF_REQUESTED', orderId: order.mongoId, proofType: body.type } });

        const buyerId = audience.buyerMongoId;
        if (buyerId) {
          await sendPushToUser({
            env,
            userId: buyerId,
            app: 'buyer',
            payload: {
              title: 'Action required',
              body: `Please upload your ${body.type} proof for order #${(order.mongoId || order.id).slice(-6)}.`,
              url: '/orders',
            },
          });
        }
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/requestMissingProof' } });
        next(err);
      }
    },

    settleOrderPayment: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = settleOrderSchema.parse(req.body);
        const { roles, user } = getRequester(req);
        const settlementMode = (body as any).settlementMode === 'external' ? 'external' : 'wallet';

        const canSettleAny = isPrivileged(roles);
        const canSettleScoped = roles.includes('mediator') || roles.includes('agency');
        if (!canSettleAny && !canSettleScoped) {
          throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
        }

        const order = await db().order.findFirst({ where: { ...idWhere(body.orderId), isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, user);

        // Buyer must also be active â€” order.userId is PG UUID
        const buyer = await db().user.findUnique({ where: { id: order.userId }, select: { id: true, status: true, isDeleted: true } });
        if (!buyer || buyer.isDeleted || buyer.status !== 'active') {
          throw new AppError(409, 'FROZEN_SUSPENSION', 'Buyer is not active; settlement is blocked');
        }

        const orderDisplayId = order.mongoId ?? order.id;
        const hasOpenDispute = await db().ticket.findFirst({
          where: { orderId: orderDisplayId, status: 'Open', isDeleted: false },
          select: { id: true },
        });
        if (hasOpenDispute) {
          const newEvents = pushOrderEvent(order.events as any, {
            type: 'FROZEN_DISPUTED',
            at: new Date(),
            actorUserId: req.auth?.userId,
            metadata: { reason: 'open_ticket' },
          });
          await db().order.update({
            where: { id: order.id },
            data: { affiliateStatus: 'Frozen_Disputed', events: newEvents as any },
          });
          await writeAuditLog({
            req,
            action: 'ORDER_FROZEN_DISPUTED',
            entityType: 'Order',
            entityId: orderDisplayId,
            metadata: { reason: 'open_ticket' },
          });
          throw new AppError(409, 'FROZEN_DISPUTE', 'This transaction is frozen due to an open ticket.');
        }

        const wf = String((order as any).workflowStatus || 'CREATED');
        if (wf !== 'APPROVED') {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot settle in state ${wf}`);
        }

        const campaignId = order.items?.[0]?.campaignId;
        const productId = String(order.items?.[0]?.productId || '').trim();
        const mediatorCode = String(order.managerName || '').trim();

        const campaign = campaignId ? await db().campaign.findFirst({ where: { id: campaignId, isDeleted: false } }) : null;

        let isOverLimit = false;
        if (campaignId && mediatorCode) {
          if (campaign) {
            const assignmentsObj = campaign.assignments && typeof campaign.assignments === 'object'
              ? campaign.assignments as any
              : {};
            const rawAssigned = assignmentsObj?.[mediatorCode];
            const assignedLimit =
              typeof rawAssigned === 'number' ? rawAssigned : Number(rawAssigned?.limit ?? 0);

            if (assignedLimit > 0) {
              const settledCount = await db().order.count({
                where: {
                  managerName: mediatorCode,
                  items: { some: { campaignId } },
                  OR: [{ affiliateStatus: 'Approved_Settled' }, { paymentStatus: 'Paid' }],
                  id: { not: order.id },
                  isDeleted: false,
                },
              });
              if (settledCount >= assignedLimit) isOverLimit = true;
            }
          }
        }

        // Money movements (wallet mode only)
        if (!isOverLimit && settlementMode === 'wallet') {
          if (!productId) {
            throw new AppError(409, 'MISSING_DEAL_ID', 'Order is missing deal reference');
          }

          const deal = await db().deal.findFirst({ where: { ...idWhere(productId), isDeleted: false } });
          if (!deal) {
            throw new AppError(409, 'DEAL_NOT_FOUND', 'Cannot settle: deal not found');
          }

          const payoutPaise = Number(deal.payoutPaise ?? 0);
          const buyerCommissionPaise = Number(order.items?.[0]?.commissionPaise ?? 0);
          if (payoutPaise <= 0) {
            throw new AppError(409, 'INVALID_PAYOUT', 'Cannot settle: deal payout is invalid');
          }
          if (buyerCommissionPaise < 0) {
            throw new AppError(409, 'INVALID_COMMISSION', 'Cannot settle: commission is invalid');
          }
          if (buyerCommissionPaise > payoutPaise) {
            throw new AppError(409, 'INVALID_ECONOMICS', 'Cannot settle: commission exceeds payout');
          }

          // order.userId and order.brandUserId are PG UUIDs
          const buyerUserId = order.userId;
          if (!buyerUserId) {
            throw new AppError(409, 'MISSING_BUYER', 'Cannot settle: order is missing buyer userId');
          }
          const brandId = String(order.brandUserId || campaign?.brandUserId || '').trim();
          if (!brandId) {
            throw new AppError(409, 'MISSING_BRAND', 'Cannot settle: missing brand ownership');
          }

          await ensureWallet(brandId);
          await ensureWallet(buyerUserId);

          const mediatorMarginPaise = payoutPaise - buyerCommissionPaise;
          let mediatorUserId: string | null = null;
          if (mediatorMarginPaise > 0 && mediatorCode) {
            const mediator = await db().user.findFirst({ where: { mediatorCode, isDeleted: false }, select: { id: true } });
            if (mediator) {
              mediatorUserId = mediator.id;
              await ensureWallet(mediatorUserId);
            }
          }

          // Atomic settlement using Prisma transaction â€” wallet + order status in one commit
          await db().$transaction(async (tx: any) => {
            await applyWalletDebit({
              idempotencyKey: `order-settlement-debit-${order.mongoId}`,
              type: 'order_settlement_debit',
              ownerUserId: brandId,
              fromUserId: brandId,
              toUserId: buyerUserId,
              amountPaise: payoutPaise,
              orderId: order.mongoId!,
              campaignId: campaignId ? String(campaignId) : undefined,
              metadata: { reason: 'ORDER_PAYOUT', dealId: productId, mediatorCode },
              tx,
            });

            if (buyerCommissionPaise > 0) {
              await applyWalletCredit({
                idempotencyKey: `order-commission-${order.mongoId}`,
                type: 'commission_settle',
                ownerUserId: buyerUserId,
                amountPaise: buyerCommissionPaise,
                orderId: order.mongoId!,
                campaignId: campaignId ? String(campaignId) : undefined,
                metadata: { reason: 'ORDER_COMMISSION', dealId: productId },
                tx,
              });
            }

            if (mediatorUserId && mediatorMarginPaise > 0) {
              await applyWalletCredit({
                idempotencyKey: `order-margin-${order.mongoId}`,
                type: 'commission_settle',
                ownerUserId: mediatorUserId,
                amountPaise: mediatorMarginPaise,
                orderId: order.mongoId!,
                campaignId: campaignId ? String(campaignId) : undefined,
                metadata: { reason: 'ORDER_MARGIN', dealId: productId, mediatorCode },
                tx,
              });
            }

            // Order status update is inside the transaction so money + status are atomic
            const newEvents1 = pushOrderEvent(order.events as any, {
              type: 'SETTLED',
              at: new Date(),
              actorUserId: req.auth?.userId,
              metadata: {
                ...(body.settlementRef ? { settlementRef: body.settlementRef } : {}),
                settlementMode,
              },
            });
            await tx.order.update({
              where: { id: order.id },
              data: {
                paymentStatus: 'Paid',
                affiliateStatus: 'Approved_Settled',
                settlementMode,
                ...(body.settlementRef ? { settlementRef: body.settlementRef } : {}),
                events: newEvents1 as any,
              },
            });
          }, { timeout: 15000 });
        } else {
          // Cap-exceeded or external: no wallet movement, just update order status
          const newEvents1 = pushOrderEvent(order.events as any, {
            type: isOverLimit ? 'CAP_EXCEEDED' : 'SETTLED',
            at: new Date(),
            actorUserId: req.auth?.userId,
            metadata: {
              ...(body.settlementRef ? { settlementRef: body.settlementRef } : {}),
              settlementMode,
            },
          });
          await db().order.update({
            where: { id: order.id },
            data: {
              paymentStatus: isOverLimit ? 'Failed' : 'Paid',
              affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled',
              settlementMode,
              ...(body.settlementRef ? { settlementRef: body.settlementRef } : {}),
              events: newEvents1 as any,
            },
          });
        }

        // Workflow transitions: APPROVED -> REWARD_PENDING -> COMPLETED/FAILED
        await transitionOrderWorkflow({
          orderId: order.mongoId!,
          from: 'APPROVED',
          to: 'REWARD_PENDING',
          actorUserId: String(req.auth?.userId || ''),
          metadata: { source: 'settleOrderPayment' },
          env,
        });

        await transitionOrderWorkflow({
          orderId: order.mongoId!,
          from: 'REWARD_PENDING',
          to: isOverLimit ? 'FAILED' : 'COMPLETED',
          actorUserId: String(req.auth?.userId || ''),
          metadata: { affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled' },
          env,
        });

        await writeAuditLog({ req, action: 'ORDER_SETTLED', entityType: 'Order', entityId: order.mongoId!, metadata: { affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled' } });

        businessLog.info('Order settlement completed', { orderId: orderDisplayId, settlementMode, isOverLimit, affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled', actorUserId: req.auth?.userId, mediatorCode, campaignId: campaignId ? String(campaignId) : undefined });
        logChangeEvent({ actorUserId: String(req.auth?.userId || ''), entityType: 'Order', entityId: orderDisplayId, action: 'STATUS_CHANGE', changedFields: ['paymentStatus', 'affiliateStatus', 'settlementMode'], after: { paymentStatus: isOverLimit ? 'Failed' : 'Paid', affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled', settlementMode }, metadata: { source: 'settleOrderPayment' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'SETTLE_ORDER', orderId: orderDisplayId, settlementMode } });

        const audience = await buildOrderAudience(order, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });
        if (settlementMode === 'wallet') {
          publishRealtime({ type: 'wallets.changed', ts: new Date().toISOString(), audience });
        }
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/settleOrderPayment' } });
        next(err);
      }
    },

    unsettleOrderPayment: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = unsettleOrderSchema.parse(req.body);
        const { roles, user } = getRequester(req);

        const requesterCode = String((user as any)?.mediatorCode || '').trim();
        const canAny = isPrivileged(roles);
        const canScoped = roles.includes('mediator') || roles.includes('agency');
        if (!canAny && !canScoped) throw new AppError(403, 'FORBIDDEN', 'Insufficient role');

        const order = await db().order.findFirst({ where: { ...idWhere(body.orderId), isDeleted: false }, include: { items: { where: { isDeleted: false } } } });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        if ((order as any).frozen) {
          throw new AppError(409, 'ORDER_FROZEN', 'Order is frozen and requires explicit reactivation');
        }

        if (!canAny) {
          const orderManagerCode = String(order.managerName || '').trim();
          if (!orderManagerCode) throw new AppError(409, 'INVALID_ORDER', 'Order is missing manager code');

          if (roles.includes('mediator')) {
            if (!requesterCode || requesterCode !== orderManagerCode) {
              throw new AppError(403, 'FORBIDDEN', 'You can only revert your own orders');
            }
          }

          if (roles.includes('agency')) {
            if (!requesterCode) throw new AppError(403, 'FORBIDDEN', 'Agency is missing code');
            const allowed = await listMediatorCodesForAgency(requesterCode);
            if (!allowed.includes(orderManagerCode)) {
              throw new AppError(403, 'FORBIDDEN', 'You can only revert orders within your agency');
            }
          }
        }

        const wf = String((order as any).workflowStatus || 'CREATED');
        if (!['COMPLETED', 'FAILED', 'REWARD_PENDING'].includes(wf)) {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot revert settlement in state ${wf}`);
        }

        const prevAffiliateStatus = String(order.affiliateStatus || '');

        if (String(order.paymentStatus) !== 'Paid') {
          throw new AppError(409, 'NOT_SETTLED', 'Order is not settled');
        }

        const productId = String(order.items?.[0]?.productId || '').trim();
        const campaignId = order.items?.[0]?.campaignId;
        const mediatorCode = String(order.managerName || '').trim();

        const campaign = campaignId ? await db().campaign.findFirst({ where: { id: campaignId, isDeleted: false } }) : null;
        const brandId = String(order.brandUserId || campaign?.brandUserId || '').trim();

        const isCapExceeded = String(order.affiliateStatus) === 'Cap_Exceeded';
        const settlementMode = String((order as any).settlementMode || 'wallet');

        // Build the common order update data for both paths
        const buildUnsettleData = () => {
          let evts = order.events as any;
          evts = pushOrderEvent(evts, {
            type: 'UNSETTLED',
            at: new Date(),
            actorUserId: req.auth?.userId,
            metadata: {
              reason: 'UNSETTLE',
              paymentStatus: { from: 'Paid', to: 'Pending' },
              affiliateStatus: { from: prevAffiliateStatus, to: 'Pending_Cooling' },
            },
          });
          evts = pushOrderEvent(evts, {
            type: 'WORKFLOW_TRANSITION',
            at: new Date(),
            actorUserId: req.auth?.userId,
            metadata: { from: wf, to: 'APPROVED', forced: true, source: 'unsettleOrderPayment' },
          });
          return {
            workflowStatus: 'APPROVED',
            paymentStatus: 'Pending',
            affiliateStatus: 'Pending_Cooling',
            settlementRef: null,
            settlementMode: 'wallet',
            events: evts,
          } as any;
        };

        if (!isCapExceeded && settlementMode !== 'external') {
          if (!productId) throw new AppError(409, 'MISSING_DEAL_ID', 'Order is missing deal reference');
          const deal = await db().deal.findFirst({ where: { ...idWhere(productId), isDeleted: false } });
          if (!deal) throw new AppError(409, 'DEAL_NOT_FOUND', 'Cannot revert: deal not found');

          const payoutPaise = Number(deal.payoutPaise ?? 0);
          const buyerCommissionPaise = Number(order.items?.[0]?.commissionPaise ?? 0);
          const mediatorMarginPaise = payoutPaise - buyerCommissionPaise;

          const buyerUserId = order.userId;
          if (!buyerUserId) {
            throw new AppError(409, 'MISSING_BUYER', 'Cannot revert: order is missing buyer userId');
          }
          if (!brandId) throw new AppError(409, 'MISSING_BRAND', 'Cannot revert: missing brand ownership');

          await ensureWallet(brandId);

          let unsettleMediatorUserId: string | null = null;
          if (mediatorMarginPaise > 0 && mediatorCode) {
            const mediator = await db().user.findFirst({ where: { mediatorCode, isDeleted: false }, select: { id: true } });
            if (mediator) {
              unsettleMediatorUserId = mediator.id;
            }
          }

          // Atomic unsettlement using Prisma transaction
          await db().$transaction(async (tx: any) => {
            await applyWalletCredit({
              idempotencyKey: `order-unsettle-credit-brand-${order.mongoId}`,
              type: 'refund',
              ownerUserId: brandId,
              fromUserId: buyerUserId,
              toUserId: brandId,
              amountPaise: payoutPaise,
              orderId: order.mongoId!,
              campaignId: campaignId ? String(campaignId) : undefined,
              metadata: { reason: 'ORDER_UNSETTLE', dealId: productId, mediatorCode },
              tx,
            });

            if (buyerCommissionPaise > 0) {
              await applyWalletDebit({
                idempotencyKey: `order-unsettle-debit-buyer-${order.mongoId}`,
                type: 'commission_reversal',
                ownerUserId: buyerUserId,
                fromUserId: buyerUserId,
                toUserId: brandId,
                amountPaise: buyerCommissionPaise,
                orderId: order.mongoId!,
                campaignId: campaignId ? String(campaignId) : undefined,
                metadata: { reason: 'ORDER_UNSETTLE_COMMISSION', dealId: productId },
                tx,
              });
            }

            if (unsettleMediatorUserId && mediatorMarginPaise > 0) {
              await applyWalletDebit({
                idempotencyKey: `order-unsettle-debit-mediator-${order.mongoId}`,
                type: 'margin_reversal',
                ownerUserId: unsettleMediatorUserId,
                fromUserId: unsettleMediatorUserId,
                toUserId: brandId,
                amountPaise: mediatorMarginPaise,
                orderId: order.mongoId!,
                campaignId: campaignId ? String(campaignId) : undefined,
                metadata: { reason: 'ORDER_UNSETTLE_MARGIN', dealId: productId, mediatorCode },
                tx,
              });
            }

            await tx.order.update({ where: { id: order.id }, data: buildUnsettleData() });
          }, { timeout: 15000 });
        } else {
          // Non-wallet path (cap exceeded or external settlement): no transaction needed.
          await db().order.update({ where: { id: order.id }, data: buildUnsettleData() });
        }

        await writeAuditLog({
          req,
          action: 'ORDER_UNSETTLED',
          entityType: 'Order',
          entityId: order.mongoId!,
          metadata: { previousWorkflow: wf, previousAffiliateStatus: prevAffiliateStatus },
        });
        businessLog.info('Order unsettled', { orderId: order.mongoId, previousWorkflow: wf, previousAffiliateStatus: prevAffiliateStatus, settlementMode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'ORDER_UNSETTLED', changedFields: ['workflowStatus', 'paymentStatus', 'affiliateStatus'], before: { workflowStatus: wf, paymentStatus: 'Paid', affiliateStatus: prevAffiliateStatus }, after: { workflowStatus: 'APPROVED', paymentStatus: 'Pending', affiliateStatus: 'Pending_Cooling' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Order', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'UNSETTLE_ORDER', orderId: order.mongoId } });

        const managerCode = String(order.managerName || '').trim();
        const agencyCode = managerCode ? ((await getAgencyCodeForMediatorCode(managerCode)) || '') : '';
        const audience = await buildOrderAudience(order, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });
        if (settlementMode !== 'external') {
          publishRealtime({ type: 'wallets.changed', ts: new Date().toISOString(), audience });
        }
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/unsettleOrderPayment' } });
        next(err);
      }
    },

    createCampaign: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = createCampaignSchema.parse(req.body);
        const { roles, pgUserId, user: requester } = getRequester(req);

        const allowed = Array.isArray(body.allowedAgencies) ? body.allowedAgencies : [];

        // Privileged: create campaigns on behalf of a brand.
        if (isPrivileged(roles)) {
          const brandUserId = String(body.brandUserId || '').trim();
          if (!brandUserId) throw new AppError(400, 'MISSING_BRAND_USER_ID', 'brandUserId is required');

          const brand = await db().user.findFirst({ where: { ...idWhere(brandUserId), isDeleted: false } });
          if (!brand) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
          if (!(Array.isArray(brand.roles) ? brand.roles : []).includes('brand')) throw new AppError(400, 'INVALID_BRAND', 'Invalid brand');
          if (brand.status !== 'active') throw new AppError(409, 'BRAND_SUSPENDED', 'Brand is not active');

          const connected = Array.isArray(brand.connectedAgencies) ? brand.connectedAgencies : [];
          if (allowed.length && !allowed.every((c) => connected.includes(String(c)))) {
            throw new AppError(400, 'INVALID_ALLOWED_AGENCIES', 'allowedAgencies must be connected to brand');
          }

          const campaign = await db().campaign.create({
            data: {
              title: body.title,
              brandUserId: brand.id,
              brandName: String(brand.name || 'Brand'),
              platform: body.platform,
              image: body.image,
              productUrl: body.productUrl,
              originalPricePaise: rupeesToPaise(body.originalPrice),
              pricePaise: rupeesToPaise(body.price),
              payoutPaise: rupeesToPaise(body.payout),
              totalSlots: body.totalSlots,
              usedSlots: 0,
              status: 'active',
              allowedAgencyCodes: allowed,
              dealType: body.dealType,
              returnWindowDays: body.returnWindowDays ?? 14,
              createdBy: pgUserId || undefined,
            },
          });

          await writeAuditLog({ req, action: 'CAMPAIGN_CREATED', entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id });
          businessLog.info('Campaign created (privileged)', { campaignId: campaign.mongoId ?? campaign.id, title: body.title, platform: body.platform, brandUserId: brand.id, totalSlots: body.totalSlots, payoutRupees: body.payout, dealType: body.dealType, createdBy: pgUserId });
          logChangeEvent({ actorUserId: pgUserId, entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id, action: 'CAMPAIGN_CREATED', metadata: { title: body.title, platform: body.platform, brandName: brand.name, totalSlots: body.totalSlots, payout: body.payout, dealType: body.dealType, allowedAgencies: allowed } });
          logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_CREATED', campaignId: campaign.mongoId ?? campaign.id, title: body.title, brandUserId: brand.id } });
          const ts = new Date().toISOString();
          publishRealtime({
            type: 'deals.changed',
            ts,
            payload: { campaignId: campaign.mongoId ?? campaign.id },
            audience: {
              userIds: [brand.mongoId!],
              agencyCodes: allowed.map((c) => String(c).trim()).filter(Boolean),
              roles: ['admin', 'ops'],
            },
          });
          res.status(201).json(toUiCampaign(pgCampaign(campaign)));
          return;
        }

        // Non-privileged (agency/mediator): allow creating self-owned inventory campaigns.
        if (!roles.includes('agency') && !roles.includes('mediator')) {
          throw new AppError(403, 'FORBIDDEN', 'Only agency/mediator can create campaigns via ops endpoint');
        }

        const selfCode = String((requester as any)?.mediatorCode || '').trim();
        if (!selfCode) throw new AppError(409, 'MISSING_CODE', 'User is missing a code');
        if (!allowed.length) throw new AppError(400, 'INVALID_ALLOWED_AGENCIES', 'allowedAgencies is required');
        const normalizedAllowed = allowed.map((c) => String(c).trim()).filter(Boolean);
        const onlySelf = normalizedAllowed.length === 1 && normalizedAllowed[0] === selfCode;
        if (!onlySelf) {
          throw new AppError(403, 'FORBIDDEN', 'Non-privileged users can only create campaigns for their own code');
        }

        const campaign = await db().campaign.create({
          data: {
            title: body.title,
            brandUserId: pgUserId,
            brandName: body.brandName?.trim() || String((requester as any).name || 'Inventory'),
            platform: body.platform,
            image: body.image,
            productUrl: body.productUrl,
            originalPricePaise: rupeesToPaise(body.originalPrice),
            pricePaise: rupeesToPaise(body.price),
            payoutPaise: rupeesToPaise(body.payout),
            totalSlots: body.totalSlots,
            usedSlots: 0,
            status: 'active',
            allowedAgencyCodes: normalizedAllowed,
            dealType: body.dealType,
            returnWindowDays: body.returnWindowDays ?? 14,
            createdBy: pgUserId || undefined,
          },
        });

        await writeAuditLog({ req, action: 'CAMPAIGN_CREATED', entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id });
        businessLog.info('Campaign created (self-service)', { campaignId: campaign.mongoId ?? campaign.id, title: body.title, platform: body.platform, createdBy: req.auth?.userId, allowedCodes: normalizedAllowed, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, actorRoles: req.auth?.roles, actorIp: req.ip, entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id, action: 'CAMPAIGN_CREATED', requestId: String((res as any).locals?.requestId || ''), metadata: { title: body.title, platform: body.platform, allowedAgencyCodes: normalizedAllowed } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_CREATED', campaignId: campaign.mongoId ?? campaign.id, title: body.title } });
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: campaign.mongoId ?? campaign.id },
          audience: {
            agencyCodes: normalizedAllowed,
            mediatorCodes: normalizedAllowed,
            roles: ['admin', 'ops'],
          },
        });
        res.status(201).json(toUiCampaign(pgCampaign(campaign)));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/createCampaign' } });
        next(err);
      }
    },

    updateCampaignStatus: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const campaignId = String(req.params.campaignId || '').trim();
        if (!campaignId) throw new AppError(400, 'INVALID_CAMPAIGN_ID', 'Valid campaignId required');

        const body = updateCampaignStatusSchema.parse(req.body);
        const nextStatus = String(body.status || '').toLowerCase();
        if (!['active', 'paused', 'completed', 'draft'].includes(nextStatus)) {
          throw new AppError(400, 'INVALID_STATUS', 'Invalid status');
        }

        const { roles, pgUserId, user: requester } = getRequester(req);
        const campaign = await db().campaign.findFirst({ where: { ...idWhere(campaignId), isDeleted: false } });
        if (!campaign) {
          throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
        }

        if (!isPrivileged(roles)) {
          if (!roles.includes('agency')) {
            throw new AppError(403, 'FORBIDDEN', 'Only agencies can update campaign status');
          }
          const requesterCode = String((requester as any)?.mediatorCode || '').trim();
          const allowedCodes = Array.isArray(campaign.allowedAgencyCodes)
            ? campaign.allowedAgencyCodes.map((c: any) => String(c).trim()).filter(Boolean)
            : [];
          const isAllowedAgency = requesterCode && allowedCodes.includes(requesterCode);
          const isOwner = String(campaign.brandUserId || '') === String(pgUserId || '');
          if (!isAllowedAgency && !isOwner) {
            throw new AppError(403, 'FORBIDDEN', 'Cannot update campaigns outside your network');
          }
        }

        const previousStatus = String(campaign.status || '').toLowerCase();

        const updated = await db().campaign.update({
          where: { id: campaign.id },
          data: { status: nextStatus as any, updatedBy: pgUserId || undefined },
        });

        if (previousStatus !== nextStatus) {
          await db().deal.updateMany({
            where: { campaignId: campaign.id, isDeleted: false },
            data: { active: nextStatus === 'active' },
          });
        }

        const allowed = Array.isArray(campaign.allowedAgencyCodes)
          ? campaign.allowedAgencyCodes.map((c: any) => String(c).trim()).filter(Boolean)
          : [];
        const brandMongoId = await db().user.findUnique({ where: { id: campaign.brandUserId }, select: { mongoId: true } });
        const brandUserMongoId = brandMongoId?.mongoId || '';
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: campaign.mongoId ?? campaign.id, status: nextStatus },
          audience: {
            userIds: [brandUserMongoId].filter(Boolean),
            agencyCodes: allowed,
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'campaign.status', campaignId: campaign.mongoId ?? campaign.id, status: nextStatus },
          audience: {
            userIds: [brandUserMongoId].filter(Boolean),
            agencyCodes: allowed,
            roles: ['admin', 'ops'],
          },
        });

        await writeAuditLog({
          req,
          action: 'CAMPAIGN_STATUS_CHANGED',
          entityType: 'Campaign',
          entityId: campaign.mongoId ?? campaign.id,
          metadata: { previousStatus, newStatus: nextStatus },
        });
        businessLog.info('Campaign status changed', { campaignId: campaign.mongoId ?? campaign.id, previousStatus, newStatus: nextStatus });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id, action: 'STATUS_CHANGE', changedFields: ['status'], before: { status: previousStatus }, after: { status: nextStatus } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_STATUS_CHANGED', campaignId: campaign.mongoId ?? campaign.id, previousStatus, newStatus: nextStatus } });

        res.json(toUiCampaign(pgCampaign(updated)));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/updateCampaignStatus' } });
        next(err);
      }
    },

    deleteCampaign: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const campaignId = String(req.params.campaignId || '').trim();
        if (!campaignId) throw new AppError(400, 'INVALID_CAMPAIGN_ID', 'Valid campaignId required');

        const { roles, pgUserId } = getRequester(req);

        const campaign = await db().campaign.findFirst({ where: { ...idWhere(campaignId), isDeleted: false } });
        if (!campaign) {
          throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
        }

        const isOwner = String(campaign.brandUserId || '') === String(pgUserId || '');
        const canDelete = isPrivileged(roles) || (isOwner && (roles.includes('agency') || roles.includes('mediator')));
        if (!canDelete) {
          throw new AppError(403, 'FORBIDDEN', 'Not allowed to delete this campaign');
        }

        const hasOrders = await db().orderItem.findFirst({
          where: { campaignId: campaign.id, isDeleted: false, order: { isDeleted: false } },
          select: { id: true },
        });
        if (hasOrders) throw new AppError(409, 'CAMPAIGN_HAS_ORDERS', 'Cannot delete a campaign with orders');

        try {
          await db().campaign.update({
            where: { id: campaign.id, isDeleted: false },
            data: { isDeleted: true, updatedBy: pgUserId || undefined},
          });
        } catch {
          throw new AppError(409, 'CAMPAIGN_ALREADY_DELETED', 'Campaign already deleted');
        }

        await db().deal.updateMany({
          where: { campaignId: campaign.id, isDeleted: false },
          data: { isDeleted: true, updatedBy: pgUserId || undefined, active: false },
        });

        await writeAuditLog({
          req,
          action: 'CAMPAIGN_DELETED',
          entityType: 'Campaign',
          entityId: campaign.mongoId ?? campaign.id,
        });
        businessLog.info('Campaign deleted', { campaignId: campaign.mongoId ?? campaign.id, title: campaign.title });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id, action: 'CAMPAIGN_DELETED', changedFields: ['isDeleted'], before: { isDeleted: false }, after: { isDeleted: new Date().toISOString() } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_DELETED', campaignId: campaign.mongoId ?? campaign.id, title: campaign.title } });

        const allowed = Array.isArray(campaign.allowedAgencyCodes)
          ? campaign.allowedAgencyCodes.map((c: any) => String(c).trim()).filter(Boolean)
          : [];
        const assignments = campaign.assignments;
        const assignmentCodes = assignments && typeof assignments === 'object' && !Array.isArray(assignments)
          ? Object.keys(assignments)
          : [];

        // Resolve brandUserId (PG UUID) â†’ mongoId for realtime audience
        const brandUser = await db().user.findUnique({ where: { id: campaign.brandUserId }, select: { mongoId: true } });
        const brandMongoId = brandUser?.mongoId || '';

        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: campaign.mongoId ?? campaign.id },
          audience: {
            userIds: [brandMongoId].filter(Boolean),
            agencyCodes: allowed,
            mediatorCodes: assignmentCodes,
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'campaign.deleted', campaignId: campaign.mongoId ?? campaign.id },
          audience: {
            userIds: [brandMongoId].filter(Boolean),
            agencyCodes: allowed,
            mediatorCodes: assignmentCodes,
            roles: ['admin', 'ops'],
          },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/deleteCampaign' } });
        next(err);
      }
    },

    assignSlots: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = assignSlotsSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);
        const campaign = await db().campaign.findFirst({ where: { ...idWhere(body.id), isDeleted: false } });
        if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');

        // Campaign must be active or draft to accept new assignments.
        // Draft campaigns get auto-activated upon successful distribution.
        const campStatus = String(campaign.status || '').toLowerCase();
        if (!['active', 'draft'].includes(campStatus)) {
          throw new AppError(409, 'CAMPAIGN_NOT_ACTIVE', 'Campaign must be active or draft to assign slots');
        }
        const wasDraft = campStatus === 'draft';

        // Check if orders exist â€“ if so, only block term changes (price, dealType),
        // but still allow adding/modifying mediator assignments.
        const hasOrders = await db().orderItem.findFirst({
          where: { campaignId: campaign.id, isDeleted: false, order: { isDeleted: false } },
          select: { id: true },
        });

        const attemptingTermChange =
          typeof (body as any).dealType !== 'undefined' ||
          typeof (body as any).price !== 'undefined';

        if (campaign.locked && attemptingTermChange) {
          throw new AppError(409, 'CAMPAIGN_LOCKED', 'Campaign terms are locked after slot assignment. You can still add new mediators.');
        }
        if (hasOrders && attemptingTermChange) {
          throw new AppError(409, 'CAMPAIGN_LOCKED', 'Campaign terms are locked after first order. You can still add new mediators.');
        }

        const agencyCode = roles.includes('agency') && !isPrivileged(roles)
          ? String((requester as any)?.mediatorCode || '').trim()
          : '';

        if (agencyCode) {
          const allowed = Array.isArray(campaign.allowedAgencyCodes) ? campaign.allowedAgencyCodes : [];
          if (!allowed.includes(agencyCode)) {
            throw new AppError(403, 'FORBIDDEN', 'Campaign not assigned to this agency');
          }
        }

        // â”€â”€ "Open to All" mode: skip per-mediator allocation â”€â”€
        const isOpenToAll = body.openToAll === true;

        const positiveEntries = Object.entries(body.assignments || {}).filter(([, assignment]) => {
          if (typeof assignment === 'number') return assignment > 0;
          const limit = Number((assignment as any)?.limit ?? 0);
          return Number.isFinite(limit) && limit > 0;
        });
        if (!isOpenToAll && positiveEntries.length === 0) {
          throw new AppError(400, 'NO_ASSIGNMENTS', 'At least one allocation (limit > 0) is required');
        }

        // Security: agency can only assign to active mediators under its own code.
        if (agencyCode && !isOpenToAll) {
          const assignmentCodes = positiveEntries.map(([code]) => String(code).trim()).filter(Boolean);
          const mediators = await db().user.findMany({
            where: {
              roles: { has: 'mediator' },
              mediatorCode: { in: assignmentCodes },
              parentCode: agencyCode,
              status: 'active',
              isDeleted: false,
            },
            select: { mediatorCode: true },
          });
          const allowedCodes = new Set(mediators.map((m: any) => String(m.mediatorCode || '').trim()).filter(Boolean));
          const invalid = assignmentCodes.filter((c) => !allowedCodes.has(String(c).trim()));
          if (invalid.length) {
            throw new AppError(403, 'INVALID_MEDIATOR_CODE', 'One or more mediators are not active or not in your team');
          }
        }

        const commissionPaise =
          typeof body.commission !== 'undefined' ? rupeesToPaise(body.commission) : undefined;

        const payoutOverridePaise =
          typeof body.payout !== 'undefined' ? rupeesToPaise(body.payout) : undefined;

        // assignments is JSONB object in PG (not a Map)
        const current: Record<string, any> = campaign.assignments && typeof campaign.assignments === 'object' && !Array.isArray(campaign.assignments)
          ? { ...(campaign.assignments as any) }
          : {};

        for (const [code, assignment] of positiveEntries) {
          const normCode = code.toLowerCase();
          const assignmentObj = typeof assignment === 'number'
            ? { limit: assignment, payout: payoutOverridePaise ?? campaign.payoutPaise }
            : {
              limit: (assignment as any).limit,
              payout:
                typeof (assignment as any).payout === 'number'
                  ? rupeesToPaise((assignment as any).payout)
                  : (payoutOverridePaise ?? campaign.payoutPaise),
            };
          if (typeof commissionPaise !== 'undefined') {
            (assignmentObj as any).commissionPaise = commissionPaise;
          }
          current[normCode] = assignmentObj;
        }

        // Enforce totalSlots (skip for openToAll since no per-mediator allocation)
        const totalAssigned = Object.values(current).reduce(
          (sum: number, a: any) => sum + Number(typeof a === 'number' ? a : a?.limit ?? 0),
          0
        );
        if (!isOpenToAll && totalAssigned > (campaign.totalSlots ?? 0)) {
          throw new AppError(
            409,
            'ASSIGNMENT_EXCEEDS_TOTAL_SLOTS',
            `Total assigned slots (${totalAssigned}) exceed campaign capacity (${campaign.totalSlots})`
          );
        }

        const updateData: any = {
          assignments: isOpenToAll ? {} : current,
          openToAll: isOpenToAll,
        };

        if (body.dealType) updateData.dealType = body.dealType;
        if (typeof body.price !== 'undefined') updateData.pricePaise = rupeesToPaise(body.price);

        // Auto-activate draft campaigns upon first distribution
        if (wasDraft) {
          updateData.status = 'active';
        }

        if (!campaign.locked) {
          updateData.locked = true;
          updateData.lockedAt = new Date();
          updateData.lockedReason = 'SLOT_ASSIGNMENT';
        }

        // Optimistic concurrency via updatedAt check â€” prevents slot overwrites
        // when two requests try to assign simultaneously.
        try {
          const updated = await db().campaign.updateMany({
            where: { id: campaign.id, updatedAt: campaign.updatedAt },
            data: updateData,
          });
          if (updated.count === 0) {
            throw new AppError(409, 'CONCURRENT_MODIFICATION', 'Campaign was modified concurrently, please retry');
          }
        } catch (saveErr: any) {
          if (saveErr instanceof AppError) throw saveErr;
          if (saveErr?.code === 'P2025') {
            throw new AppError(409, 'CONCURRENT_MODIFICATION', 'Campaign was modified concurrently, please retry');
          }
          throw saveErr;
        }

        await writeAuditLog({ req, action: 'CAMPAIGN_SLOTS_ASSIGNED', entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id });
        businessLog.info('Campaign slots assigned', { campaignId: campaign.mongoId ?? campaign.id, totalAssigned, mediators: positiveEntries.map(([c]) => c) });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: campaign.mongoId ?? campaign.id, action: 'SLOTS_ASSIGNED', changedFields: ['assignments', 'locked'], before: { locked: campaign.locked }, after: { locked: true, totalAssigned, assignedMediators: positiveEntries.map(([c]) => c) } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'SLOTS_ASSIGNED', campaignId: campaign.mongoId ?? campaign.id, totalAssigned, mediatorCount: positiveEntries.length } });

        const assignmentCodes = positiveEntries.map(([c]) => String(c).trim()).filter(Boolean);
        const agencyCodeMap = await getAgencyCodesForMediatorCodes(assignmentCodes);
        const inferredAgencyCodes = [...agencyCodeMap.values()].filter((c): c is string => typeof c === 'string' && !!c);

        const agencyCodes = Array.from(
          new Set([
            ...(campaign.allowedAgencyCodes ?? []).map((c: any) => String(c).trim()).filter(Boolean),
            ...assignmentCodes,
            ...inferredAgencyCodes,
          ])
        ).filter(Boolean);

        // Resolve brandUserId â†’ mongoId for audience
        const brandUser = await db().user.findUnique({ where: { id: campaign.brandUserId }, select: { mongoId: true } });
        const brandMongoId = brandUser?.mongoId || '';

        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: campaign.mongoId ?? campaign.id },
          audience: {
            userIds: [brandMongoId].filter(Boolean),
            agencyCodes,
            mediatorCodes: assignmentCodes,
            roles: ['admin', 'ops'],
          },
        });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/assignSlots' } });
        next(err);
      }
    },

    publishDeal: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = publishDealSchema.parse(req.body);
        const { roles, pgUserId, user: requester } = getRequester(req);
        const campaign = await db().campaign.findFirst({ where: { ...idWhere(body.id), isDeleted: false } });
        if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');

        const normalizeCode = (v: unknown) => normalizeMediatorCode(v);
        const requestedCode = normalizeCode(body.mediatorCode);

        const findAssignmentForMediator = (assignments: any, mediatorCode: string) => {
          const target = normalizeCode(mediatorCode);
          if (!target) return null;
          const obj = assignments && typeof assignments === 'object' && !Array.isArray(assignments) ? assignments : {};

          if (Object.prototype.hasOwnProperty.call(obj, target)) return (obj as any)[target] ?? null;

          const targetLower = target.toLowerCase();
          for (const [k, v] of Object.entries(obj)) {
            if (String(k).trim().toLowerCase() === targetLower) return v as any;
          }
          return null;
        };

        if (!isPrivileged(roles)) {
          if (!roles.includes('mediator')) throw new AppError(403, 'FORBIDDEN', 'Only mediators can publish deals');
          const selfCode = normalizeCode((requester as any)?.mediatorCode);
          if (!selfCode || selfCode.toLowerCase() !== requestedCode.toLowerCase()) {
            throw new AppError(403, 'FORBIDDEN', 'Cannot publish deals for other mediators');
          }

          const agencyCode = normalizeCode((requester as any)?.parentCode);
          const allowedCodesRaw = Array.isArray(campaign.allowedAgencyCodes) ? campaign.allowedAgencyCodes : [];
          const allowedCodes = new Set(
            allowedCodesRaw
              .map((c: unknown) => normalizeCode(c))
              .filter((c: string): c is string => Boolean(c))
              .map((c: string) => c.toLowerCase())
          );

          const slotAssignment = findAssignmentForMediator(campaign.assignments, requestedCode);
          const hasAssignment = !!slotAssignment && Number((slotAssignment as any)?.limit ?? 0) > 0;

          // "Open to All" campaigns: allow any mediator whose agency is in allowedAgencyCodes
          const campaignIsOpenToAll = (campaign as any).openToAll === true;

          const isAllowed = campaignIsOpenToAll || (agencyCode && allowedCodes.has(agencyCode.toLowerCase())) || allowedCodes.has(selfCode.toLowerCase()) || hasAssignment;
          if (!isAllowed) {
            throw new AppError(403, 'FORBIDDEN', 'Campaign not assigned to your network');
          }
        }

        const slotAssignment = findAssignmentForMediator(campaign.assignments, requestedCode);
        const commissionPaise = rupeesToPaise(body.commission);
        const pricePaise = Number(campaign.pricePaise ?? 0) + commissionPaise;

        const payoutPaise = Number((slotAssignment as any)?.payout ?? campaign.payoutPaise ?? 0);

        if (payoutPaise < 0) {
          throw new AppError(400, 'INVALID_PAYOUT', 'Cannot publish deal with negative payout.');
        }

        const netEarnings = payoutPaise + commissionPaise;
        if (netEarnings < 0) {
          throw new AppError(400, 'INVALID_ECONOMICS', 'Buyer discount cannot exceed your commission from agency');
        }

        if (String(campaign.status || '').toLowerCase() !== 'active') {
          throw new AppError(409, 'CAMPAIGN_NOT_ACTIVE', 'Campaign is not active; cannot publish deal');
        }

        // Check if deal already published (case-insensitive mediator code match)
        const existingDeal = await db().deal.findFirst({
          where: {
            campaignId: campaign.id,
            mediatorCode: { equals: requestedCode, mode: 'insensitive' },
            isDeleted: false,
          },
        });

        if (existingDeal) {
          await db().deal.update({
            where: { id: existingDeal.id },
            data: {
              commissionPaise,
              pricePaise,
              payoutPaise,
              active: true,
            },
          });
        } else {
          await db().deal.create({
            data: {
              campaignId: campaign.id,
              mediatorCode: requestedCode,
              title: campaign.title,
              image: campaign.image,
              productUrl: campaign.productUrl,
              platform: campaign.platform,
              brandName: campaign.brandName,
              dealType: campaign.dealType ?? 'Discount',
              originalPricePaise: campaign.originalPricePaise,
              pricePaise,
              commissionPaise,
              payoutPaise,
              active: true,
              createdBy: pgUserId || undefined,
            },
          });
        }

        const campaignDisplayId = campaign.mongoId ?? campaign.id;
        await writeAuditLog({
          req,
          action: 'DEAL_PUBLISHED',
          entityType: 'Deal',
          entityId: `${campaignDisplayId}:${requestedCode}`,
          metadata: { campaignId: campaignDisplayId, mediatorCode: requestedCode },
        });
        businessLog.info('Deal published', { campaignId: campaignDisplayId, mediatorCode: requestedCode, isUpdate: !!existingDeal, commissionPaise, payoutPaise, pricePaise });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Deal', entityId: `${campaignDisplayId}:${requestedCode}`, action: 'DEAL_PUBLISHED', changedFields: ['active', 'commissionPaise', 'pricePaise', 'payoutPaise'], before: { existed: !!existingDeal }, after: { active: true, commissionPaise, pricePaise, payoutPaise, mediatorCode: requestedCode } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Deal', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'DEAL_PUBLISHED', campaignId: campaignDisplayId, mediatorCode: requestedCode } });

        const agencyCode = (await getAgencyCodeForMediatorCode(requestedCode)) || '';
        publishRealtime({
          type: 'deals.changed',
          ts: new Date().toISOString(),
          payload: { campaignId: campaignDisplayId, mediatorCode: requestedCode },
          audience: {
            roles: ['admin', 'ops'],
            mediatorCodes: [requestedCode],
            parentCodes: [requestedCode],
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
          },
        });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/publishDeal' } });
        next(err);
      }
    },

    payoutMediator: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = payoutMediatorSchema.parse(req.body);
        const { roles, pgUserId, user: requester } = getRequester(req);
        const canAny = isPrivileged(roles);
        const canAgency = roles.includes('agency') && !canAny;
        if (!canAny && !canAgency) {
          throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
        }

        if (canAgency) {
          const agencyCode = String((requester as any)?.mediatorCode || '').trim();
          if (!agencyCode) throw new AppError(409, 'MISSING_CODE', 'Agency is missing code');
          if (!(await isAgencyActive(agencyCode))) {
            throw new AppError(409, 'FROZEN_SUSPENSION', 'Agency is not active; payouts are blocked');
          }
        }
        const user = await db().user.findFirst({ where: { ...idWhere(body.mediatorId), isDeleted: false }, select: { id: true, mongoId: true, roles: true, parentCode: true, status: true, mediatorCode: true } });
        if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

        if (canAgency) {
          const agencyCode = String((requester as any)?.mediatorCode || '').trim();
          const isMediator = Array.isArray(user.roles) && user.roles.includes('mediator');
          if (!isMediator) throw new AppError(409, 'INVALID_BENEFICIARY', 'Beneficiary must be a mediator');
          const parentCode = String(user.parentCode || '').trim();
          if (!parentCode || parentCode !== agencyCode) {
            throw new AppError(403, 'FORBIDDEN', 'You can only payout mediators within your agency');
          }
        }
        if (user.status !== 'active') {
          throw new AppError(409, 'FROZEN_SUSPENSION', 'Beneficiary is not active; payouts are blocked');
        }

        const agencyCode = String(user.parentCode || '').trim();
        if (agencyCode && !(await isAgencyActive(agencyCode))) {
          throw new AppError(409, 'FROZEN_SUSPENSION', 'Upstream agency is not active; payouts are blocked');
        }

        const wallet = await ensureWallet(user.id);
        const amountPaise = rupeesToPaise(body.amount);

        if (canAny && wallet.availablePaise < amountPaise) {
          throw new AppError(409, 'INSUFFICIENT_FUNDS', `Wallet only has â‚¹${(wallet.availablePaise / 100).toFixed(2)} available but payout is â‚¹${body.amount}`);
        }

        const requestId = String(
          (req as any).headers?.['x-request-id'] ||
          (res.locals as any)?.requestId ||
          ''
        ).trim();
        const _idempotencySuffix = requestId || `MANUAL-${user.id}-${amountPaise}-${new Date().toISOString().slice(0, 10)}`;

        await db().$transaction(async (tx: any) => {
          const payoutDoc = await tx.payout.create({
            data: {
              beneficiaryUserId: user.id,
              walletId: wallet.id,
              amountPaise,
              status: canAny ? 'paid' : 'recorded',
              provider: 'manual',
              providerRef: body.ref,
              processedAt: new Date(),
              requestedAt: new Date(),
              createdBy: pgUserId || undefined,
              updatedBy: pgUserId || undefined,
            },
          });

          if (canAny) {
            await applyWalletDebit({
              idempotencyKey: `payout_complete:${payoutDoc.id}`,
              type: 'payout_complete',
              ownerUserId: user.id,
              amountPaise,
              payoutId: payoutDoc.id,
              metadata: { provider: 'manual', source: 'ops_payout' },
              tx,
            });
          }

          const payoutDisplayId = payoutDoc.mongoId ?? payoutDoc.id;
          const userDisplayId = user.mongoId ?? user.id;
          await writeAuditLog({ req, action: 'PAYOUT_PROCESSED', entityType: 'Payout', entityId: payoutDisplayId, metadata: { beneficiaryUserId: userDisplayId, amountPaise, recordOnly: canAgency } });
          businessLog.info('Payout processed', { payoutId: payoutDisplayId, beneficiaryId: userDisplayId, amountPaise, mode: canAny ? 'paid' : 'recorded', mediatorCode: user.mediatorCode });
          logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Payout', entityId: payoutDisplayId, action: 'PAYOUT_PROCESSED', changedFields: ['status', 'amountPaise'], before: {}, after: { status: canAny ? 'paid' : 'recorded', amountPaise, beneficiaryUserId: userDisplayId } });
          logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Payout', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'PAYOUT_PROCESSED', payoutId: payoutDisplayId, amountPaise } });
          if (canAny) {
            walletLog.info('Payout debit applied', { payoutId: payoutDisplayId, beneficiaryId: userDisplayId, amountPaise });
          }
        }, { timeout: 15000 });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/payoutMediator' } });
        next(err);
      }
    },

    deletePayout: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const payoutId = String(req.params.payoutId || '').trim();
        if (!payoutId) throw new AppError(400, 'INVALID_PAYOUT_ID', 'Valid payoutId required');

        const { roles, pgUserId, user } = getRequester(req);
        const isPriv = isPrivileged(roles);
        if (!isPriv && !roles.includes('agency')) {
          throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
        }

        const payout = await db().payout.findFirst({ where: { ...idWhere(payoutId), isDeleted: false } });
        if (!payout) throw new AppError(404, 'PAYOUT_NOT_FOUND', 'Payout not found');

        const beneficiary = await db().user.findUnique({ where: { id: payout.beneficiaryUserId }, select: { id: true, mongoId: true, isDeleted: true, parentCode: true } });
        if (!beneficiary || beneficiary.isDeleted) throw new AppError(404, 'BENEFICIARY_NOT_FOUND', 'Beneficiary not found');

        if (!isPriv) {
          const agencyCode = String((user as any)?.mediatorCode || '').trim();
          if (!agencyCode) throw new AppError(409, 'MISSING_CODE', 'Agency is missing code');
          const beneficiaryAgency = String(beneficiary.parentCode || '').trim();
          if (!beneficiaryAgency || beneficiaryAgency !== agencyCode) {
            throw new AppError(403, 'FORBIDDEN', 'You can only delete payouts within your agency');
          }
        }

        const hasWalletTx = await db().transaction.findFirst({ where: { payoutId: payout.id, isDeleted: false }, select: { id: true } });
        if (hasWalletTx) {
          throw new AppError(409, 'PAYOUT_HAS_LEDGER', 'Cannot delete a payout with wallet ledger entries');
        }

        const result = await db().payout.updateMany({
          where: { id: payout.id, isDeleted: false },
          data: { isDeleted: true, updatedBy: pgUserId || undefined},
        });
        if (!result.count) {
          throw new AppError(409, 'PAYOUT_ALREADY_DELETED', 'Payout already deleted');
        }

        const payoutDisplayId = payout.mongoId ?? payout.id;
        const beneficiaryDisplayId = beneficiary.mongoId ?? beneficiary.id;
        await writeAuditLog({
          req,
          action: 'PAYOUT_DELETED',
          entityType: 'Payout',
          entityId: payoutDisplayId,
          metadata: { beneficiaryUserId: beneficiaryDisplayId },
        });
        businessLog.info('Payout deleted', { payoutId: payoutDisplayId, beneficiaryId: beneficiaryDisplayId, amountPaise: payout.amountPaise });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Payout', entityId: payoutDisplayId, action: 'PAYOUT_DELETED', changedFields: ['isDeleted'], before: { isDeleted: false }, after: { isDeleted: new Date().toISOString() } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Payout', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'PAYOUT_DELETED', payoutId: payoutDisplayId, beneficiaryId: beneficiaryDisplayId, amountPaise: payout.amountPaise } });

        const agencyCode = String(beneficiary.parentCode || '').trim();
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'payout.deleted', payoutId: payoutDisplayId },
          audience: {
            userIds: [beneficiaryDisplayId].filter(Boolean),
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/deletePayout' } });
        next(err);
      }
    },

    // Optional endpoint used by some UI versions.
    getTransactions: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, pgUserId } = getRequester(req);
        const where: any = { isDeleted: false };

        // Non-privileged roles only see their own transactions
        if (!isPrivileged(roles)) {
          where.OR = [
            { fromUserId: pgUserId },
            { toUserId: pgUserId },
          ];
        }

        const { page, limit, skip, isPaginated } = parsePagination(req.query, { limit: 100 });
        const [transactions, txTotal] = await Promise.all([
          db().transaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip,
          }),
          db().transaction.count({ where }),
        ]);
        res.json(paginatedResponse(transactions, txTotal, page, limit, isPaginated));

        businessLog.info('Transactions listed', { userId: req.auth?.userId, resultCount: transactions.length, total: txTotal, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Transaction',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'TRANSACTIONS_LISTED', endpoint: 'getTransactions', resultCount: transactions.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/getTransactions' } });
        next(err);
      }
    },

    copyCampaign: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = copyCampaignSchema.parse(req.body);
        const { roles, pgUserId, user: requester } = getRequester(req);
        const campaign = await db().campaign.findFirst({ where: { ...idWhere(id), isDeleted: false } });
        if (!campaign) {
          throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
        }

        // Authorization: brand owner, agency with access, or privileged
        if (!isPrivileged(roles)) {
          const isBrandOwner = campaign.brandUserId === pgUserId;
          const isAgencyAllowed = roles.includes('agency') &&
            Array.isArray(campaign.allowedAgencyCodes) &&
            campaign.allowedAgencyCodes.includes(String((requester as any)?.mediatorCode || ''));
          if (!isBrandOwner && !isAgencyAllowed) {
            throw new AppError(403, 'FORBIDDEN', 'Not authorized to copy this campaign');
          }
        }

        // Create a clean copy with reset assignments and slots
        const newCampaign = await db().campaign.create({
          data: {
            title: `${campaign.title} (Copy)`,
            brandUserId: campaign.brandUserId,
            brandName: campaign.brandName,
            platform: campaign.platform,
            image: campaign.image,
            productUrl: campaign.productUrl,
            dealType: campaign.dealType,
            pricePaise: campaign.pricePaise,
            originalPricePaise: campaign.originalPricePaise,
            payoutPaise: campaign.payoutPaise,
            totalSlots: campaign.totalSlots,
            returnWindowDays: campaign.returnWindowDays,
            usedSlots: 0,
            status: 'draft',
            allowedAgencyCodes: campaign.allowedAgencyCodes || [],
            assignments: {},
            locked: false,
            createdBy: pgUserId || undefined,
          },
        });

        const newDisplayId = newCampaign.mongoId ?? newCampaign.id;
        await writeAuditLog({
          req,
          action: 'CAMPAIGN_COPIED',
          entityType: 'Campaign',
          entityId: newDisplayId,
          metadata: { sourceCampaignId: id },
        });
        businessLog.info('Campaign copied', { newCampaignId: newDisplayId, sourceCampaignId: id, title: campaign.title });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: newDisplayId, action: 'CAMPAIGN_COPIED', changedFields: ['id'], before: { sourceCampaignId: id }, after: { newCampaignId: newDisplayId, status: 'draft', usedSlots: 0 } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_COPIED', newCampaignId: newDisplayId, sourceCampaignId: id } });

        res.json({
          ok: true,
          id: newDisplayId,
          campaign: {
            id: newDisplayId,
            title: newCampaign.title,
            image: newCampaign.image,
            dealType: newCampaign.dealType,
            totalSlots: newCampaign.totalSlots,
            usedSlots: 0,
            status: 'draft',
            price: (newCampaign.pricePaise ?? 0) / 100,
            payout: (newCampaign.payoutPaise ?? 0) / 100,
            assignments: {},
            brandId: newCampaign.brandUserId,
          },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/copyCampaign' } });
        next(err);
      }
    },

    declineOffer: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = declineOfferSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);
        requireAnyRole(roles, 'agency');

        const agencyCode = String((requester as any)?.mediatorCode || '').trim();
        if (!agencyCode) {
          throw new AppError(409, 'AGENCY_MISSING_CODE', 'Agency is missing a code');
        }

        const campaign = await db().campaign.findFirst({
          where: { ...idWhere(id), isDeleted: false },
          select: { id: true, mongoId: true, allowedAgencyCodes: true, brandUserId: true, title: true, isDeleted: true },
        });
        if (!campaign) {
          throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
        }

        const allowed: string[] = Array.isArray(campaign.allowedAgencyCodes)
          ? campaign.allowedAgencyCodes.map((c: any) => String(c))
          : [];
        if (!allowed.includes(agencyCode)) {
          throw new AppError(409, 'NOT_OFFERED', 'This campaign was not offered to your agency');
        }

        const newCodes = allowed.filter((c: string) => c !== agencyCode);
        await db().campaign.update({
          where: { id: campaign.id },
          data: { allowedAgencyCodes: newCodes },
        });

        const campaignDisplayId = campaign.mongoId ?? campaign.id;
        await writeAuditLog({
          req,
          action: 'OFFER_DECLINED',
          entityType: 'Campaign',
          entityId: campaignDisplayId,
          metadata: { agencyCode },
        });
        businessLog.info('Offer declined', { campaignId: campaignDisplayId, agencyCode, title: campaign.title });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: campaignDisplayId, action: 'OFFER_DECLINED', changedFields: ['allowedAgencyCodes'], before: { allowedAgencyCodes: allowed }, after: { allowedAgencyCodes: newCodes } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'OFFER_DECLINED', campaignId: campaignDisplayId, agencyCode } });

        // Resolve brandUserId (PG UUID) to mongoId for realtime audience
        let brandMongoId = '';
        if (campaign.brandUserId) {
          const brandUser = await db().user.findUnique({ where: { id: campaign.brandUserId }, select: { mongoId: true } });
          brandMongoId = brandUser?.mongoId || '';
        }

        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: campaignDisplayId },
          audience: {
            agencyCodes: [agencyCode],
            userIds: [brandMongoId].filter(Boolean),
            roles: ['admin', 'ops'],
          },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/declineOffer' } });
        next(err);
      }
    },

    forceApproveOrder: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = forceApproveOrderSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const order = await db().order.findFirst({
          where: { ...idWhere(body.orderId), isDeleted: false },
          include: { items: { where: { isDeleted: false } } },
        });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const wf = String((order as any).workflowStatus || 'CREATED');
        if (!['UNDER_REVIEW', 'PROOF_SUBMITTED', 'APPROVED'].includes(wf)) {
          throw new AppError(409, 'INVALID_WORKFLOW_STATE', `Cannot force approve in state ${wf}`);
        }

        // Non-admin/ops users MUST have all required proofs uploaded before force approving.
        // Only admin/ops can truly bypass proof requirements.
        if (!isPrivileged(roles)) {
          const required = getRequiredStepsForOrder(order);
          const missingProofs = required.filter((t) => !hasProofForRequirement(order, t));
          if (missingProofs.length) {
            throw new AppError(409, 'MISSING_PROOFS',
              `Cannot approve: buyer has not uploaded ${missingProofs.map(p => p === 'returnWindow' ? 'return window' : p).join(', ')} proof yet. Request the buyer to upload all required proofs first.`);
          }
          // Also require the order/purchase proof to exist
          if (!order.screenshotOrder && !order.screenshotPayment) {
            throw new AppError(409, 'MISSING_PROOFS',
              'Cannot approve: buyer has not uploaded purchase proof yet.');
          }
        }

        if (order.affiliateStatus !== 'Pending_Cooling') {
          const COOLING_PERIOD_DAYS = env.COOLING_PERIOD_DAYS ?? 14;
          const settleDate = new Date();
          settleDate.setDate(settleDate.getDate() + COOLING_PERIOD_DAYS);
          const currentEvents = Array.isArray(order.events) ? (order.events as any[]) : [];

          // Populate verification trail for all required steps so audit records exist
          const existingV = (order.verification && typeof order.verification === 'object')
            ? { ...(order.verification as any) } : {} as any;
          const now = new Date().toISOString();
          // Always mark purchase proof step
          if (!existingV.order?.verifiedAt) {
            existingV.order = { ...(existingV.order || {}), verifiedAt: now, verifiedBy: req.auth?.userId, autoVerified: false };
          }
          const requiredSteps = getRequiredStepsForOrder(order);
          for (const step of requiredSteps) {
            if (!existingV[step]?.verifiedAt) {
              existingV[step] = { ...(existingV[step] || {}), verifiedAt: now, verifiedBy: req.auth?.userId, autoVerified: false };
            }
          }

          await db().order.update({
            where: { id: order.id },
            data: {
              affiliateStatus: 'Pending_Cooling',
              expectedSettlementDate: settleDate,
              rejectionType: null,
              rejectionReason: null,
              rejectionAt: null,
              rejectionBy: null,
              verification: existingV,
              events: pushOrderEvent(currentEvents, {
                type: 'VERIFIED',
                at: new Date(),
                actorUserId: req.auth?.userId,
                metadata: { step: 'force_approval', note: body.note },
              }),
            },
          });

          if (wf !== 'APPROVED') {
            await transitionOrderWorkflow({
              orderId: order.mongoId!,
              from: wf as any,
              to: 'APPROVED',
              actorUserId: String(req.auth?.userId || ''),
              metadata: { source: 'forceApproveOrder' },
              env,
            });
          }
        }

        await writeAuditLog({ req, action: 'ORDER_FORCE_APPROVED', entityType: 'Order', entityId: order.mongoId!, metadata: { note: body.note } });
        orderLog.info('Order force approved', { orderId: order.mongoId, note: body.note });
        businessLog.info('Order force approved', { orderId: order.mongoId, approvedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'ORDER_CLAIM_VERIFIED', changedFields: ['affiliateStatus', 'expectedSettlementDate'], after: { affiliateStatus: 'Pending_Cooling' } });

        const audience = await buildOrderAudience(order, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/forceApproveOrder' } });
        next(err);
      }
    },

    cancelOrder: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = cancelOrderSchema.parse(req.body);
        const { roles, user: requester } = getRequester(req);

        const order = await db().order.findFirst({
          where: { ...idWhere(body.orderId), isDeleted: false },
          include: { items: { where: { isDeleted: false } } },
        });
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

        const agencyCode = await assertOrderAccess(order, roles, requester);

        const affiliateStatus = String((order as any).affiliateStatus || '');
        if (affiliateStatus === 'Approved_Settled' || affiliateStatus === 'Cap_Exceeded') {
          throw new AppError(409, 'CANNOT_CANCEL_SETTLED', 'Cannot cancel an already settled order');
        }
        const wf = String((order as any).workflowStatus || 'CREATED');
        if (wf === 'REJECTED' || affiliateStatus === 'Rejected') {
          throw new AppError(409, 'ALREADY_CANCELLED', 'This order is already cancelled');
        }

        // Release campaign slot
        const campaignId = order.items?.[0]?.campaignId;
        if (campaignId) {
          await db().$executeRaw`UPDATE "campaigns" SET "used_slots" = GREATEST("used_slots" - 1, 0) WHERE id = ${campaignId}::uuid AND "is_deleted" = false`;
        }

        const currentEvents = Array.isArray(order.events) ? (order.events as any[]) : [];
        await db().order.update({
          where: { id: order.id },
          data: {
            affiliateStatus: 'Rejected',
            rejectionType: 'order',
            rejectionReason: body.reason,
            rejectionAt: new Date(),
            rejectionBy: req.auth?.userId,
            events: pushOrderEvent(currentEvents, {
              type: 'REJECTED',
              at: new Date(),
              actorUserId: req.auth?.userId,
              metadata: { step: 'order_cancelled', reason: body.reason },
            }),
          },
        });

        if (!['REJECTED', 'FAILED', 'COMPLETED'].includes(wf)) {
          await transitionOrderWorkflow({
            orderId: order.mongoId!,
            from: wf as any,
            to: 'REJECTED',
            actorUserId: String(req.auth?.userId || ''),
            metadata: { source: 'cancelOrder', reason: body.reason },
            env,
          });
        }

        await writeAuditLog({ req, action: 'ORDER_CANCELLED', entityType: 'Order', entityId: order.mongoId!, metadata: { reason: body.reason } });
        if (campaignId) {
          writeAuditLog({ req, action: 'CAMPAIGN_SLOT_RELEASED', entityType: 'Campaign', entityId: String(campaignId), metadata: { orderId: order.mongoId ?? order.id, reason: 'order_cancelled' } }).catch(() => {});
        }
        orderLog.info('Order cancelled', { orderId: order.mongoId, reason: body.reason });
        businessLog.info('Order cancelled', { orderId: order.mongoId, cancelledBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: order.mongoId!, action: 'PROOF_REJECTED', changedFields: ['affiliateStatus', 'rejectionType', 'rejectionReason'], after: { affiliateStatus: 'Rejected' } });

        const audience = await buildOrderAudience(order, agencyCode);
        publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        const buyerId = audience.buyerMongoId;
        if (buyerId) {
          await sendPushToUser({ env, userId: buyerId, app: 'buyer', payload: { title: 'Order cancelled', body: body.reason || 'Your order has been cancelled.', url: '/orders' } }).catch((err: unknown) => { pushLog.warn('Push failed for cancelOrder', { err, buyerId }); });
        }

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ops/cancelOrder' } });
        next(err);
      }
    },
  };
}
