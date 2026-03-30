import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { idWhere } from '../utils/idWhere.js';
import { prisma } from '../database/prisma.js';
import { orderLog, businessLog, securityLog } from '../config/logger.js';
import { logChangeEvent, logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { adminUsersQuerySchema, adminFinancialsQuerySchema, adminProductsQuerySchema, adminAuditLogsQuerySchema, reactivateOrderSchema, updateUserStatusSchema } from '../validations/admin.js';
import { toUiOrderSummary, toUiUser, toUiRole, toUiDeal } from '../utils/uiMappers.js';
import { orderListSelectLite, getProofFlags, userAdminListSelect, dealListSelect } from '../utils/querySelect.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { writeAuditLog } from '../services/audit.js';
import { freezeOrders, reactivateOrder as reactivateOrderWorkflow } from '../services/orderWorkflow.js';
import { getAgencyCodeForMediatorCode, listMediatorCodesForAgency } from '../services/lineage.js';
import { updateSystemConfigSchema } from '../validations/systemConfig.js';
import type { Role } from '../middleware/auth.js';
import { publishRealtime } from '../services/realtimeHub.js';
import { pgUser, pgWallet, pgOrder, pgDeal } from '../utils/pgMappers.js';
import { authCacheInvalidate } from '../utils/authCache.js';

function db() { return prisma(); }

// In-memory cache for expensive admin stats (full-table aggregations)
let _statsCache: { data: any; at: number } | null = null;
let _statsPending: Promise<any> | null = null;
const STATS_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function roleToDb(role: string): string | null {
  const r = role.toLowerCase();
  if (r === 'all') return null;
  if (r === 'user') return 'shopper';
  if (r === 'mediator') return 'mediator';
  if (r === 'agency') return 'agency';
  if (r === 'brand') return 'brand';
  if (r === 'admin') return 'admin';
  return null;
}

export function makeAdminController() {
  return {
    getSystemConfig: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const doc = await db().systemConfig.findFirst({ where: { key: 'system' } });
        res.json({
          adminContactEmail: doc?.adminContactEmail ?? 'admin@buzzma.world',
        });
        businessLog.info('System config viewed', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'SystemConfig',
          requestId: String((res as any).locals?.requestId || ''),
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/getSystemConfig' } });
        next(err);
      }
    },

    updateSystemConfig: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = updateSystemConfigSchema.parse(req.body);
        const update: any = {};
        if (typeof body.adminContactEmail !== 'undefined') update.adminContactEmail = body.adminContactEmail;

        const doc = await db().systemConfig.upsert({
          where: { key: 'system' },
          create: { key: 'system', ...update },
          update,
        });

        await writeAuditLog({
          req,
          action: 'SYSTEM_CONFIG_UPDATED',
          entityType: 'SystemConfig',
          entityId: 'system',
          metadata: { updatedFields: Object.keys(update) },
        });
        securityLog.info('System config updated', { updatedFields: Object.keys(update), actorUserId: req.auth?.userId });
        businessLog.info('System config updated', { updatedFields: Object.keys(update), updatedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'SystemConfig', entityId: 'system', action: 'CONFIG_UPDATED', changedFields: Object.keys(update), before: {}, after: update });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles as string[],
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          resource: 'SystemConfig',
          requestId: String(res.locals.requestId || ''),
          metadata: { action: 'CONFIG_UPDATED', updatedFields: Object.keys(update) },
        });

        res.json({ adminContactEmail: doc?.adminContactEmail ?? body.adminContactEmail ?? 'admin@buzzma.world' });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/updateSystemConfig' } });
        next(err);
      }
    },
    getUsers: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const queryParams = adminUsersQuerySchema.parse(req.query);
        const dbRole = roleToDb(queryParams.role);
        if (dbRole === null && queryParams.role !== 'all') {
          throw new AppError(400, 'INVALID_ROLE', 'Invalid role filter');
        }

        const where: any = { isDeleted: false };
        if (dbRole) where.roles = { has: dbRole as any };
        if (queryParams.status && queryParams.status !== 'all') {
          where.status = queryParams.status;
        }
        if (queryParams.search) {
          where.OR = [
            { name: { contains: queryParams.search, mode: 'insensitive' } },
            { mobile: { contains: queryParams.search, mode: 'insensitive' } },
            { email: { contains: queryParams.search, mode: 'insensitive' } },
            { mediatorCode: { contains: queryParams.search, mode: 'insensitive' } },
          ];
        }

        const { page, limit, skip, isPaginated } = parsePagination(req.query as any, { limit: 50, maxLimit: 200 });
        const [users, total] = await Promise.all([
          db().user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: { ...userAdminListSelect, wallets: { where: { isDeleted: false }, take: 1, select: { id: true, availablePaise: true, pendingPaise: true } } },
          }),
          db().user.count({ where }),
        ]);
        const mapped = users.map(u => {
          const wallet = (u as any).wallets?.[0];
          return toUiUser(pgUser(u), wallet ? pgWallet(wallet) : undefined);
        });
        businessLog.info('Users listed', { userId: req.auth?.userId, resultCount: mapped.length, total, page, limit, roleFilter: queryParams.role, ip: req.ip });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Users',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { resultCount: mapped.length, total, page, limit, roleFilter: queryParams.role },
        });
        res.json(paginatedResponse(mapped, total, page, limit, isPaginated));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/getUsers' } });
        next(err);
      }
    },

    getFinancials: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const queryParams = adminFinancialsQuerySchema.parse(req.query);
        const where: any = { isDeleted: false };
        if (queryParams.status && queryParams.status !== 'all') {
          where.affiliateStatus = queryParams.status;
        }

        const { page, limit, skip, isPaginated } = parsePagination(req.query as any, { limit: 50, maxLimit: 200 });
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
        const mapped = orders.map(o => {
          try {
            const flags = proofFlags.get(o.id);
            const pg = pgOrder(o);
            // Inject proof flags from raw SQL instead of base64 columns
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
          catch (e) { orderLog.error(`[admin/getFinancials] toUiOrderSummary failed for ${o.id}`, { error: e }); return null; }
        }).filter(Boolean);
        businessLog.info('Financials listed', { userId: req.auth?.userId, resultCount: mapped.length, total, page, limit, ip: req.ip });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Financials',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { resultCount: mapped.length, total, page, limit },
        });
        res.json(paginatedResponse(mapped as any[], total, page, limit, isPaginated));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/getFinancials' } });
        next(err);
      }
    },

    getStats: async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Serve from cache if fresh (avoids expensive full-table scans)
        if (_statsCache && Date.now() - _statsCache.at < STATS_CACHE_TTL_MS) {
          res.json(_statsCache.data);
          return;
        }

        // Coalesce concurrent requests to prevent thundering herd
        if (_statsPending) {
          const data = await _statsPending;
          res.json(data);
          return;
        }

        const fetchStats = async () => {
        const [roleCounts, orderStats] = await Promise.all([
          db().$queryRaw<Array<{ role: string; count: number }>>`
            SELECT r AS role, COUNT(*)::int AS count
            FROM "users", UNNEST(roles) AS r
            WHERE "is_deleted" = false
            GROUP BY r`,
          db().$queryRaw<Array<{ total_orders: number; total_revenue_paise: number; pending_revenue_paise: number; risk_orders: number }>>`
            SELECT
              COUNT(*)::int AS total_orders,
              COALESCE(SUM("total_paise"), 0)::int AS total_revenue_paise,
              COALESCE(SUM(CASE WHEN "affiliate_status"::text = 'Pending_Cooling' THEN "total_paise" ELSE 0 END), 0)::int AS pending_revenue_paise,
              COALESCE(SUM(CASE WHEN "affiliate_status"::text = 'Unchecked' THEN 1 ELSE 0 END), 0)::int AS risk_orders
            FROM "orders"
            WHERE "is_deleted" = false`,
        ]);

        const counts: any = { total: 0, user: 0, mediator: 0, agency: 0, brand: 0 };
        for (const rc of roleCounts) {
          const ui = toUiRole(String(rc.role));
          if (counts[ui] !== undefined) counts[ui] += Number(rc.count);
          counts.total += Number(rc.count);
        }

        const os = orderStats[0] || { total_orders: 0, total_revenue_paise: 0, pending_revenue_paise: 0, risk_orders: 0 };

        const statsResult = {
          totalRevenue: Math.round(Number(os.total_revenue_paise) / 100),
          pendingRevenue: Math.round(Number(os.pending_revenue_paise) / 100),
          totalOrders: Number(os.total_orders),
          riskOrders: Number(os.risk_orders),
          counts,
        };
        _statsCache = { data: statsResult, at: Date.now() };
        return statsResult;
        };

        _statsPending = fetchStats();
        let statsResult: any;
        try {
          statsResult = await _statsPending;
        } finally {
          _statsPending = null;
        }

        res.json(statsResult);
        businessLog.info('Platform stats viewed', { userId: req.auth?.userId, totalOrders: statsResult.totalOrders, riskOrders: statsResult.riskOrders, ip: req.ip });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Stats',
          requestId: String((res as any).locals?.requestId || ''),
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/getStats' } });
        next(err);
      }
    },

    getGrowth: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const since = new Date();
        since.setDate(since.getDate() - 6);
        since.setHours(0, 0, 0, 0);

        const pipeline = await db().$queryRaw<Array<{ date: string; revenue: number }>>`
          SELECT TO_CHAR("created_at", 'YYYY-MM-DD') AS date,
                 COALESCE(SUM("total_paise"), 0)::int AS revenue
          FROM "orders"
          WHERE "created_at" >= ${since} AND "is_deleted" = false
          GROUP BY TO_CHAR("created_at", 'YYYY-MM-DD')`;

        const revenueByDate = new Map(pipeline.map(b => [b.date, Math.round(Number(b.revenue) / 100)]));

        const data: Array<{ date: string; revenue: number }> = [];
        for (let i = 0; i < 7; i += 1) {
          const d = new Date(since);
          d.setDate(since.getDate() + i);
          const key = d.toISOString().slice(0, 10);
          data.push({ date: key, revenue: revenueByDate.get(key) || 0 });
        }

        res.json(data);
        businessLog.info('Growth data viewed', { userId: req.auth?.userId, days: 7, ip: req.ip });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Growth',
          requestId: String((res as any).locals?.requestId || ''),
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/getGrowth' } });
        next(err);
      }
    },

    getProducts: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const queryParams = adminProductsQuerySchema.parse(req.query);
        const where: any = { isDeleted: false };
        if (queryParams.active && queryParams.active !== 'all') {
          where.active = queryParams.active === 'true';
        }
        if (queryParams.search) {
          where.OR = [
            { title: { contains: queryParams.search, mode: 'insensitive' } },
            { mediatorCode: { contains: queryParams.search, mode: 'insensitive' } },
            { platform: { contains: queryParams.search, mode: 'insensitive' } },
          ];
        }

        const { page, limit, skip, isPaginated } = parsePagination(req.query as any, { limit: 50, maxLimit: 200 });
        const [deals, total] = await Promise.all([
          db().deal.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: { ...dealListSelect, campaign: { select: { totalSlots: true, usedSlots: true, createdAt: true } } },
          }),
          db().deal.count({ where }),
        ]);

        // Compute selling speed: usedSlots / days since campaign creation
        const enrichedDeals = deals.map((d: any) => {
          const campaign = d.campaign;
          const totalSlots = campaign?.totalSlots || 0;
          const usedSlots = campaign?.usedSlots || 0;
          const remainingSlots = Math.max(0, totalSlots - usedSlots);
          let sellingSpeed = 0;
          if (campaign?.createdAt && usedSlots > 0) {
            const daysSinceCreation = Math.max(1, (Date.now() - new Date(campaign.createdAt).getTime()) / (1000 * 60 * 60 * 24));
            sellingSpeed = Math.round((usedSlots / daysSinceCreation) * 10) / 10; // slots per day
          }
          const { campaign: _c, ...rest } = d;
          return { ...rest, totalSlots, usedSlots, remainingSlots, sellingSpeed };
        });
        businessLog.info('Products listed', { userId: req.auth?.userId, resultCount: deals.length, total, page, limit, ip: req.ip });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Products',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { resultCount: deals.length, total, page, limit },
        });
        res.json(paginatedResponse(enrichedDeals.map((d: any) => toUiDeal(pgDeal(d))), total, page, limit, isPaginated));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/getProducts' } });
        next(err);
      }
    },

    deleteDeal: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dealId = String(req.params.dealId || '').trim();
        if (!dealId) throw new AppError(400, 'INVALID_DEAL_ID', 'dealId required');

        const deal = await db().deal.findFirst({ where: { ...idWhere(dealId), isDeleted: false }, select: { id: true, mongoId: true, mediatorCode: true, title: true } });
        if (!deal) throw new AppError(404, 'DEAL_NOT_FOUND', 'Deal not found');

        // Check for orders referencing this deal via order items
        const hasOrders = await db().orderItem.findFirst({
          where: { productId: dealId, isDeleted: false, order: { isDeleted: false } },
          select: { id: true },
        });
        if (hasOrders) throw new AppError(409, 'DEAL_HAS_ORDERS', 'Cannot delete a deal with orders');

        const pgUserId = (req.auth as any)?.pgUserId as string | undefined;
        await db().deal.update({
          where: { id: deal.id },
          data: { isDeleted: true, updatedBy: pgUserId, active: false },
        });

        await writeAuditLog({
          req,
          action: 'DEAL_DELETED',
          entityType: 'Deal',
          entityId: deal.mongoId!,
          metadata: { mediatorCode: deal.mediatorCode },
        });
        businessLog.info('Deal deleted by admin', { dealId: deal.mongoId, mediatorCode: deal.mediatorCode, title: deal.title });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Deal', entityId: deal.mongoId!, action: 'DEAL_DELETED', changedFields: ['isDeleted', 'active'], before: { active: true }, after: { active: false, isDeleted: new Date().toISOString() } });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles as string[],
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          resource: `Deal#${deal.mongoId}`,
          requestId: String(res.locals.requestId || ''),
          metadata: { action: 'DEAL_DELETED', mediatorCode: deal.mediatorCode },
        });

        const mediatorCode = String(deal.mediatorCode || '').trim();
        publishRealtime({
          type: 'deals.changed',
          ts: new Date().toISOString(),
          payload: { dealId: deal.mongoId! },
          audience: {
            roles: ['admin', 'ops'],
            ...(mediatorCode ? { mediatorCodes: [mediatorCode] } : {}),
          },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/deleteDeal' } });
        next(err);
      }
    },

    deleteUser: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = String(req.params.userId || '').trim();
        if (!userId) throw new AppError(400, 'INVALID_USER_ID', 'userId required');

        const user = await db().user.findFirst({ where: { ...idWhere(userId), isDeleted: false }, select: { id: true, mongoId: true, roles: true, mediatorCode: true, status: true, name: true } });
        if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

        const roles = Array.isArray(user.roles) ? (user.roles as string[]) : [];
        if (roles.includes('admin') || roles.includes('ops')) {
          throw new AppError(403, 'FORBIDDEN', 'This user cannot be deleted due to their account permissions.');
        }

        const mediatorCode = String(user.mediatorCode || '').trim();

        // Build order OR conditions
        const orderOr: any[] = [{ userId: user.id }, { brandUserId: user.id }, { createdBy: user.id }];
        if (mediatorCode && roles.includes('mediator')) {
          orderOr.push({ managerName: mediatorCode });
        }
        if (mediatorCode && roles.includes('agency')) {
          const mediatorCodes = await listMediatorCodesForAgency(mediatorCode);
          if (mediatorCodes.length) orderOr.push({ managerName: { in: mediatorCodes } });
        }

        // Parallelize all safety-check queries for performance
        const [hasCampaigns, hasDeals, hasOrders, hasPendingPayout, wallet] = await Promise.all([
          db().campaign.findFirst({ where: { brandUserId: user.id, isDeleted: false }, select: { id: true } }),
          mediatorCode ? db().deal.findFirst({ where: { mediatorCode, isDeleted: false }, select: { id: true } }) : null,
          db().order.findFirst({ where: { isDeleted: false, OR: orderOr }, select: { id: true } }),
          db().payout.findFirst({
            where: { beneficiaryUserId: user.id, status: { in: ['requested', 'processing'] as any }, isDeleted: false },
            select: { id: true },
          }),
          db().wallet.findFirst({ where: { ownerUserId: user.id, isDeleted: false }, select: { id: true, availablePaise: true, pendingPaise: true, lockedPaise: true } }),
        ]);

        if (hasCampaigns) throw new AppError(409, 'USER_HAS_CAMPAIGNS', 'This user has active campaigns. Please remove them first before deleting.');
        if (hasDeals) throw new AppError(409, 'USER_HAS_DEALS', 'This user has active deals. Please remove them first before deleting.');
        if (hasOrders) throw new AppError(409, 'USER_HAS_ORDERS', 'This user has orders in the system. They cannot be deleted at this time.');
        if (hasPendingPayout) throw new AppError(409, 'USER_HAS_PAYOUTS', 'This user has pending payouts. Please complete them first before deleting.');
        const available = Number(wallet?.availablePaise ?? 0);
        const pending = Number(wallet?.pendingPaise ?? 0);
        const locked = Number(wallet?.lockedPaise ?? 0);
        if (available > 0 || pending > 0 || locked > 0) {
          throw new AppError(409, 'WALLET_NOT_EMPTY', 'This user still has funds in their wallet. Please settle the balance before deleting.');
        }

        const pgUserId = (req.auth as any)?.pgUserId as string | undefined;
        if (wallet) {
          await db().wallet.update({
            where: { id: wallet.id },
            data: { isDeleted: true, updatedBy: pgUserId},
          });
        }

        await db().user.update({
          where: { id: user.id },
          data: { isDeleted: true, updatedBy: pgUserId},
        });

        await writeAuditLog({
          req,
          action: 'USER_DELETED',
          entityType: 'User',
          entityId: user.mongoId!,
          metadata: { role: roles.join(','), mediatorCode },
        });
        securityLog.info('User deleted by admin', { userId: user.mongoId, roles: roles.join(','), mediatorCode });
        businessLog.info('User deleted by admin', { userId: user.mongoId, targetRole: roles.join(','), mediatorCode, updatedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'User', entityId: user.mongoId!, action: 'USER_DELETED', changedFields: ['isDeleted'], before: { status: user.status }, after: { isDeleted: new Date().toISOString() } });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles as string[],
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          resource: `User#${user.mongoId}`,
          requestId: String(res.locals.requestId || ''),
          metadata: { action: 'USER_DELETED', targetRoles: roles, mediatorCode },
        });

        publishRealtime({
          type: 'users.changed',
          ts: new Date().toISOString(),
          payload: { userId: user.mongoId! },
          audience: { roles: ['admin'] },
        });
        publishRealtime({
          type: 'wallets.changed',
          ts: new Date().toISOString(),
          audience: { roles: ['admin'], userIds: [user.mongoId!] },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/deleteUser' } });
        next(err);
      }
    },

    deleteWallet: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = String(req.params.userId || '').trim();
        if (!userId) throw new AppError(400, 'INVALID_USER_ID', 'userId required');

        // Resolve PG UUID for the user
        const user = await db().user.findFirst({ where: { ...idWhere(userId), isDeleted: false }, select: { id: true, mongoId: true } });
        if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

        // Wallet + payout checks are independent — run in parallel
        const [wallet, hasPendingPayout] = await Promise.all([
          db().wallet.findFirst({ where: { ownerUserId: user.id, isDeleted: false }, select: { id: true, mongoId: true, availablePaise: true, pendingPaise: true, lockedPaise: true } }),
          db().payout.findFirst({
            where: { beneficiaryUserId: user.id, status: { in: ['requested', 'processing'] as any }, isDeleted: false },
            select: { id: true },
          }),
        ]);
        if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');

        const available = Number(wallet.availablePaise ?? 0);
        const pending = Number(wallet.pendingPaise ?? 0);
        const locked = Number(wallet.lockedPaise ?? 0);
        if (available > 0 || pending > 0 || locked > 0) {
          throw new AppError(409, 'WALLET_NOT_EMPTY', 'Wallet has funds; cannot delete');
        }
        if (hasPendingPayout) {
          throw new AppError(409, 'PAYOUT_PENDING', 'User has pending payouts; cannot delete wallet');
        }

        const pgUserId = (req.auth as any)?.pgUserId as string | undefined;
        await db().wallet.update({
          where: { id: wallet.id },
          data: { isDeleted: true, updatedBy: pgUserId},
        });

        await writeAuditLog({
          req,
          action: 'WALLET_DELETED',
          entityType: 'Wallet',
          entityId: wallet.mongoId || wallet.id,
          metadata: { ownerUserId: userId },
        });
        businessLog.info('Wallet deleted by admin', { walletId: wallet.mongoId || wallet.id, ownerUserId: userId });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Wallet', entityId: wallet.mongoId || wallet.id, action: 'WALLET_DELETED', changedFields: ['isDeleted'], before: { isDeleted: false }, after: { isDeleted: new Date().toISOString() } });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles as string[],
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          resource: `Wallet#${wallet.mongoId || wallet.id}`,
          requestId: String(res.locals.requestId || ''),
          metadata: { action: 'WALLET_DELETED', ownerUserId: userId },
        });

        publishRealtime({
          type: 'wallets.changed',
          ts: new Date().toISOString(),
          audience: { roles: ['admin'], userIds: [userId] },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/deleteWallet' } });
        next(err);
      }
    },

    updateUserStatus: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = updateUserStatusSchema.parse(req.body);

        // Guard: prevent admin from suspending themselves (could cause unrecoverable lockout).
        // body.userId may be a mongoId while auth.userId is PG UUID — check both.
        const selfCheck = String(body.userId);
        const isSelfSuspend = (selfCheck === String(req.auth?.userId) || selfCheck === String(req.auth?.pgUserId) || selfCheck === String((req.auth as any)?.mongoId ?? ''));
        if (isSelfSuspend && body.status === 'suspended') {
          throw new AppError(400, 'CANNOT_SELF_SUSPEND', 'Cannot suspend your own account');
        }

        const before = await db().user.findFirst({ where: { ...idWhere(body.userId), isDeleted: false }, select: { id: true, mongoId: true, status: true, roles: true, isDeleted: true, name: true, mediatorCode: true } });
        if (!before) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
        if (before.isDeleted) throw new AppError(409, 'USER_DELETED', 'Cannot update status of a deleted user');

        const user = await db().user.update({
          where: { id: before.id },
          data: { status: body.status as any },
        });

        const statusChanged = before.status !== user.status;

        // Immediately evict auth cache so suspended users can't act on stale tokens
        if (statusChanged) {
          authCacheInvalidate(before.mongoId!);
          authCacheInvalidate(before.id);
        }
        const adminMongoId = req.auth?.userId;
        const adminPgId = (req.auth as any)?.pgUserId as string | undefined;

        if (adminMongoId && statusChanged) {
          if (user.status === 'suspended') {
            // Wrap suspension + all cascades in a single transaction for atomicity
            await db().$transaction(async (tx: any) => {
              await tx.suspension.create({
                data: {
                  mongoId: randomUUID(),
                  targetUserId: user.id,
                  action: 'suspend' as any,
                  reason: body.reason,
                  adminUserId: adminPgId!,
                },
              });

              // Freeze active workflows immediately; do NOT auto-resume after unsuspension.
              const roles = Array.isArray(user.roles) ? (user.roles as string[]) : [];
              const mediatorCode = String(user.mediatorCode || '').trim();

              if (roles.includes('shopper')) {
                await freezeOrders({ query: { userId: user.id }, reason: 'USER_SUSPENDED', actorUserId: adminPgId, tx });
              }

              if (roles.includes('mediator') && mediatorCode) {
                await tx.deal.updateMany({ where: { mediatorCode, isDeleted: false }, data: { active: false } });
                await freezeOrders({ query: { managerName: mediatorCode }, reason: 'MEDIATOR_SUSPENDED', actorUserId: adminPgId, tx });
              }

              if (roles.includes('agency') && mediatorCode) {
                const mediatorCodes = await listMediatorCodesForAgency(mediatorCode);
                if (mediatorCodes.length) {
                  await tx.deal.updateMany({ where: { mediatorCode: { in: mediatorCodes }, isDeleted: false }, data: { active: false } });
                  await freezeOrders({ query: { managerName: { in: mediatorCodes } }, reason: 'AGENCY_SUSPENDED', actorUserId: adminPgId, tx });
                }
              }

              if (roles.includes('brand')) {
                await tx.campaign.updateMany({
                  where: { brandUserId: user.id, isDeleted: false, status: { in: ['active', 'draft'] as any } },
                  data: { status: 'paused' as any },
                });
                await freezeOrders({ query: { brandUserId: user.id }, reason: 'BRAND_SUSPENDED', actorUserId: adminPgId, tx });
              }
            }, { timeout: 15000 });

            // Audit logs + realtime events (non-transactional, fire-and-forget)
            const roles = Array.isArray(user.roles) ? (user.roles as string[]) : [];
            const mediatorCode = String(user.mediatorCode || '').trim();

            if (roles.includes('shopper')) {
              writeAuditLog({ req, action: 'ORDERS_FROZEN_CASCADE', entityType: 'User', entityId: user.mongoId!, metadata: { reason: 'USER_SUSPENDED', role: 'shopper' } }).catch(() => { });
            }
            if (roles.includes('mediator') && mediatorCode) {
              writeAuditLog({ req, action: 'DEALS_DEACTIVATED_CASCADE', entityType: 'User', entityId: user.mongoId!, metadata: { reason: 'MEDIATOR_SUSPENDED', mediatorCode } }).catch(() => { });
              writeAuditLog({ req, action: 'ORDERS_FROZEN_CASCADE', entityType: 'User', entityId: user.mongoId!, metadata: { reason: 'MEDIATOR_SUSPENDED', mediatorCode } }).catch(() => { });
              const agencyCode = (await getAgencyCodeForMediatorCode(mediatorCode)) || '';
              publishRealtime({
                type: 'deals.changed',
                ts: new Date().toISOString(),
                payload: { mediatorCode },
                audience: {
                  roles: ['admin', 'ops'],
                  mediatorCodes: [mediatorCode],
                  parentCodes: [mediatorCode],
                  ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
                },
              });
            }
            if (roles.includes('agency') && mediatorCode) {
              const mediatorCodes = await listMediatorCodesForAgency(mediatorCode);
              if (mediatorCodes.length) {
                writeAuditLog({ req, action: 'DEALS_DEACTIVATED_CASCADE', entityType: 'User', entityId: user.mongoId!, metadata: { reason: 'AGENCY_SUSPENDED', agencyCode: mediatorCode, mediatorCount: mediatorCodes.length } }).catch(() => { });
                writeAuditLog({ req, action: 'ORDERS_FROZEN_CASCADE', entityType: 'User', entityId: user.mongoId!, metadata: { reason: 'AGENCY_SUSPENDED', agencyCode: mediatorCode, mediatorCount: mediatorCodes.length } }).catch(() => { });
                publishRealtime({
                  type: 'deals.changed',
                  ts: new Date().toISOString(),
                  payload: { agencyCode: mediatorCode, mediatorCodes },
                  audience: {
                    roles: ['admin', 'ops'],
                    agencyCodes: [mediatorCode],
                    mediatorCodes,
                    parentCodes: mediatorCodes,
                  },
                });
              }
            }
            if (roles.includes('brand')) {
              writeAuditLog({ req, action: 'CAMPAIGNS_PAUSED_CASCADE', entityType: 'User', entityId: user.mongoId!, metadata: { reason: 'BRAND_SUSPENDED' } }).catch(() => { });
              writeAuditLog({ req, action: 'ORDERS_FROZEN_CASCADE', entityType: 'User', entityId: user.mongoId!, metadata: { reason: 'BRAND_SUSPENDED' } }).catch(() => { });
            }
          }

          if (before.status === 'suspended' && user.status === 'active') {
            await db().suspension.create({
              data: {
                mongoId: randomUUID(),
                targetUserId: user.id,
                action: 'unsuspend' as any,
                reason: body.reason,
                adminUserId: adminPgId!,
              },
            });
            // No auto-unfreeze here by design.
          }
        }

        await writeAuditLog({
          req,
          action: 'USER_STATUS_UPDATED',
          entityType: 'User',
          entityId: user.mongoId!,
          metadata: { from: before.status, to: user.status, reason: body.reason },
        });
        securityLog.info('User status updated by admin', { userId: user.mongoId, from: before.status, to: user.status, reason: body.reason });
        businessLog.info('User status updated', { userId: user.mongoId, from: before.status, to: user.status, reason: body.reason, updatedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'User', entityId: user.mongoId!, action: 'STATUS_UPDATED', changedFields: ['status'], before: { status: before.status }, after: { status: user.status, reason: body.reason } });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles as string[],
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          resource: `User#${user.mongoId}`,
          requestId: String(res.locals.requestId || ''),
          metadata: { action: 'STATUS_UPDATED', from: before.status, to: user.status, reason: body.reason },
        });

        if (statusChanged) {
          publishRealtime({
            type: 'users.changed',
            ts: new Date().toISOString(),
            payload: { userId: user.mongoId!, status: user.status },
            audience: { roles: ['admin', 'ops'], userIds: [user.mongoId!] },
          });
          const privilegedRoles: Role[] = ['admin', 'ops'];
          const audience = { roles: privilegedRoles, userIds: [user.mongoId!] };
          publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });
        }
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/updateUserStatus' } });
        next(err);
      }
    },

    reactivateOrder: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = reactivateOrderSchema.parse(req.body);
        const adminPgId = (req.auth as any)?.pgUserId as string;
        if (!adminPgId) throw new AppError(401, 'UNAUTHENTICATED', 'Missing auth context');

        const order = await reactivateOrderWorkflow({ orderId: body.orderId, actorUserId: adminPgId, reason: body.reason });

        await writeAuditLog({
          req,
          action: 'ORDER_REACTIVATED',
          entityType: 'Order',
          entityId: (order as any).mongoId || body.orderId,
          metadata: { reason: body.reason },
        });
        orderLog.info('Order reactivated by admin', { orderId: (order as any).mongoId || body.orderId, reason: body.reason });
        businessLog.info('Order reactivated by admin', { orderId: (order as any).mongoId || body.orderId, reason: body.reason, reactivatedBy: req.auth?.userId, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Order', entityId: (order as any).mongoId || body.orderId, action: 'ORDER_REACTIVATED', changedFields: ['frozen', 'workflowStatus'], before: { frozen: true }, after: { frozen: false, reason: body.reason } });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles as string[],
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          resource: `Order#${(order as any).mongoId || body.orderId}`,
          requestId: String(res.locals.requestId || ''),
          metadata: { action: 'ORDER_REACTIVATED', reason: body.reason },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/reactivateOrder' } });
        next(err);
      }
    },

    getAuditLogs: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          action,
          entityType,
          entityId,
          actorUserId,
          from,
          to,
          page: parsedPage,
          limit: parsedLimit,
        } = adminAuditLogsQuerySchema.parse(req.query);

        const page = Math.max(1, parsedPage ?? 1);
        const limit = Math.min(500, Math.max(1, parsedLimit ?? 200));
        const skip = (page - 1) * limit;

        const where: any = {};
        if (action && typeof action === 'string') where.action = action;
        if (entityType && typeof entityType === 'string') where.entityType = entityType;
        if (entityId && typeof entityId === 'string') where.entityId = entityId;
        if (actorUserId && typeof actorUserId === 'string') {
          // Support both mongoId and UUID for actorUserId filter
          const isUuid = /^[0-9a-f]{8}-/.test(actorUserId);
          if (isUuid) {
            where.actorUserId = actorUserId;
          } else {
            const actor = await db().user.findFirst({ where: { ...idWhere(actorUserId) }, select: { id: true } });
            if (actor) where.actorUserId = actor.id;
            else where.actorUserId = actorUserId; // fallback
          }
        }

        if (from || to) {
          where.createdAt = {};
          if (from) {
            const d = new Date(from);
            if (!isNaN(d.getTime())) where.createdAt.gte = d;
          }
          if (to) {
            const d = new Date(to);
            if (!isNaN(d.getTime())) where.createdAt.lte = d;
          }
          if (Object.keys(where.createdAt).length === 0) delete where.createdAt;
        }

        const [logs, total] = await Promise.all([
          db().auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, select: { id: true, mongoId: true, actorUserId: true, actorRoles: true, action: true, entityType: true, entityId: true, ip: true, metadata: true, createdAt: true } }),
          db().auditLog.count({ where }),
        ]);

        res.json(paginatedResponse(logs, total, page, limit, true));
        businessLog.info('Audit logs viewed', { userId: req.auth?.userId, resultCount: logs.length, total, page, limit, ip: req.ip });
        logAccessEvent('ADMIN_ACTION', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'AuditLogs',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { resultCount: logs.length, total, page, limit },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'admin/getAuditLogs' } });
        next(err);
      }
    },
  };
}
