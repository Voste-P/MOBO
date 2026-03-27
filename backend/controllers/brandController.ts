import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { idWhere } from '../utils/idWhere.js';
import type { Role } from '../middleware/auth.js';
import { orderLog, businessLog, walletLog } from '../config/logger.js';
import { logChangeEvent, logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { prisma } from '../database/prisma.js';
import { rupeesToPaise } from '../utils/money.js';
import { toUiCampaign, toUiOrderSummary, toUiOrderSummaryForBrand, toUiUser } from '../utils/uiMappers.js';
import { orderListSelectLite, getProofFlags, userListSelect, campaignListSelect, transactionListSelect } from '../utils/querySelect.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { pgUser, pgOrder, pgCampaign } from '../utils/pgMappers.js';
import { getRequester, isPrivileged } from '../services/authz.js';
import { writeAuditLog } from '../services/audit.js';
import { removeBrandConnectionSchema, resolveBrandConnectionSchema } from '../validations/connections.js';
import { payoutAgencySchema, createBrandCampaignSchema, updateBrandCampaignSchema, brandCampaignsQuerySchema, brandOrdersQuerySchema, brandTransactionsQuerySchema } from '../validations/brand.js';
import { copyCampaignSchema } from '../validations/ops.js';
import { ensureWallet, applyWalletCredit, applyWalletDebit } from '../services/walletService.js';
import { publishRealtime } from '../services/realtimeHub.js';

function db() { return prisma(); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function recordManualPayoutLedger(args: {
  idempotencyKey: string;
  brandPgId: string;
  agencyPgId: string;
  amountPaise: number;
  ref: string;
  agencyCode: string;
  agencyName: string;
  brandName: string;
  brandMongoId: string;
  agencyMongoId: string;
}) {
  // Create an immutable ledger record even when wallets are not funded.
  // Uses upsert for atomic idempotency (no TOCTOU race).
  await db().transaction.upsert({
    where: { idempotencyKey: args.idempotencyKey },
    update: {},
    create: {
      mongoId: randomUUID(),
      idempotencyKey: args.idempotencyKey,
      type: 'agency_payout' as any,
      status: 'completed' as any,
      amountPaise: args.amountPaise,
      currency: 'INR',
      fromUserId: args.brandPgId,
      toUserId: args.agencyPgId,
      metadata: {
        ref: args.ref,
        agencyId: args.agencyMongoId,
        agencyCode: args.agencyCode,
        agencyName: args.agencyName,
        brandId: args.brandMongoId,
        brandName: args.brandName,
        mode: 'manual',
      },
    },
  });

  const creditKey = `${args.idempotencyKey}:credit`;
  await db().transaction.upsert({
    where: { idempotencyKey: creditKey },
    update: {},
    create: {
      mongoId: randomUUID(),
      idempotencyKey: creditKey,
      type: 'agency_receipt' as any,
      status: 'completed' as any,
      amountPaise: args.amountPaise,
      currency: 'INR',
      fromUserId: args.brandPgId,
      toUserId: args.agencyPgId,
      metadata: {
        ref: args.ref,
        agencyId: args.agencyMongoId,
        agencyCode: args.agencyCode,
        agencyName: args.agencyName,
        brandId: args.brandMongoId,
        brandName: args.brandName,
        mode: 'manual',
      },
    },
  });
}

export function makeBrandController() {
  return {
    getAgencies: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, userId: _userId, user: _user } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        const where: any = { roles: { has: 'agency' as any }, isDeleted: false };
        if (!isPrivileged(roles)) {
          // Re-fetch brand user from DB to get connectedAgencies (not in auth user)
          const brandUser = await db().user.findFirst({ where: { id: pgUserId, isDeleted: false }, select: { connectedAgencies: true } });
          const connected = Array.isArray((brandUser as any)?.connectedAgencies)
            ? (brandUser as any).connectedAgencies as string[]
            : [];
          where.mediatorCode = { in: connected };
        }

        const { page, limit, skip, isPaginated } = parsePagination(req.query as any, { limit: 50, maxLimit: 200 });
        const [agencies, total] = await Promise.all([
          db().user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, select: userListSelect }),
          db().user.count({ where }),
        ]);
        res.json(paginatedResponse(agencies.map((a: any) => toUiUser(pgUser(a), null)), total, page, limit, isPaginated));

        businessLog.info('Agencies listed', { userId: req.auth?.userId, resultCount: agencies.length, total, page, limit, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Agency',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'AGENCIES_LISTED', endpoint: 'getAgencies', resultCount: agencies.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/getAgencies' } });
        next(err);
      }
    },

    getCampaigns: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = brandCampaignsQuerySchema.parse(req.query);
        const { roles, userId: _userId } = getRequester(req);
        const requested = typeof q.brandId === 'string' ? q.brandId : '';

        let brandPgId: string;
        if (isPrivileged(roles) && requested) {
          const brandUser = await db().user.findFirst({ where: { ...idWhere(requested), isDeleted: false }, select: { id: true } });
          if (!brandUser) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
          brandPgId = brandUser.id;
        } else {
          brandPgId = (req.auth as any)?.pgUserId;
        }

        const { page, limit, skip, isPaginated } = parsePagination(q, { limit: 50, maxLimit: 200 });
        const [campaigns, total] = await Promise.all([
          db().campaign.findMany({
            where: { brandUserId: brandPgId, isDeleted: false },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: campaignListSelect,
          }),
          db().campaign.count({ where: { brandUserId: brandPgId, isDeleted: false } }),
        ]);
        res.json(paginatedResponse(campaigns.map((c: any) => toUiCampaign(pgCampaign(c))), total, page, limit, isPaginated));

        businessLog.info('Brand campaigns listed', { userId: req.auth?.userId, resultCount: campaigns.length, total, page, limit, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Campaign',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'CAMPAIGNS_LISTED', endpoint: 'brand/getCampaigns', resultCount: campaigns.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/getCampaigns' } });
        next(err);
      }
    },

    getOrders: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = brandOrdersQuerySchema.parse(req.query);
        const { roles, userId: _userId, user } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        const where: any = { isDeleted: false };
        if (isPrivileged(roles)) {
          const brandName = typeof q.brandName === 'string' ? q.brandName : '';
          if (brandName) where.brandName = brandName;
        } else {
          where.OR = [
            { brandUserId: pgUserId },
            { brandUserId: null, brandName: (user as any)?.name },
          ];
        }
        const { page, limit, skip, isPaginated } = parsePagination(q, { limit: 50, maxLimit: 200 });
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

        if (!isPrivileged(roles) && roles.includes('brand')) {
          const brandMapped = orders.map((o: any) => {
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
              return toUiOrderSummaryForBrand(pg);
            } catch (e) { orderLog.error(`[brand/getOrders] toUiOrderSummaryForBrand failed for ${o.id}`, { error: e }); return null; }
          }).filter(Boolean);
          res.json(paginatedResponse(brandMapped as any[], total, page, limit, isPaginated));

          businessLog.info('Brand orders listed', { userId: req.auth?.userId, resultCount: brandMapped.length, total, page, limit, ip: req.ip });
          logAccessEvent('RESOURCE_ACCESS', {
            userId: req.auth?.userId,
            roles: req.auth?.roles,
            ip: req.ip,
            resource: 'Order',
            requestId: String((res as any).locals?.requestId || ''),
            metadata: { action: 'ORDERS_LISTED', endpoint: 'brand/getOrders', resultCount: brandMapped.length },
          });
          return;
        }
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
          catch (e) { orderLog.error(`[brand/getOrders] toUiOrderSummary failed for ${o.id}`, { error: e }); return null; }
        }).filter(Boolean);
        res.json(paginatedResponse(mapped as any[], total, page, limit, isPaginated));

        businessLog.info('Orders listed (privileged)', { userId: req.auth?.userId, resultCount: mapped.length, total, page, limit, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Order',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'ORDERS_LISTED', endpoint: 'brand/getOrders', resultCount: mapped.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/getOrders' } });
        next(err);
      }
    },

    getTransactions: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = brandTransactionsQuerySchema.parse(req.query);
        const { roles, userId: _userId } = getRequester(req);
        const requested = typeof q.brandId === 'string' ? String(q.brandId) : '';

        let brandPgId: string;
        if (isPrivileged(roles) && requested) {
          const brandUser = await db().user.findFirst({ where: { ...idWhere(requested), isDeleted: false }, select: { id: true } });
          if (!brandUser) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
          brandPgId = brandUser.id;
        } else {
          brandPgId = (req.auth as any)?.pgUserId;
        }

        // Brand ledger = outbound agency payouts from this brand.
        const txWhere = { isDeleted: false, fromUserId: brandPgId, type: 'agency_payout' as any };
        const { page, limit, skip, isPaginated } = parsePagination(q, { limit: 50, maxLimit: 200 });
        const [txns, txTotal] = await Promise.all([
          db().transaction.findMany({
            where: txWhere,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: { ...transactionListSelect, metadata: true },
          }),
          db().transaction.count({ where: txWhere }),
        ]);

        const agencyPgIds = Array.from(
          new Set(txns.map((t: any) => String(t.toUserId || '')).filter(Boolean))
        );

        const agencies = agencyPgIds.length
          ? await db().user.findMany({
            where: { id: { in: agencyPgIds }, isDeleted: false },
            select: { id: true, mongoId: true, name: true, mediatorCode: true },
          })
          : [];
        const byId = new Map(agencies.map((a: any) => [a.id, a]));

        const txMapped = txns.map((t: any) => {
            const agency = t.toUserId ? byId.get(t.toUserId) : undefined;
            const meta = (t.metadata && typeof t.metadata === 'object') ? (t.metadata as any) : {};
            return {
              id: t.mongoId || t.id,
              date: (t.createdAt ?? new Date()).toISOString(),
              agencyName: String(meta.agencyName || agency?.name || 'Agency'),
              amount: Math.round(Number(t.amountPaise ?? 0) / 100),
              ref: String(meta.ref || ''),
              status: t.status === 'completed' ? 'Success' : String(t.status),
            };
        });
        res.json(paginatedResponse(txMapped, txTotal, page, limit, isPaginated));

        businessLog.info('Brand transactions listed', { userId: req.auth?.userId, resultCount: txMapped.length, total: txTotal, page, limit, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Transaction',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'TRANSACTIONS_LISTED', endpoint: 'brand/getTransactions', resultCount: txMapped.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/getTransactions' } });
        next(err);
      }
    },

    payoutAgency: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = payoutAgencySchema.parse(req.body);
        const { roles, userId: _userId, user: _user } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        // Resolve brand PG UUID
        let brandPgId: string;
        let brandMongoId: string;
        let brandUser: any;
        if (isPrivileged(roles) && body.brandId) {
          const brandWhere = UUID_RE.test(body.brandId)
            ? { OR: [{ id: body.brandId }, { mongoId: body.brandId }], isDeleted: false }
            : { mongoId: String(body.brandId), isDeleted: false };
          brandUser = await db().user.findFirst({ where: brandWhere as any, select: { id: true, mongoId: true, roles: true, status: true, connectedAgencies: true } });
          if (!brandUser) throw new AppError(404, 'NOT_FOUND', 'Brand not found');
          brandPgId = brandUser.id;
          brandMongoId = brandUser.mongoId || brandUser.id;
        } else {
          // Re-fetch full brand user from DB (auth middleware doesn't include connectedAgencies)
          brandUser = await db().user.findFirst({ where: { id: pgUserId, isDeleted: false }, select: { id: true, mongoId: true, roles: true, status: true, connectedAgencies: true } });
          if (!brandUser) throw new AppError(404, 'NOT_FOUND', 'Brand user not found');
          brandPgId = brandUser.id;
          brandMongoId = brandUser.mongoId || brandUser.id;
        }

        if (!isPrivileged(roles) && !(brandUser as any).roles?.includes('brand')) {
          throw new AppError(403, 'FORBIDDEN', 'Only brands can record payouts');
        }
        if (String((brandUser as any).status || '') !== 'active') {
          throw new AppError(409, 'BRAND_NOT_ACTIVE', 'Brand is not active');
        }

        // Resolve agency
        const agencyWhere = UUID_RE.test(body.agencyId)
          ? { OR: [{ id: body.agencyId }, { mongoId: body.agencyId }], isDeleted: false }
          : { mongoId: body.agencyId, isDeleted: false };
        const agency = await db().user.findFirst({
          where: agencyWhere as any,
          select: { id: true, mongoId: true, roles: true, mediatorCode: true, name: true, status: true },
        });
        if (!agency) throw new AppError(404, 'AGENCY_NOT_FOUND', 'Agency not found');
        if (!(agency.roles as string[])?.includes('agency')) throw new AppError(404, 'AGENCY_NOT_FOUND', 'Agency not found');
        if (String(agency.status || '') !== 'active') throw new AppError(409, 'AGENCY_NOT_ACTIVE', 'Agency is not active');

        const agencyCode = String(agency.mediatorCode || '').trim();
        if (!agencyCode) throw new AppError(409, 'AGENCY_MISSING_CODE', 'Agency is missing a code');
        const agencyPgId = agency.id;
        const agencyMongoId = agency.mongoId || agency.id;

        if (!isPrivileged(roles)) {
          const connected = Array.isArray((brandUser as any)?.connectedAgencies)
            ? ((brandUser as any).connectedAgencies as string[])
            : [];
          if (!connected.includes(agencyCode)) {
            throw new AppError(403, 'FORBIDDEN', 'Agency is not connected to this brand');
          }
        }

        const amountPaise = rupeesToPaise(Number(body.amount));
        const ref = String(body.ref).trim();

        // Ensure wallets exist (takes PG UUIDs).
        await Promise.all([ensureWallet(brandPgId), ensureWallet(agencyPgId)]);

        // Idempotent payout: double-click safe.
        const idKey = `brand_agency_payout:${brandMongoId}:${agencyMongoId}:${ref}`;

        const brandName = String((brandUser as any).name || 'Brand');
        const agencyName = String(agency.name || 'Agency');

        let payoutMode: 'wallet' | 'manual' = 'wallet';

        try {
          // Atomic payout: wrap debit + credit in a single Prisma transaction.
          await db().$transaction(async (tx: any) => {
            await applyWalletDebit({
              idempotencyKey: idKey,
              type: 'agency_payout',
              ownerUserId: brandPgId,
              fromUserId: brandPgId,
              toUserId: agencyPgId,
              amountPaise,
              metadata: { ref, agencyId: agencyMongoId, agencyCode, agencyName },
              tx,
            });

            await applyWalletCredit({
              idempotencyKey: `${idKey}:credit`,
              type: 'agency_receipt',
              ownerUserId: agencyPgId,
              fromUserId: brandPgId,
              toUserId: agencyPgId,
              amountPaise,
              metadata: { ref, brandId: brandMongoId, brandName },
              tx,
            });
          }, { timeout: 15000 });
        } catch (e: any) {
          const code = String(e?.code || e?.error?.code || '');
          if (code !== 'INSUFFICIENT_FUNDS' && code !== 'WALLET_NOT_FOUND') throw e;
          await recordManualPayoutLedger({
            idempotencyKey: idKey,
            brandPgId,
            agencyPgId,
            amountPaise,
            ref,
            agencyCode,
            agencyName,
            brandName,
            brandMongoId,
            agencyMongoId,
          });
          payoutMode = 'manual';
        }

        await writeAuditLog({
          req,
          action: 'BRAND_AGENCY_PAYOUT_RECORDED',
          entityType: 'User',
          entityId: brandMongoId,
          metadata: { agencyId: agencyMongoId, agencyCode, amountPaise, ref, mode: payoutMode },
        });
        walletLog.info('Brandâ†’agency payout recorded', { brandId: brandMongoId, agencyId: agencyMongoId, agencyCode, amountPaise, ref, mode: payoutMode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Wallet', entityId: brandMongoId, action: 'AGENCY_PAYOUT', changedFields: ['balance'], before: {}, after: { amountPaise, agencyCode, ref, mode: payoutMode } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Payout', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'BRAND_AGENCY_PAYOUT', agencyCode, amountPaise, ref, mode: payoutMode } });

        const privilegedRoles: Role[] = ['admin', 'ops'];
        const audience = {
          roles: privilegedRoles,
          userIds: [brandMongoId, agencyMongoId].filter(Boolean),
        };
        publishRealtime({ type: 'wallets.changed', ts: new Date().toISOString(), audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });
        res.json({ ok: true, mode: payoutMode });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'payoutAgency' } });
        next(err);
      }
    },

    resolveRequest: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = resolveBrandConnectionSchema.parse(req.body);
        const { roles, userId: _userId } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        let agency: any = null;
        if (body.agencyId) {
          agency = await db().user.findFirst({
            where: { ...idWhere(body.agencyId), roles: { has: 'agency' as any }, isDeleted: false },
            select: { id: true, mongoId: true, mediatorCode: true },
          });
        } else if (body.agencyCode) {
          agency = await db().user.findFirst({
            where: { roles: { has: 'agency' as any }, mediatorCode: body.agencyCode, isDeleted: false },
            select: { id: true, mongoId: true, mediatorCode: true },
          });
        }

        if (!agency) throw new AppError(404, 'AGENCY_NOT_FOUND', 'Agency not found');

        const agencyCode = String(agency.mediatorCode || '').trim();
        if (!agencyCode) throw new AppError(409, 'AGENCY_MISSING_CODE', 'Agency is missing a code');
        const agencyMongoId = agency.mongoId || agency.id;

        const brand = await db().user.findFirst({
          where: { id: pgUserId, isDeleted: false },
          select: { id: true, mongoId: true, roles: true, connectedAgencies: true },
        });
        if (!brand) throw new AppError(401, 'UNAUTHENTICATED', 'User not found');
        if (!isPrivileged(roles) && !(brand.roles as string[])?.includes('brand')) {
          throw new AppError(403, 'FORBIDDEN', 'Only brands can approve requests');
        }

        // Soft-delete the pending connection
        await db().pendingConnection.updateMany({
          where: {
            userId: brand.id,
            isDeleted: false,
            OR: [{ agencyCode }, { agencyId: agencyMongoId }],
          },
          data: { isDeleted: true },
        });

        if (body.action === 'approve') {
          // Add to connectedAgencies (addToSet logic)
          const connected = Array.isArray(brand.connectedAgencies) ? [...brand.connectedAgencies] : [];
          if (!connected.includes(agencyCode)) {
            connected.push(agencyCode);
          }
          await db().user.update({ where: { id: brand.id }, data: { connectedAgencies: connected } });
        }

        await writeAuditLog({
          req,
          action: body.action === 'approve' ? 'BRAND_CONNECTION_APPROVED' : 'BRAND_CONNECTION_REJECTED',
          entityType: 'User',
          entityId: brand.mongoId || brand.id,
          metadata: { agencyCode },
        });
        businessLog.info(`Brand connection ${body.action}d`, { brandId: brand.mongoId || brand.id, agencyCode, action: body.action });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'User', entityId: brand.mongoId || brand.id, action: body.action === 'approve' ? 'CONNECTION_APPROVED' : 'CONNECTION_REJECTED', changedFields: ['connectedAgencies'], before: {}, after: { agencyCode, action: body.action } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'BrandConnection', requestId: String((res as any).locals?.requestId || ''), metadata: { action: body.action === 'approve' ? 'CONNECTION_APPROVED' : 'CONNECTION_REJECTED', agencyCode, brandId: brand.mongoId || brand.id } });

        const ts = new Date().toISOString();
        publishRealtime({
          type: 'users.changed',
          ts,
          payload: { brandId: brand.mongoId || brand.id, agencyCode, action: body.action },
          audience: {
            userIds: [brand.mongoId || brand.id],
            agencyCodes: [agencyCode],
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'brand.connection.resolved', agencyCode, action: body.action },
          audience: {
            userIds: [brand.mongoId || brand.id],
            agencyCodes: [agencyCode],
            roles: ['admin', 'ops'],
          },
        });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'resolveRequest' } });
        next(err);
      }
    },

    removeAgency: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = removeBrandConnectionSchema.parse(req.body);
        const { roles } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        const brand = await db().user.findFirst({ where: { id: pgUserId, isDeleted: false }, select: { id: true, mongoId: true, roles: true, connectedAgencies: true } });
        if (!brand) throw new AppError(401, 'UNAUTHENTICATED', 'User not found');
        if (!isPrivileged(roles) && !(brand.roles as string[])?.includes('brand')) {
          throw new AppError(403, 'FORBIDDEN', 'Only brands can remove agencies');
        }

        // Remove from connectedAgencies array
        const connected = Array.isArray(brand.connectedAgencies) ? [...brand.connectedAgencies] : [];
        const filtered = connected.filter((c: string) => c !== body.agencyCode);
        await db().user.update({ where: { id: brand.id }, data: { connectedAgencies: filtered } });

        // Soft-delete pending connections for this agency
        await db().pendingConnection.updateMany({
          where: { userId: brand.id, agencyCode: body.agencyCode, isDeleted: false },
          data: { isDeleted: true },
        });

        await writeAuditLog({
          req,
          action: 'BRAND_CONNECTION_REMOVED',
          entityType: 'User',
          entityId: brand.mongoId || brand.id,
          metadata: { agencyCode: body.agencyCode },
        });
        businessLog.info('Brand agency removed', { brandId: brand.mongoId || brand.id, agencyCode: body.agencyCode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'User', entityId: brand.mongoId || brand.id, action: 'AGENCY_REMOVED', changedFields: ['connectedAgencies'], before: { connectedAgencies: connected }, after: { connectedAgencies: filtered } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'BrandConnection', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'AGENCY_REMOVED', agencyCode: body.agencyCode, brandId: brand.mongoId || brand.id } });

        // Cascade: remove the agency from allowedAgencyCodes on all this brand's campaigns.
        const agencyCode = String(body.agencyCode || '').trim();
        if (agencyCode) {
          const affectedCount = await db().$executeRaw`
            UPDATE "campaigns"
            SET "allowed_agency_codes" = array_remove("allowed_agency_codes", ${agencyCode})
            WHERE "brand_user_id" = ${brand.id}::uuid AND "is_deleted" = false
            AND ${agencyCode} = ANY("allowed_agency_codes")
          `;
          if (affectedCount > 0) {
            writeAuditLog({
              req,
              action: 'CAMPAIGNS_AGENCY_REMOVED_CASCADE',
              entityType: 'User',
              entityId: brand.mongoId || brand.id,
              metadata: { agencyCode, campaignsAffected: affectedCount },
            }).catch(() => { });
          }
        }
        const ts = new Date().toISOString();
        const brandMongoId = brand.mongoId || brand.id;
        publishRealtime({
          type: 'users.changed',
          ts,
          payload: { brandId: brandMongoId, agencyCode, action: 'removed' },
          audience: {
            userIds: [brandMongoId],
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'brand.connection.removed', agencyCode },
          audience: {
            userIds: [brandMongoId],
            ...(agencyCode ? { agencyCodes: [agencyCode] } : {}),
            roles: ['admin', 'ops'],
          },
        });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'removeAgency' } });
        next(err);
      }
    },

    createCampaign: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, userId, user } = getRequester(req);
        const body = createBrandCampaignSchema.parse(req.body);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        let brandPgId: string;
        let brandMongoId: string;
        if (isPrivileged(roles) && body?.brandId) {
          const brandUser = await db().user.findFirst({ where: { ...idWhere(String(body.brandId)), isDeleted: false }, select: { id: true, mongoId: true } });
          if (!brandUser) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
          brandPgId = brandUser.id;
          brandMongoId = brandUser.mongoId || brandUser.id;
        } else {
          brandPgId = pgUserId;
          brandMongoId = userId;
        }

        // Brand must explicitly assign campaigns to specific connected agencies.
        const allowed = body.allowedAgencies;

        const normalizedAllowed = allowed.map((c: any) => String(c).trim()).filter(Boolean);
        const agencies = await db().user.findMany({
          where: {
            mediatorCode: { in: normalizedAllowed },
            roles: { has: 'agency' as any },
            status: 'active' as any,
            isDeleted: false,
          },
          select: { mediatorCode: true },
        });
        const found = new Set(agencies.map((a: any) => String(a.mediatorCode)));
        const missing = normalizedAllowed.filter((c: string) => !found.has(c));
        if (missing.length) {
          throw new AppError(400, 'INVALID_ALLOWED_AGENCIES', `Invalid agency codes: ${missing.join(', ')}`);
        }

        if (!isPrivileged(roles)) {
          // Auto-connect allowed agencies to the brand (addToSet logic)
          const brandUser = await db().user.findFirst({ where: { id: pgUserId, isDeleted: false }, select: { id: true, connectedAgencies: true } });
          if (brandUser) {
            const connected = Array.isArray(brandUser.connectedAgencies) ? [...brandUser.connectedAgencies] : [];
            const merged = Array.from(new Set([...connected, ...normalizedAllowed]));
            if (merged.length !== connected.length) {
              await db().user.update({ where: { id: pgUserId }, data: { connectedAgencies: merged } });
            }
          }
        }

        const campaign = await db().campaign.create({
          data: {
            mongoId: randomUUID(),
            title: body.title,
            brandUserId: brandPgId,
            brandName: isPrivileged(roles) ? (body.brand ?? 'Brand') : String((user as any)?.name || 'Brand'),
            platform: body.platform,
            image: body.image,
            productUrl: body.productUrl,
            originalPricePaise: rupeesToPaise(Number(body.originalPrice ?? 0)),
            pricePaise: rupeesToPaise(Number(body.price ?? 0)),
            payoutPaise: rupeesToPaise(Number(body.payout ?? 0)),
            totalSlots: Number(body.totalSlots ?? 0),
            usedSlots: 0,
            status: 'active' as any,
            allowedAgencyCodes: normalizedAllowed,
            dealType: body.dealType as any,
            returnWindowDays: Number(body.returnWindowDays ?? 14),
            assignments: {},
          },
        });

        const campaignId = campaign.mongoId || campaign.id;
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId, brandId: brandMongoId },
          audience: {
            userIds: [brandMongoId],
            agencyCodes: normalizedAllowed,
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'campaign.created', campaignId },
          audience: {
            userIds: [brandMongoId],
            agencyCodes: normalizedAllowed,
            roles: ['admin', 'ops'],
          },
        });
        await writeAuditLog({
          req,
          action: 'BRAND_CAMPAIGN_CREATED',
          entityType: 'Campaign',
          entityId: campaignId,
          metadata: { title: body.title, platform: body.platform, totalSlots: body.totalSlots, allowedAgencies: normalizedAllowed },
        });
        businessLog.info('Brand campaign created', { campaignId, title: body.title, platform: body.platform, totalSlots: body.totalSlots, allowedAgencies: normalizedAllowed });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: campaignId, action: 'CAMPAIGN_CREATED', changedFields: ['id', 'title', 'status'], before: {}, after: { title: body.title, status: 'active', platform: body.platform, totalSlots: body.totalSlots } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_CREATED', campaignId, title: body.title, platform: body.platform } });

        res.status(201).json(toUiCampaign(pgCampaign(campaign)));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/createCampaign' } });
        next(err);
      }
    },

    updateCampaign: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.campaignId || '');
        if (!id) throw new AppError(400, 'INVALID_CAMPAIGN_ID', 'campaignId required');

        const { roles, userId } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        const existing = await db().campaign.findFirst({
          where: { ...idWhere(id), isDeleted: false },
        });
        if (!existing) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');

        const _previousBrandUserId = existing.brandUserId || null;
        const previousAllowed = Array.isArray(existing.allowedAgencyCodes)
          ? (existing.allowedAgencyCodes as string[]).map((c: string) => c.trim()).filter(Boolean)
          : [];

        const body = updateBrandCampaignSchema.parse(req.body);

        if (!isPrivileged(roles)) {
          // Resolve brand user mongoId from PG UUID for ownership check
          const brandOwner = await db().user.findFirst({ where: { id: existing.brandUserId, isDeleted: false }, select: { mongoId: true } });
          const ownerMongoId = brandOwner?.mongoId || existing.brandUserId;
          if (ownerMongoId !== userId) throw new AppError(403, 'FORBIDDEN', 'Cannot modify campaigns outside your brand');

          if (typeof body.allowedAgencies !== 'undefined') {
            const allowed = body.allowedAgencies ?? [];
            const normalizedAllowed = allowed.map((c: string) => c.trim()).filter(Boolean);
            const agencies = await db().user.findMany({
              where: {
                mediatorCode: { in: normalizedAllowed },
                roles: { has: 'agency' as any },
                status: 'active' as any,
                isDeleted: false,
              },
              select: { mediatorCode: true },
            });
            const found = new Set(agencies.map((a: any) => String(a.mediatorCode)));
            const missing = normalizedAllowed.filter((c: string) => !found.has(c));
            if (missing.length) {
              throw new AppError(400, 'INVALID_ALLOWED_AGENCIES', `Invalid agency codes: ${missing.join(', ')}`);
            }

            // Auto-connect newly assigned agencies.
            const brandUser = await db().user.findFirst({ where: { id: pgUserId, isDeleted: false }, select: { id: true, connectedAgencies: true } });
            if (brandUser) {
              const connected = Array.isArray(brandUser.connectedAgencies) ? [...brandUser.connectedAgencies] : [];
              const merged = Array.from(new Set([...connected, ...normalizedAllowed]));
              if (merged.length !== connected.length) {
                await db().user.update({ where: { id: pgUserId }, data: { connectedAgencies: merged } });
              }
            }
          }
        }

        // Non-negotiable: lock campaign mutability after the first order is created.
        const hasOrders = await db().orderItem.findFirst({
          where: { campaignId: existing.id, isDeleted: false, order: { isDeleted: false } },
          select: { id: true },
        });
        const requestedKeys = Object.keys(body || {});
        const onlyStatus = requestedKeys.length === 1 && requestedKeys[0] === 'status';

        const attemptingLockedTerms =
          typeof body.price !== 'undefined' ||
          typeof body.originalPrice !== 'undefined' ||
          typeof body.payout !== 'undefined' ||
          typeof body.totalSlots !== 'undefined' ||
          typeof body.dealType !== 'undefined';

        if (existing.locked && attemptingLockedTerms && !onlyStatus) {
          throw new AppError(409, 'CAMPAIGN_LOCKED', 'Campaign terms are locked after slot assignment. Non-financial fields (title, image, status) can still be updated.');
        }

        if (hasOrders && attemptingLockedTerms && !onlyStatus) {
          throw new AppError(409, 'CAMPAIGN_LOCKED', 'Campaign terms are locked after first order. Non-financial fields (title, image, status) can still be updated.');
        }

        const update: any = {};
        for (const key of ['title', 'platform', 'image', 'productUrl', 'dealType'] as const) {
          if (typeof body[key] !== 'undefined') update[key] = body[key];
        }
        if (typeof body.status !== 'undefined') update.status = String(body.status).toLowerCase();
        if (typeof body.price !== 'undefined') update.pricePaise = rupeesToPaise(Number(body.price));
        if (typeof body.originalPrice !== 'undefined')
          update.originalPricePaise = rupeesToPaise(Number(body.originalPrice));
        if (typeof body.payout !== 'undefined') update.payoutPaise = rupeesToPaise(Number(body.payout));
        if (typeof body.totalSlots !== 'undefined') update.totalSlots = Number(body.totalSlots);
        if (typeof body.allowedAgencies !== 'undefined') update.allowedAgencyCodes = body.allowedAgencies;

        const effectivePrice = update.pricePaise ?? existing.pricePaise ?? 0;
        const effectivePayout = update.payoutPaise ?? existing.payoutPaise ?? 0;
        const effectiveOriginalPrice = update.originalPricePaise ?? existing.originalPricePaise ?? effectivePrice;
        const dealType = String(update.dealType ?? existing.dealType ?? '').trim();
        const skipPayoutGuard = dealType === 'Review' || dealType === 'Rating';
        if (!skipPayoutGuard && effectivePayout > effectivePrice) {
          throw new AppError(400, 'INVALID_ECONOMICS', 'Payout cannot exceed selling price');
        }
        if (effectiveOriginalPrice < effectivePrice && effectiveOriginalPrice > 0) {
          throw new AppError(400, 'INVALID_ECONOMICS', 'Original price cannot be less than selling price');
        }

        const statusRequested = typeof body.status !== 'undefined';

        const campaign = await db().campaign.update({
          where: { id: existing.id },
          data: update,
        });

        if (statusRequested) {
          const isActive = String(campaign.status || '').toLowerCase() === 'active';
          await db().deal.updateMany({
            where: { campaignId: campaign.id, isDeleted: false },
            data: { active: isActive },
          });
        }

        const nextAllowed = Array.isArray(campaign.allowedAgencyCodes)
          ? (campaign.allowedAgencyCodes as string[]).map((c: string) => c.trim()).filter(Boolean)
          : [];

        const allowedUnion = Array.from(new Set([...(previousAllowed || []), ...(nextAllowed || [])])).filter(Boolean);
        // Resolve brand user mongoId for realtime audience
        const brandOwner = await db().user.findFirst({ where: { id: campaign.brandUserId, isDeleted: false }, select: { mongoId: true } });
        const brandUserIdForAudience = brandOwner?.mongoId || campaign.brandUserId || userId;

        const campaignMongoId = campaign.mongoId || campaign.id;
        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: campaignMongoId },
          audience: {
            userIds: [brandUserIdForAudience],
            agencyCodes: allowedUnion,
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'campaign.updated', campaignId: campaignMongoId },
          audience: {
            userIds: [brandUserIdForAudience],
            agencyCodes: allowedUnion,
            roles: ['admin', 'ops'],
          },
        });

        await writeAuditLog({
          req,
          action: 'CAMPAIGN_UPDATED',
          entityType: 'Campaign',
          entityId: campaignMongoId,
          metadata: { updatedFields: Object.keys(update) },
        });
        businessLog.info('Brand campaign updated', { campaignId: campaignMongoId, updatedFields: Object.keys(update) });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: campaignMongoId, action: 'CAMPAIGN_UPDATED', changedFields: Object.keys(update), before: { status: existing.status }, after: update });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_UPDATED', campaignId: campaignMongoId, updatedFields: Object.keys(update) } });

        res.json(toUiCampaign(pgCampaign(campaign)));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/updateCampaign' } });
        next(err);
      }
    },

    copyCampaign: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = copyCampaignSchema.parse(req.body);
        const { roles, userId } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        const campaign = await db().campaign.findFirst({ where: { ...idWhere(id), isDeleted: false } });
        if (!campaign) {
          throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
        }

        // Only brand owner or privileged can copy
        const brandOwner = await db().user.findFirst({ where: { id: campaign.brandUserId, isDeleted: false }, select: { mongoId: true } });
        const ownerMongoId = brandOwner?.mongoId || campaign.brandUserId;
        if (!isPrivileged(roles) && ownerMongoId !== userId) {
          throw new AppError(403, 'FORBIDDEN', 'Not authorized to copy this campaign');
        }

        const newCampaign = await db().campaign.create({
          data: {
            mongoId: randomUUID(),
            title: `${campaign.title} (Copy)`,
            brandUserId: campaign.brandUserId,
            brandName: campaign.brandName,
            platform: campaign.platform,
            image: campaign.image,
            productUrl: campaign.productUrl,
            dealType: campaign.dealType,
            originalPricePaise: campaign.originalPricePaise,
            pricePaise: campaign.pricePaise,
            payoutPaise: campaign.payoutPaise,
            totalSlots: campaign.totalSlots,
            returnWindowDays: campaign.returnWindowDays,
            usedSlots: 0,
            status: 'draft' as any,
            allowedAgencyCodes: (campaign.allowedAgencyCodes as string[]) || [],
            assignments: {},
            locked: false,
            createdBy: pgUserId,
          },
        });

        const newId = newCampaign.mongoId || newCampaign.id;
        await writeAuditLog({
          req,
          action: 'CAMPAIGN_COPIED',
          entityType: 'Campaign',
          entityId: newId,
          metadata: { sourceCampaignId: id },
        });
        businessLog.info('Brand campaign copied', { newCampaignId: newId, sourceCampaignId: id, title: campaign.title });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: newId, action: 'CAMPAIGN_COPIED', changedFields: ['id'], before: { sourceCampaignId: id }, after: { newCampaignId: newId, status: 'draft' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_COPIED', newCampaignId: newId, sourceCampaignId: id } });

        const ts = new Date().toISOString();
        const allowed = Array.isArray(campaign.allowedAgencyCodes)
          ? (campaign.allowedAgencyCodes as string[]).filter(Boolean)
          : [];
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: newId, brandId: ownerMongoId },
          audience: {
            userIds: [ownerMongoId],
            agencyCodes: allowed,
            roles: ['admin', 'ops'],
          },
        });

        res.json({ ok: true, id: newId });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/copyCampaign' } });
        next(err);
      }
    },

    deleteCampaign: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.campaignId || '').trim();
        if (!id) throw new AppError(400, 'INVALID_CAMPAIGN_ID', 'campaignId required');

        const { roles, userId } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        const campaign = await db().campaign.findFirst({
          where: { ...idWhere(id), isDeleted: false },
          select: { id: true, mongoId: true, brandUserId: true, title: true, allowedAgencyCodes: true, assignments: true },
        });
        if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');

        const brandOwner = await db().user.findFirst({ where: { id: campaign.brandUserId, isDeleted: false }, select: { mongoId: true } });
        const ownerMongoId = brandOwner?.mongoId || campaign.brandUserId;
        if (!isPrivileged(roles) && ownerMongoId !== userId) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot delete campaigns outside your ownership');
        }

        const hasOrders = await db().orderItem.findFirst({
          where: { campaignId: campaign.id, isDeleted: false, order: { isDeleted: false } },
          select: { id: true },
        });
        if (hasOrders) throw new AppError(409, 'CAMPAIGN_HAS_ORDERS', 'Cannot delete a campaign with orders');

        await db().campaign.update({
          where: { id: campaign.id },
          data: { isDeleted: true, updatedBy: pgUserId},
        });

        await db().deal.updateMany({
          where: { campaignId: campaign.id, isDeleted: false },
          data: { isDeleted: true, updatedBy: pgUserId, active: false },
        });

        const campaignMongoId = campaign.mongoId || campaign.id;
        await writeAuditLog({
          req,
          action: 'CAMPAIGN_DELETED',
          entityType: 'Campaign',
          entityId: campaignMongoId,
        });
        businessLog.info('Brand campaign deleted', { campaignId: campaignMongoId, title: campaign.title });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Campaign', entityId: campaignMongoId, action: 'CAMPAIGN_DELETED', changedFields: ['isDeleted'], before: { isDeleted: false }, after: { isDeleted: new Date().toISOString() } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Campaign', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'CAMPAIGN_DELETED', campaignId: campaignMongoId, title: campaign.title } });

        const allowed = Array.isArray(campaign.allowedAgencyCodes)
          ? (campaign.allowedAgencyCodes as string[]).filter(Boolean)
          : [];
        const assignments = campaign.assignments;
        const assignmentCodes = assignments && typeof assignments === 'object' && !Array.isArray(assignments)
          ? Object.keys(assignments as Record<string, unknown>)
          : [];

        const ts = new Date().toISOString();
        publishRealtime({
          type: 'deals.changed',
          ts,
          payload: { campaignId: campaignMongoId },
          audience: {
            userIds: [ownerMongoId].filter(Boolean),
            agencyCodes: allowed,
            mediatorCodes: assignmentCodes,
            roles: ['admin', 'ops'],
          },
        });
        publishRealtime({
          type: 'notifications.changed',
          ts,
          payload: { source: 'campaign.deleted', campaignId: campaignMongoId },
          audience: {
            userIds: [ownerMongoId].filter(Boolean),
            agencyCodes: allowed,
            mediatorCodes: assignmentCodes,
            roles: ['admin', 'ops'],
          },
        });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'high', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/deleteCampaign' } });
        next(err);
      }
    },

    /* ─── Lightweight dashboard-specific endpoints ──────────────────── */

    /** GET /brand/dashboard-stats — pre-computed KPI numbers for brand dashboard */
    getDashboardStats: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        let brandPgId: string;
        let brandName: string = (user as any)?.name || '';
        const requested = String(req.query.brandId || '');
        if (isPrivileged(roles) && requested) {
          const brandUser = await db().user.findFirst({ where: { ...idWhere(requested), isDeleted: false }, select: { id: true, name: true } });
          if (!brandUser) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
          brandPgId = brandUser.id;
          brandName = brandUser.name;
        } else {
          brandPgId = pgUserId;
        }

        // Order ownership: direct brandUserId match OR legacy name-based match
        const orderWhere = brandName
          ? { OR: [{ brandUserId: brandPgId }, { brandUserId: null, brandName }], isDeleted: false }
          : { brandUserId: brandPgId, isDeleted: false };

        // All 4 stats in parallel — pure aggregates, no row transfer
        const [revenueRow, activeCampaigns, partnerCount, reachRow] = await Promise.all([
          db().order.aggregate({
            where: orderWhere,
            _sum: { totalPaise: true },
          }),
          db().campaign.count({ where: { brandUserId: brandPgId, isDeleted: false, status: 'Active' as any } }),
          (async () => {
            if (isPrivileged(roles)) return db().user.count({ where: { roles: { has: 'agency' as any }, isDeleted: false } });
            const brandUser = await db().user.findFirst({ where: { id: brandPgId, isDeleted: false }, select: { connectedAgencies: true } });
            const connected = Array.isArray((brandUser as any)?.connectedAgencies) ? (brandUser as any).connectedAgencies as string[] : [];
            return connected.length;
          })(),
          db().campaign.aggregate({
            where: { brandUserId: brandPgId, isDeleted: false },
            _sum: { totalSlots: true },
          }),
        ]);

        res.json({
          totalRevenue: Math.round(Number(revenueRow._sum.totalPaise ?? 0) / 100),
          activeCampaigns,
          partnerAgencies: partnerCount,
          inventoryReach: Number(reachRow._sum.totalSlots ?? 0),
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/getDashboardStats' } });
        next(err);
      }
    },

    /** GET /brand/revenue-trend — daily revenue for chart (brand dashboard) */
    getRevenueTrend: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, user } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        let brandPgId: string;
        let brandName: string = (user as any)?.name || '';
        const requested = String(req.query.brandId || '');
        if (isPrivileged(roles) && requested) {
          const brandUser = await db().user.findFirst({ where: { ...idWhere(requested), isDeleted: false }, select: { id: true, name: true } });
          if (!brandUser) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
          brandPgId = brandUser.id;
          brandName = brandUser.name;
        } else {
          brandPgId = pgUserId;
        }

        const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
        const now = new Date();
        const start = new Date(now);
        start.setDate(now.getDate() - (days - 1));
        start.setHours(0, 0, 0, 0);

        // Match orders by brandUserId OR legacy name-based assignment
        const rows = brandName
          ? await db().$queryRaw<{ day: string; total: bigint }[]>`
              SELECT TO_CHAR("created_at", 'YYYY-MM-DD') AS day,
                     COALESCE(SUM("total_paise"), 0)::bigint AS total
              FROM "orders"
              WHERE ("brand_user_id" = ${brandPgId}::uuid
                     OR ("brand_user_id" IS NULL AND "brand_name" = ${brandName}))
                AND "is_deleted" = false
                AND "created_at" >= ${start}
              GROUP BY TO_CHAR("created_at", 'YYYY-MM-DD')
              ORDER BY day
            `
          : await db().$queryRaw<{ day: string; total: bigint }[]>`
              SELECT TO_CHAR("created_at", 'YYYY-MM-DD') AS day,
                     COALESCE(SUM("total_paise"), 0)::bigint AS total
              FROM "orders"
              WHERE "brand_user_id" = ${brandPgId}::uuid
                AND "is_deleted" = false
                AND "created_at" >= ${start}
              GROUP BY TO_CHAR("created_at", 'YYYY-MM-DD')
              ORDER BY day
            `;

        const revenueByDay = new Map(rows.map(r => [r.day, Math.round(Number(r.total) / 100)]));
        const points: Array<{ name: string; revenue: number; dateKey: string }> = [];
        for (let i = 0; i < days; i++) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          const dateKey = `${yyyy}-${mm}-${dd}`;
          const name = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
          points.push({ name, revenue: revenueByDay.get(dateKey) ?? 0, dateKey });
        }

        res.json(points);
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/getRevenueTrend' } });
        next(err);
      }
    },

    /** GET /brand/inventory-fill — top campaigns fill rate (brand dashboard) */
    getInventoryFill: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles } = getRequester(req);
        const pgUserId = (req.auth as any)?.pgUserId as string;

        let brandPgId: string;
        const requested = String(req.query.brandId || '');
        if (isPrivileged(roles) && requested) {
          const brandUser = await db().user.findFirst({ where: { ...idWhere(requested), isDeleted: false }, select: { id: true } });
          if (!brandUser) throw new AppError(404, 'BRAND_NOT_FOUND', 'Brand not found');
          brandPgId = brandUser.id;
        } else {
          brandPgId = pgUserId;
        }

        // Top 5 campaigns by slot usage — minimal select
        const campaigns = await db().campaign.findMany({
          where: { brandUserId: brandPgId, isDeleted: false },
          orderBy: { usedSlots: 'desc' },
          take: 5,
          select: { title: true, usedSlots: true, totalSlots: true },
        });

        res.json(campaigns.map(c => ({
          name: c.title.split(' ')[0],
          sold: c.usedSlots ?? 0,
          remaining: Math.max(0, (c.totalSlots ?? 0) - (c.usedSlots ?? 0)),
          total: c.totalSlots ?? 0,
        })));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'brand/getInventoryFill' } });
        next(err);
      }
    },
  };
}
