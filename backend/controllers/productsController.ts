import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
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
          deletedAt: null,
        };

        const [deals, total, mediatorUser] = await Promise.all([
          db().deal.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          db().deal.count({ where }),
          db().user.findFirst({
            where: { mediatorCode: { equals: mediatorCode, mode: 'insensitive' }, deletedAt: null },
            select: { name: true },
          }),
        ]);

        const mediatorName = mediatorUser?.name || '';
        res.json(paginatedResponse(deals.map(d => toUiDeal(pgDeal(d), mediatorName)), total, page, limit, isPaginated));

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
            deletedAt: null,
          },
        });
        if (!deal) throw new AppError(404, 'DEAL_NOT_FOUND', 'Deal not found');

        const campaign = await db().campaign.findFirst({
          where: { id: deal.campaignId },
          select: { id: true, brandUserId: true, brandName: true, deletedAt: true },
        });
        if (!campaign || campaign.deletedAt) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');

        // Look up brand user's mongoId for realtime audience
        let brandUserMongoId: string | undefined;
        if (campaign.brandUserId) {
          const bu = await db().user.findFirst({ where: { id: campaign.brandUserId }, select: { mongoId: true } });
          brandUserMongoId = bu?.mongoId ?? undefined;
        }

        const mongoId = randomUUID();
        const _preOrder = await db().order.create({
          data: {
            mongoId,
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
                  productId: deal.mongoId || deal.id,
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
          entityId: mongoId,
          metadata: { dealId, campaignId: deal.campaignId, mediatorCode },
        });
        orderLog.info('Order redirect tracked', { orderId: mongoId, dealId, campaignId: deal.campaignId, mediatorCode, userId: requesterId });
        businessLog.info(`[Buyer] User ${requesterId} redirected to deal ${dealId} — order ${mongoId}, campaign ${deal.campaignId}, mediator: ${mediatorCode}`, { actorUserId: requesterId, orderId: mongoId, dealId, campaignId: deal.campaignId, mediatorCode, platform: String(deal.platform ?? ''), ip: req.ip });
        logChangeEvent({ actorUserId: requesterId, entityType: 'Order', entityId: mongoId, action: 'STATUS_CHANGE', changedFields: ['workflowStatus'], before: {}, after: { workflowStatus: 'REDIRECTED' } });

        const ts = new Date().toISOString();
        publishRealtime({
          type: 'orders.changed',
          ts,
          payload: { orderId: mongoId, dealId },
          audience: {
            userIds: [requesterId, brandUserMongoId].filter(Boolean) as string[],
            roles: ['admin', 'ops'],
          },
        });

        res.status(201).json({
          preOrderId: mongoId,
          url: String(deal.productUrl),
        });

        logAccessEvent('RESOURCE_ACCESS', {
          userId: requesterId,
          roles: requesterRoles,
          ip: req.ip,
          resource: 'DealRedirect',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'DEAL_REDIRECT', dealId, campaignId: deal.campaignId, mediatorCode, preOrderId: mongoId },
        });
      } catch (err) {
        logErrorEvent({ category: 'BUSINESS_LOGIC', severity: 'medium', message: 'Deal redirect tracking failed', operation: 'trackRedirect', error: err, metadata: { dealId: String(req.params.dealId || ''), userId: req.auth?.userId } });
        next(err);
      }
    },
  };
}
