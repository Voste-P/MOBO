import { prisma as db } from '../database/prisma.js';
import { orderLog } from '../config/logger.js';
import { logErrorEvent, logChangeEvent } from '../config/appLogs.js';
import { ensureWallet, applyWalletDebit, applyWalletCredit } from './walletService.js';
import { pushOrderEvent } from './orderEvents.js';
import { transitionOrderWorkflow } from './orderWorkflow.js';
import { publishRealtime } from './realtimeHub.js';
import { idWhere } from '../utils/idWhere.js';
import type { Env } from '../config/env.js';
import type { Role } from '../middleware/auth.js';

const SYSTEM_ACTOR = 'system:cooling-settler';

/**
 * Settles a single order whose cooling period has expired.
 * Mirrors the manual settleOrderPayment logic — wallet debit/credit + workflow transitions.
 * Returns true if settled, false if skipped (disputed/frozen/already settled).
 */
async function settleOne(order: any, env: Env): Promise<boolean> {
  const orderDisplayId = order.mongoId ?? order.id;

  // Skip frozen orders
  if (order.frozen) {
    orderLog.info('[cooling-settler] Skipping frozen order', { orderId: orderDisplayId });
    return false;
  }

  // Skip if not in APPROVED workflow state
  if (order.workflowStatus !== 'APPROVED') {
    orderLog.info('[cooling-settler] Skipping non-APPROVED order', {
      orderId: orderDisplayId,
      workflowStatus: order.workflowStatus,
    });
    return false;
  }

  // Skip if there's an open dispute ticket
  const hasOpenDispute = await db().ticket.findFirst({
    where: { orderId: orderDisplayId, status: 'Open', isDeleted: false },
    select: { id: true },
  });
  if (hasOpenDispute) {
    const newEvents = pushOrderEvent(order.events as any, {
      type: 'FROZEN_DISPUTED',
      at: new Date(),
      actorUserId: SYSTEM_ACTOR,
      metadata: { reason: 'open_ticket', source: 'cooling-settler' },
    });
    await db().order.update({
      where: { id: order.id },
      data: { affiliateStatus: 'Frozen_Disputed', events: newEvents as any },
    });
    orderLog.info('[cooling-settler] Order frozen due to open dispute', { orderId: orderDisplayId });
    return false;
  }

  // Verify buyer is still active
  const buyer = await db().user.findUnique({
    where: { id: order.userId },
    select: { id: true, status: true, isDeleted: true },
  });
  if (!buyer || buyer.isDeleted || buyer.status !== 'active') {
    orderLog.warn('[cooling-settler] Buyer not active, skipping settlement', {
      orderId: orderDisplayId,
      buyerStatus: buyer?.status,
    });
    return false;
  }

  const campaignId = order.items?.[0]?.campaignId;
  const productId = String(order.items?.[0]?.productId || '').trim();
  const mediatorCode = String(order.managerName || '').trim();

  const campaign = campaignId
    ? await db().campaign.findFirst({
        where: { id: campaignId, isDeleted: false },
        select: { id: true, assignments: true, brandUserId: true },
      })
    : null;

  // Cap check
  let isOverLimit = false;
  if (campaignId && mediatorCode && campaign) {
    const assignmentsObj =
      campaign.assignments && typeof campaign.assignments === 'object'
        ? (campaign.assignments as any)
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

  // Wallet settlement (same atomic logic as manual settle)
  if (!isOverLimit && productId) {
    const deal = await db().deal.findFirst({
      where: { ...idWhere(productId), isDeleted: false },
      select: { id: true, payoutPaise: true },
    });
    if (!deal) {
      orderLog.warn('[cooling-settler] Deal not found, skipping', {
        orderId: orderDisplayId,
        productId,
      });
      return false;
    }

    const payoutPaise = Number(deal.payoutPaise ?? 0);
    const buyerCommissionPaise = Number(order.items?.[0]?.commissionPaise ?? 0);
    if (payoutPaise <= 0) {
      orderLog.warn('[cooling-settler] Invalid payout, skipping', {
        orderId: orderDisplayId,
        payoutPaise,
      });
      return false;
    }

    const buyerUserId = order.userId;
    const brandId = String(order.brandUserId || campaign?.brandUserId || '').trim();
    if (!buyerUserId || !brandId) {
      orderLog.warn('[cooling-settler] Missing buyer/brand, skipping', { orderId: orderDisplayId });
      return false;
    }

    await ensureWallet(brandId);
    await ensureWallet(buyerUserId);

    const mediatorMarginPaise = payoutPaise - buyerCommissionPaise;
    let mediatorUserId: string | null = null;
    if (mediatorMarginPaise > 0 && mediatorCode) {
      const mediator = await db().user.findFirst({
        where: { mediatorCode, isDeleted: false },
        select: { id: true },
      });
      if (mediator) {
        mediatorUserId = mediator.id;
        await ensureWallet(mediatorUserId);
      }
    }

    await db().$transaction(
      async (tx: any) => {
        await applyWalletDebit({
          idempotencyKey: `order-settlement-debit-${order.mongoId}`,
          type: 'order_settlement_debit',
          ownerUserId: brandId,
          fromUserId: brandId,
          toUserId: buyerUserId,
          amountPaise: payoutPaise,
          orderId: order.mongoId!,
          campaignId: campaignId ? String(campaignId) : undefined,
          metadata: { reason: 'ORDER_PAYOUT', dealId: productId, mediatorCode, source: 'cooling-settler' },
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
            metadata: { reason: 'ORDER_COMMISSION', dealId: productId, source: 'cooling-settler' },
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
            metadata: {
              reason: 'ORDER_MARGIN',
              dealId: productId,
              mediatorCode,
              source: 'cooling-settler',
            },
            tx,
          });
        }

        const newEvents = pushOrderEvent(order.events as any, {
          type: 'SETTLED',
          at: new Date(),
          actorUserId: SYSTEM_ACTOR,
          metadata: { settlementMode: 'wallet', source: 'cooling-settler' },
        });
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: 'Paid',
            affiliateStatus: 'Approved_Settled',
            settlementMode: 'wallet',
            events: newEvents as any,
          },
        });
      },
      { timeout: 15000 },
    );
  } else {
    // Cap-exceeded or missing product: update status without wallet movement
    const newEvents = pushOrderEvent(order.events as any, {
      type: isOverLimit ? 'CAP_EXCEEDED' : 'SETTLED',
      at: new Date(),
      actorUserId: SYSTEM_ACTOR,
      metadata: { source: 'cooling-settler' },
    });
    await db().order.update({
      where: { id: order.id },
      data: {
        paymentStatus: isOverLimit ? 'Failed' : 'Paid',
        affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled',
        events: newEvents as any,
      },
    });
  }

  // Workflow transitions: APPROVED → REWARD_PENDING → COMPLETED/FAILED
  await transitionOrderWorkflow({
    orderId: order.mongoId!,
    from: 'APPROVED',
    to: 'REWARD_PENDING',
    actorUserId: SYSTEM_ACTOR,
    metadata: { source: 'cooling-settler' },
    env,
  });

  await transitionOrderWorkflow({
    orderId: order.mongoId!,
    from: 'REWARD_PENDING',
    to: isOverLimit ? 'FAILED' : 'COMPLETED',
    actorUserId: SYSTEM_ACTOR,
    metadata: {
      affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled',
      source: 'cooling-settler',
    },
    env,
  });

  // Realtime notifications
  const privilegedRoles: Role[] = ['admin', 'ops'];
  const audience: { roles?: Role[]; userIds?: string[] } = { roles: privilegedRoles, userIds: [] };
  const [buyerUser, brandUser] = await Promise.all([
    order.userId ? db().user.findUnique({ where: { id: order.userId }, select: { mongoId: true } }) : null,
    order.brandUserId ? db().user.findUnique({ where: { id: order.brandUserId }, select: { mongoId: true } }) : null,
  ]);
  if (buyerUser?.mongoId) audience.userIds!.push(buyerUser.mongoId);
  if (brandUser?.mongoId) audience.userIds!.push(brandUser.mongoId);

  publishRealtime({ type: 'orders.changed', ts: new Date().toISOString(), audience });
  publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });
  publishRealtime({ type: 'wallets.changed', ts: new Date().toISOString(), audience });

  orderLog.info('[cooling-settler] Order auto-settled', {
    orderId: orderDisplayId,
    isOverLimit,
    affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled',
  });
  logChangeEvent({
    actorUserId: SYSTEM_ACTOR,
    entityType: 'Order',
    entityId: orderDisplayId,
    action: 'STATUS_CHANGE',
    changedFields: ['paymentStatus', 'affiliateStatus'],
    after: {
      paymentStatus: isOverLimit ? 'Failed' : 'Paid',
      affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled',
    },
    metadata: { source: 'cooling-settler' },
  });

  return true;
}

/**
 * Process all orders whose cooling period has expired.
 * Called periodically from the server startup interval.
 * Processes orders in batches to avoid memory spikes.
 */
export async function processCoolingPeriodSettlements(env: Env): Promise<{ settled: number; skipped: number; errors: number }> {
  const BATCH_SIZE = 50;
  let settled = 0;
  let skipped = 0;
  let errors = 0;

  orderLog.info('[cooling-settler] Starting cooling period settlement run');

  // Find orders past their cooling period that haven't been settled
  const orders = await db().order.findMany({
    where: {
      affiliateStatus: 'Pending_Cooling',
      workflowStatus: 'APPROVED',
      expectedSettlementDate: { lte: new Date() },
      frozen: false,
      isDeleted: false,
    },
    include: { items: { where: { isDeleted: false } } },
    take: BATCH_SIZE,
    orderBy: { expectedSettlementDate: 'asc' },
  });

  if (orders.length === 0) {
    orderLog.info('[cooling-settler] No orders ready for settlement');
    return { settled, skipped, errors };
  }

  orderLog.info(`[cooling-settler] Found ${orders.length} orders ready for settlement`);

  for (const order of orders) {
    try {
      const didSettle = await settleOne(order, env);
      if (didSettle) settled++;
      else skipped++;
    } catch (err) {
      errors++;
      logErrorEvent({
        error: err instanceof Error ? err : new Error(String(err)),
        message: `[cooling-settler] Failed to settle order ${order.mongoId ?? order.id}`,
        category: 'BUSINESS_LOGIC',
        severity: 'high',
        metadata: { orderId: order.mongoId ?? order.id, handler: 'coolingPeriodSettler' },
      });
    }
  }

  orderLog.info('[cooling-settler] Settlement run complete', { settled, skipped, errors, total: orders.length });
  return { settled, skipped, errors };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Start the cooling period settlement loop. Call once at server startup. */
export function startCoolingPeriodSettler(env: Env, intervalMs = 60 * 60 * 1000): void {
  if (intervalHandle) return; // already started

  // Run once immediately after a short delay (let server fully start)
  const startupDelay = setTimeout(() => {
    void processCoolingPeriodSettlements(env);
  }, 30_000);
  startupDelay.unref();

  // Then run periodically (default: every hour)
  intervalHandle = setInterval(() => {
    void processCoolingPeriodSettlements(env);
  }, intervalMs);
  intervalHandle.unref(); // don't prevent graceful shutdown
  orderLog.info(`[cooling-settler] Scheduled every ${Math.round(intervalMs / 60000)}min`);
}

/** Stop the settlement loop (call during graceful shutdown). */
export function stopCoolingPeriodSettler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
