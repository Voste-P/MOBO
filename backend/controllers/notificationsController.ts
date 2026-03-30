import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../database/prisma.js';
import { AppError } from '../middleware/errors.js';
import { paiseToRupees } from '../utils/money.js';
import { getRequester } from '../services/authz.js';
import { safeIso } from '../utils/uiMappers.js';
import { businessLog } from '../config/logger.js';
import { logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { orderNotificationSelect, getProofFlags } from '../utils/querySelect.js';

function db() { return prisma(); }

type UiNotification = {
  id: string;
  type: 'success' | 'info' | 'alert';
  title: string;
  message: string;
  createdAt: string;
  action?: { label: string; href?: string };
};

function safeOrderShortId(order: any): string {
  const external = String(order?.externalOrderId || '').trim();
  if (external) return external.length > 20 ? external.slice(-20) : external;
  const s = String(order?.mongoId || order?.id || order || '').trim();
  return s.length > 6 ? s.slice(-6) : s || 'Pending';
}

function nowIso() {
  return new Date().toISOString();
}

export function makeNotificationsController() {
  return {
    list: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId, pgUserId, roles, user } = getRequester(req);
        if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'Missing auth context');

        const isShopper = roles.includes('shopper');
        const isMediator = roles.includes('mediator');
        const notifications: UiNotification[] = [];

        if (isShopper) {
          const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
          const orders = await db().order.findMany({
            where: { userId: pgUserId, isDeleted: false, updatedAt: { gte: sevenDaysAgo } },
            select: orderNotificationSelect,
            orderBy: { updatedAt: 'desc' },
            take: 50,
          });

          // Fetch lightweight boolean proof flags (avoids transferring MB-sized base64 columns)
          const proofMap = await getProofFlags(db(), orders.map(o => o.id));

          for (const o of orders) {
            const shortId = safeOrderShortId(o);
            const wf = String(o.workflowStatus || '').trim();
            const pay = String(o.paymentStatus || '').trim();
            const aff = String(o.affiliateStatus || '').trim();
            const flags = proofMap.get(o.id);
            const hasPurchaseProof = !!flags?.hasOrderProof;
            const ts = safeIso(o.updatedAt) ?? nowIso();

            const dealTypes = Array.isArray(o.items)
              ? o.items.map((it: any) => String(it?.dealType || '')).filter(Boolean)
              : [];
            const requiresReview = dealTypes.includes('Review');
            const requiresRating = dealTypes.includes('Rating');
            const hasReviewProof = !!(o.reviewLink || flags?.hasReviewProof);
            const hasRatingProof = !!flags?.hasRatingProof;
            const verification = o.verification as any;
            const orderVerifiedAt = verification?.order?.verifiedAt
              ? new Date(verification.order.verifiedAt)
              : null;
            const rejectionReason = o.rejectionReason;
            const missingSteps: string[] = [];
            if (requiresReview && !hasReviewProof) missingSteps.push('review');
            if (requiresRating && !hasRatingProof) missingSteps.push('rating');

            const missingProofRequests = Array.isArray(o.missingProofRequests) ? o.missingProofRequests : [];
            const requestedMissing = missingProofRequests
              .map((r: any) => String(r?.type || '').trim())
              .filter((t: string) => (t === 'review' || t === 'rating') && missingSteps.includes(t));

            const oid = o.mongoId || o.id;

            if (!hasPurchaseProof && (wf === 'ORDERED' || wf === 'REDIRECTED' || wf === 'CREATED')) {
              notifications.push({
                id: `order:${oid}:need-proof`,
                type: 'alert',
                title: 'Upload purchase proof',
                message: `Upload your purchase screenshot for order #${shortId} to start verification.`,
                createdAt: ts,
              });
              continue;
            }

            if (rejectionReason) {
              notifications.push({
                id: `order:${oid}:rejected:${ts}`,
                type: 'alert',
                title: 'Proof rejected',
                message: rejectionReason || `Your proof for order #${shortId} was rejected.`,
                createdAt: ts,
                action: { label: 'Fix now', href: '/orders' },
              });
              continue;
            }

            if (requestedMissing.length > 0) {
              const label = requestedMissing.length === 2 ? 'review & rating' : requestedMissing[0];
              notifications.push({
                id: `order:${oid}:requested:${requestedMissing.slice().sort().join(',')}:${ts}`,
                type: 'alert',
                title: 'Action requested by mediator',
                message: `Please submit your ${label} proof for order #${shortId}.`,
                createdAt: ts,
                action: { label: 'Upload now', href: '/orders' },
              });
              continue;
            }

            // Purchase is verified but additional steps are missing (review/rating).
            if (orderVerifiedAt && missingSteps.length > 0) {
              const label = missingSteps.length === 2 ? 'review & rating' : missingSteps[0];
              notifications.push({
                id: `order:${oid}:missing:${missingSteps.slice().sort().join(',')}:${ts}`,
                type: 'alert',
                title: 'Action required to unlock cashback',
                message: `Please submit your ${label} proof for order #${shortId}.`,
                createdAt: ts,
              });
              continue;
            }

            if (wf === 'UNDER_REVIEW' || wf === 'PROOF_SUBMITTED') {
              notifications.push({
                id: `order:${oid}:under-review:${ts}`,
                type: 'info',
                title: 'Verification in progress',
                message: `Your order #${shortId} is under review.`,
                createdAt: ts,
              });
              continue;
            }

            if (pay === 'Paid' || wf === 'COMPLETED' || aff === 'Approved_Settled') {
              notifications.push({
                id: `order:${oid}:paid:${ts}`,
                type: 'success',
                title: 'Cashback sent',
                message: `Cashback for order #${shortId} has been processed.`,
                createdAt: ts,
              });
              continue;
            }

            if (wf === 'REJECTED' || wf === 'FAILED' || aff === 'Rejected' || aff === 'Frozen_Disputed' || aff === 'Cap_Exceeded') {
              notifications.push({
                id: `order:${oid}:issue:${ts}`,
                type: 'alert',
                title: 'Order needs attention',
                message: `There is an issue with order #${shortId} (${wf || aff || pay}).`,
                createdAt: ts,
              });
            }
          }

          // Also show onboarding status if applicable.
          if (user && (user as any).isVerifiedByMediator === false) {
            notifications.unshift({
              id: `shopper:${userId}:pending-approval`,
              type: 'info',
              title: 'Approval pending',
              message: 'Your mediator approval is pending. You will be notified once approved.',
              createdAt: nowIso(),
            });
          }
        }

        if (isMediator) {
          const mediatorCode = String((user as any)?.mediatorCode || '').trim();
          if (mediatorCode) {
            const [pendingUsers, pendingOrders] = await Promise.all([
              db().user.count({ where: { parentCode: mediatorCode, roles: { has: 'shopper' as any }, isVerifiedByMediator: false, isDeleted: false } }),
              db().order.count({ where: { managerName: mediatorCode, workflowStatus: 'UNDER_REVIEW' as any, isDeleted: false } }),
            ]);

            if (pendingUsers > 0) {
              notifications.push({
                id: `mediator:${mediatorCode}:pending-users:${pendingUsers}`,
                type: 'alert',
                title: 'Buyer approvals pending',
                message: `${pendingUsers} buyers are waiting for approval.`,
                createdAt: nowIso(),
              });
            }

            if (pendingOrders > 0) {
              notifications.push({
                id: `mediator:${mediatorCode}:pending-orders:${pendingOrders}`,
                type: 'alert',
                title: 'Order verification pending',
                message: `${pendingOrders} orders need verification.`,
                createdAt: nowIso(),
              });
            }
          }

          // Recent payouts recorded to this mediator.
          const payouts = await db().payout.findMany({
            where: { beneficiaryUserId: pgUserId, isDeleted: false },
            select: { id: true, mongoId: true, amountPaise: true, status: true, processedAt: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 10,
          });

          for (const p of payouts) {
            const createdAt = safeIso(p.processedAt) ?? safeIso(p.createdAt) ?? new Date().toISOString();
            const amount = paiseToRupees(Number(p.amountPaise ?? 0));
            notifications.push({
              id: `payout:${p.mongoId || p.id}`,
              type: p.status === 'paid' ? 'success' : 'info',
              title: 'Payout recorded',
              message: `₹${amount} payout has been recorded (${String(p.status || 'requested')}).`,
              createdAt,
            });
          }
        }

        // ── Ticket status notifications (all roles) ──────────────────────
        // Show recent ticket updates — resolved/rejected/reopened tickets for the ticket owner
        try {
          const ticketWhere: any = { userId: pgUserId, isDeleted: false };
          const recentTickets = await db().ticket.findMany({
            where: ticketWhere,
            orderBy: { updatedAt: 'desc' },
            take: 20,
            select: {
              id: true,
              mongoId: true,
              status: true,
              issueType: true,
              resolvedAt: true,
              resolvedBy: true,
              createdAt: true,
              updatedAt: true,
            },
          });

          for (const t of recentTickets) {
            const tid = String(t.mongoId || t.id);
            const status = String(t.status || '').trim();
            const issueType = String(t.issueType || 'Issue');
            const ts = safeIso(t.updatedAt) ?? safeIso(t.createdAt) ?? nowIso();

            if (status === 'Resolved') {
              notifications.push({
                id: `ticket:${tid}:resolved:${ts}`,
                type: 'success',
                title: 'Ticket resolved',
                message: `Your "${issueType}" ticket has been resolved.`,
                createdAt: ts,
              });
            } else if (status === 'Rejected') {
              notifications.push({
                id: `ticket:${tid}:rejected:${ts}`,
                type: 'alert',
                title: 'Ticket rejected',
                message: `Your "${issueType}" ticket was rejected. You can create a new ticket if the issue persists.`,
                createdAt: ts,
              });
            } else if (status === 'Open') {
              // Check if it was recently created (within the last 24h) to show confirmation
              const createdMs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
              if (createdMs && Date.now() - createdMs < 86_400_000) {
                notifications.push({
                  id: `ticket:${tid}:open:${ts}`,
                  type: 'info',
                  title: 'Ticket submitted',
                  message: `Your "${issueType}" ticket is being reviewed.`,
                  createdAt: ts,
                });
              }
            }
          }
        } catch (ticketErr) {
          // Don't break notifications if ticket query fails
          businessLog.warn('[notifications] Failed to load ticket notifications', { error: ticketErr });
        }

        // Sort newest-first and cap.
        notifications.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Notification',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'NOTIFICATIONS_LISTED', endpoint: 'notifications/list', resultCount: Math.min(notifications.length, 50), role: isShopper ? 'shopper' : isMediator ? 'mediator' : 'other' },
        });

        businessLog.info(`[${isShopper ? 'Buyer' : isMediator ? 'Mediator' : 'User'}] User ${userId} listed notifications — ${Math.min(notifications.length, 50)} results`, { actorUserId: userId, role: isShopper ? 'shopper' : isMediator ? 'mediator' : 'other', count: Math.min(notifications.length, 50), ip: req.ip });
        res.set('Cache-Control', 'private, max-age=30');
        res.json(notifications.slice(0, 50));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'notifications/list' } });
        next(err);
      }
    },
  };
}
