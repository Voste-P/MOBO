import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../database/prisma.js';
import { AppError } from '../middleware/errors.js';
import { toUiDeal } from '../utils/uiMappers.js';
import { normalizeMediatorCode } from '../utils/mediatorCode.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { pushOrderEvent } from '../services/orderEvents.js';
import { writeAuditLog } from '../services/audit.js';
import { publishRealtime } from '../services/realtimeHub.js';
import { pgDeal } from '../utils/pgMappers.js';
import { idWhere } from '../utils/idWhere.js';
import { orderLog, businessLog } from '../config/logger.js';
import { logChangeEvent, logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { getAgencyCodeForMediatorCode } from '../services/lineage.js';

function db() { return prisma(); }

export function makeProductsController() {
  return {
    listProducts: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const requester = req.auth?.user;
        const requesterRoles = req.auth?.roles ?? [];
        if (!requester || !requesterRoles.includes('shopper')) {
          throw new AppError(403, 'FORBIDDEN', 'Only buyers can list products');
        }

        // Buyers can ONLY see deals assigned to their mediator.
        const mediatorCode = normalizeMediatorCode((requester as any).parentCode);
        if (!mediatorCode) {
          res.json([]);
          return;
        }

        const { page, limit, skip, isPaginated } = parsePagination(req.query as Record<string, unknown>, { limit: 50 });
        const where = {
          mediatorCode: { equals: mediatorCode, mode: 'insensitive' as const },
          active: true,
          isDeleted: false,
          campaign: { isDeleted: false, status: 'active' as any },
        };

        const [rawDeals, total, mediatorUser, agencyCode] = await Promise.all([
          db().deal.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            include: { campaign: { select: { totalSlots: true, usedSlots: true, openToAll: true, assignments: true, allowedAgencyCodes: true, createdAt: true } } },
          }),
          db().deal.count({ where }),
          db().user.findFirst({
            where: { mediatorCode: { equals: mediatorCode, mode: 'insensitive' }, isDeleted: false },
            select: { name: true },
          }),
          getAgencyCodeForMediatorCode(mediatorCode),
        ]);

        // Filter out deals where the mediator's agency no longer has campaign access
        const deals = rawDeals.filter((d: any) => {
          const campaign = d.campaign;
          if (!campaign) return false;
          if (campaign.openToAll) return true;
          const medCodeLwr = mediatorCode.toLowerCase();
          const assignments = campaign.assignments && typeof campaign.assignments === 'object' && !Array.isArray(campaign.assignments) ? campaign.assignments as Record<string, any> : {};
          // Case-insensitive key lookup: assignSlots stores lowercase keys but
          // legacy data may have mixed-case keys.
          const assignmentMatch = assignments[medCodeLwr] || Object.keys(assignments).some(k => k.toLowerCase() === medCodeLwr && assignments[k]);
          if (assignmentMatch) return true;
          if (agencyCode) {
            const allowed = Array.isArray(campaign.allowedAgencyCodes) ? campaign.allowedAgencyCodes.map((c: any) => String(c).trim().toUpperCase()) : [];
            if (allowed.includes(agencyCode.toUpperCase())) return true;
          }
          return false;
        });

        // For non-openToAll campaigns, count per-mediator order consumption
        const perMedCounts = new Map<string, number>();
        const nonOpenIds = deals
          .filter((d: any) => d.campaign && !d.campaign.openToAll)
          .map((d: any) => d.campaignId as string);
        if (nonOpenIds.length > 0) {
          const uniqueIds = [...new Set(nonOpenIds)];
          const rows: Array<{ campaign_id: string; cnt: bigint }> =
            await db().$queryRawUnsafe(
              `SELECT oi.campaign_id, COUNT(*)::bigint AS cnt
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id AND o.is_deleted = false
               WHERE oi.campaign_id = ANY($1::uuid[])
                 AND oi.is_deleted = false
                 AND LOWER(o.manager_name) = LOWER($2)
               GROUP BY oi.campaign_id`,
              uniqueIds,
              mediatorCode,
            );
          for (const row of rows) {
            perMedCounts.set(row.campaign_id, Number(row.cnt));
          }
        }

        const mediatorName = mediatorUser?.name || '';
        const medCodeLower = mediatorCode.toLowerCase();
        const enrichedDeals = deals.map((d: any) => {
          const campaign = d.campaign;
          const isOpen = campaign?.openToAll ?? false;
          const assignments = campaign?.assignments && typeof campaign.assignments === 'object' && !Array.isArray(campaign.assignments)
            ? campaign.assignments as Record<string, any>
            : {};

          let totalSlots: number;
          let usedSlots: number;

          if (!isOpen && assignments[medCodeLower]) {
            const assignment = assignments[medCodeLower];
            totalSlots = Number(typeof assignment === 'number' ? assignment : assignment?.limit ?? 0);
            usedSlots = perMedCounts.get(d.campaignId) ?? 0;
          } else {
            totalSlots = campaign?.totalSlots || 0;
            usedSlots = campaign?.usedSlots || 0;
          }

          const remainingSlots = Math.max(0, totalSlots - usedSlots);
          let sellingSpeed = 0;
          if (campaign?.createdAt && usedSlots > 0) {
            const daysSinceCreation = Math.max(1, (Date.now() - new Date(campaign.createdAt).getTime()) / (1000 * 60 * 60 * 24));
            sellingSpeed = Math.round((usedSlots / daysSinceCreation) * 10) / 10;
          }
          const { campaign: _c, ...rest } = d;
          return { ...rest, totalSlots, usedSlots, remainingSlots, sellingSpeed };
        });
        res.json(paginatedResponse(enrichedDeals.map((d: any) => toUiDeal(pgDeal(d), mediatorName)), total, page, limit, isPaginated));

        businessLog.info(`[Buyer] User ${req.auth?.userId} listed products — ${deals.length} deals, mediator: ${mediatorCode || 'none'}`, { actorUserId: req.auth?.userId, mediatorCode, resultCount: deals.length, total, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Deal',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'PRODUCTS_LISTED', endpoint: 'listProducts', mediatorCode, resultCount: deals.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'products/listProducts' } });
        next(err);
      }
    },

    trackRedirect: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const requester = req.auth?.user;
        const requesterId = req.auth?.userId;
        const pgUserId = (req.auth as any)?.pgUserId as string;
        const requesterRoles = req.auth?.roles ?? [];
        if (!requester || !requesterId || !requesterRoles.includes('shopper')) {
          throw new AppError(403, 'FORBIDDEN', 'Only buyers can access redirect tracking');
        }

        const dealId = String(req.params.dealId || '').trim();
        if (!dealId) throw new AppError(400, 'INVALID_DEAL_ID', 'dealId required');

        const mediatorCode = normalizeMediatorCode((requester as any).parentCode);
        if (!mediatorCode) throw new AppError(409, 'MISSING_MEDIATOR_LINK', 'Your account is not linked to a mediator');

        const deal = await db().deal.findFirst({
          where: {
            ...idWhere(dealId),
            mediatorCode: { equals: mediatorCode, mode: 'insensitive' },
            active: true,
            isDeleted: false,
          },
        });
        if (!deal) throw new AppError(404, 'DEAL_NOT_FOUND', 'Deal not found');

        // [PERF] Parallelize campaign + brand user lookup — campaign depends on deal.campaignId
        // but brand user lookup only needs campaign.brandUserId, so fetch campaign first then
        // brand user in parallel with order creation prep.
        const campaign = await db().campaign.findFirst({
          where: { id: deal.campaignId },
          select: { id: true, brandUserId: true, brandName: true, isDeleted: true },
        });
        if (!campaign || campaign.isDeleted) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');

        // Fire brand user lookup in parallel — don't block order creation
        const brandUserPromise = campaign.brandUserId
          ? db().user.findFirst({ where: { id: campaign.brandUserId }, select: { id: true } })
          : Promise.resolve(null);

        const preOrder = await db().order.create({
          data: {
            userId: pgUserId,
            brandUserId: campaign.brandUserId,
            totalPaise: 0,
            workflowStatus: 'REDIRECTED' as any,
            status: 'Ordered' as any,
            paymentStatus: 'Pending' as any,
            affiliateStatus: 'Unchecked' as any,
            managerName: mediatorCode,
            agencyName: 'Partner Agency',
            buyerName: String((requester as any).name || ''),
            buyerMobile: String((requester as any).mobile || ''),
            brandName: String(deal.brandName ?? campaign.brandName ?? ''),
            events: pushOrderEvent([], {
              type: 'WORKFLOW_TRANSITION',
              at: new Date(),
              actorUserId: requesterId,
              metadata: { from: 'CREATED', to: 'REDIRECTED', dealId, campaignId: deal.campaignId },
            }),
            createdBy: pgUserId,
            items: {
              create: [
                {
                  productId: deal.id,
                  title: String(deal.title),
                  image: String(deal.image ?? ''),
                  priceAtPurchasePaise: Number(deal.pricePaise ?? 0),
                  commissionPaise: Number(deal.commissionPaise ?? 0),
                  campaignId: deal.campaignId,
                  dealType: String(deal.dealType ?? ''),
                  quantity: 1,
                  platform: String(deal.platform ?? ''),
                  brandName: String(deal.brandName ?? campaign.brandName ?? ''),
                },
              ],
            },
          },
        });

        writeAuditLog({
          req,
          action: 'ORDER_REDIRECT_CREATED',
          entityType: 'Order',
          entityId: preOrder.id,
          metadata: { dealId, campaignId: deal.campaignId, mediatorCode },
        });
        orderLog.info('Order redirect tracked', { orderId: preOrder.id, dealId, campaignId: deal.campaignId, mediatorCode, userId: requesterId });
        businessLog.info(`[Buyer] User ${requesterId} redirected to deal ${dealId} — order ${preOrder.id}, campaign ${deal.campaignId}, mediator: ${mediatorCode}`, { actorUserId: requesterId, orderId: preOrder.id, dealId, campaignId: deal.campaignId, mediatorCode, platform: String(deal.platform ?? ''), ip: req.ip });
        logChangeEvent({ actorUserId: requesterId, entityType: 'Order', entityId: preOrder.id, action: 'STATUS_CHANGE', changedFields: ['workflowStatus'], before: {}, after: { workflowStatus: 'REDIRECTED' } });

        const ts = new Date().toISOString();
        // Resolve the parallel brand user lookup
        const brandUser = await brandUserPromise;
        const brandUserPgId = brandUser?.id ?? undefined;
        publishRealtime({
          type: 'orders.changed',
          ts,
          payload: { orderId: preOrder.id, dealId },
          audience: {
            userIds: [requesterId, brandUserPgId].filter(Boolean) as string[],
            roles: ['admin', 'ops'],
          },
        });

        res.status(201).json({
          preOrderId: preOrder.id,
          url: String(deal.productUrl),
        });

        logAccessEvent('RESOURCE_ACCESS', {
          userId: requesterId,
          roles: requesterRoles,
          ip: req.ip,
          resource: 'DealRedirect',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'DEAL_REDIRECT', dealId, campaignId: deal.campaignId, mediatorCode, preOrderId: preOrder.id },
        });
      } catch (err) {
        logErrorEvent({ category: 'BUSINESS_LOGIC', severity: 'medium', message: 'Deal redirect tracking failed', operation: 'trackRedirect', error: err, metadata: { dealId: String(req.params.dealId || ''), userId: req.auth?.userId } });
        next(err);
      }
    },
  };
}
