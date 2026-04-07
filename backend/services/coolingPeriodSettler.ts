import { prisma as db } from '../database/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
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

/** Prefetched batch data to eliminate N+1 queries in settlement loop. */
interface SettlePrefetch {
  disputeOrderIds: Set<string | null>;
  campaignMap: Map<string, { id: string; assignments: any; brandUserId: string }>;
  dealMap: Map<string, { id: string; payoutPaise: number }>;
  userMap: Map<string, { id: string; status: string; isDeleted: boolean }>;
  mediatorMap: Map<string, { id: string; mediatorCode: string | null }>;
  /** Batch cap counts: "mediatorCode::campaignId" -> count of already settled orders */
  capCountMap: Map<string, number>;
}

/**
 * Settles a single order whose cooling period has expired.
 * Mirrors the manual settleOrderPayment logic — wallet debit/credit + workflow transitions.
 * Returns true if settled, false if skipped (disputed/frozen/already settled).
 */
async function settleOne(order: any, env: Env, prefetch?: SettlePrefetch): Promise<boolean> {
  const orderDisplayId = order.id ?? order.id;

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

  // ── Atomic claim: prevent double-settlement from concurrent cron invocations ──
  // Set updatedBy to claim this order; concurrent settlers will see the claim and skip.
  const claimed = await db().order.updateMany({
    where: {
      id: order.id,
      workflowStatus: 'APPROVED',
      affiliateStatus: 'Pending_Cooling',
      frozen: false,
      isDeleted: false,
      updatedBy: { not: SYSTEM_ACTOR },
    },
    data: { updatedBy: SYSTEM_ACTOR },
  });
  if (claimed.count === 0) {
    orderLog.info('[cooling-settler] Order already claimed by another settler', { orderId: orderDisplayId });
    return false;
  }

  // Skip if there's an open dispute ticket (use prefetch if available)
  const hasOpenDispute = prefetch
    ? prefetch.disputeOrderIds.has(orderDisplayId)
    : !!(await db().ticket.findFirst({
        where: { orderId: orderDisplayId, status: 'Open', isDeleted: false },
        select: { id: true },
      }));
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

  // Verify buyer is still active (use prefetch if available)
  const buyer = prefetch
    ? (prefetch.userMap.get(order.userId) ?? null)
    : await db().user.findUnique({
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
    ? (prefetch
        ? (prefetch.campaignMap.get(campaignId) ?? null)
        : await db().campaign.findFirst({
            where: { id: campaignId, isDeleted: false },
            select: { id: true, assignments: true, brandUserId: true },
          }))
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
      const capKey = `${mediatorCode}::${campaignId}`;
      const settledCount = prefetch?.capCountMap.has(capKey)
        ? prefetch.capCountMap.get(capKey)!
        : await db().order.count({
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
    const deal = prefetch
      ? (prefetch.dealMap.get(productId) ?? null)
      : await db().deal.findFirst({
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
      const mediator = prefetch
        ? (prefetch.mediatorMap.get(mediatorCode) ?? null)
        : await db().user.findFirst({
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
          idempotencyKey: `order-settlement-debit-${order.id}`,
          type: 'order_settlement_debit',
          ownerUserId: brandId,
          fromUserId: brandId,
          toUserId: buyerUserId,
          amountPaise: payoutPaise,
          orderId: order.id!,
          campaignId: campaignId ? String(campaignId) : undefined,
          metadata: { reason: 'ORDER_PAYOUT', dealId: productId, mediatorCode, source: 'cooling-settler' },
          tx,
        });

        if (buyerCommissionPaise > 0) {
          await applyWalletCredit({
            idempotencyKey: `order-commission-${order.id}`,
            type: 'commission_settle',
            ownerUserId: buyerUserId,
            amountPaise: buyerCommissionPaise,
            orderId: order.id!,
            campaignId: campaignId ? String(campaignId) : undefined,
            metadata: { reason: 'ORDER_COMMISSION', dealId: productId, source: 'cooling-settler' },
            tx,
          });
        }

        if (mediatorUserId && mediatorMarginPaise > 0) {
          await applyWalletCredit({
            idempotencyKey: `order-margin-${order.id}`,
            type: 'commission_settle',
            ownerUserId: mediatorUserId,
            amountPaise: mediatorMarginPaise,
            orderId: order.id!,
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
      { timeout: env.SETTLER_TX_TIMEOUT_MS },
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
    orderId: order.id!,
    from: 'APPROVED',
    to: 'REWARD_PENDING',
    actorUserId: SYSTEM_ACTOR,
    metadata: { source: 'cooling-settler' },
    env,
  });

  await transitionOrderWorkflow({
    orderId: order.id!,
    from: 'REWARD_PENDING',
    to: isOverLimit ? 'FAILED' : 'COMPLETED',
    actorUserId: SYSTEM_ACTOR,
    metadata: {
      affiliateStatus: isOverLimit ? 'Cap_Exceeded' : 'Approved_Settled',
      source: 'cooling-settler',
    },
    env,
  });

  // Realtime notifications — use prefetched user data when available
  const privilegedRoles: Role[] = ['admin', 'ops'];
  const audience: { roles?: Role[]; userIds?: string[] } = { roles: privilegedRoles, userIds: [] };
  const buyerUser = prefetch
    ? (prefetch.userMap.get(order.userId) ?? null)
    : order.userId ? await db().user.findUnique({ where: { id: order.userId }, select: { id: true } }) : null;
  const brandUser = prefetch
    ? (order.brandUserId ? (prefetch.userMap.get(order.brandUserId) ?? null) : null)
    : order.brandUserId ? await db().user.findUnique({ where: { id: order.brandUserId }, select: { id: true } }) : null;
  if (buyerUser?.id) audience.userIds!.push(buyerUser.id);
  if (brandUser?.id) audience.userIds!.push(brandUser.id);

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
  const MAX_BATCHES = 20; // Safety cap: process at most 1000 orders per run
  let settled = 0;
  let skipped = 0;
  let errors = 0;

  orderLog.info('[cooling-settler] Starting cooling period settlement run');

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
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
    if (batch === 0) orderLog.info('[cooling-settler] No orders ready for settlement');
    break; // No more orders to process
  }

  orderLog.info(`[cooling-settler] Found ${orders.length} orders ready for settlement`);

  // ── Batch prefetch: load all related data in parallel to eliminate N+1 queries ──
  const orderIds = orders.map(o => o.id ?? o.id);
  const campaignIds = [...new Set(orders.map(o => o.items?.[0]?.campaignId).filter(Boolean))] as string[];
  const productIds = [...new Set(orders.map(o => String(o.items?.[0]?.productId || '').trim()).filter(Boolean))];
  const userIds = [...new Set(orders.flatMap(o => [o.userId, o.brandUserId].filter(Boolean)))] as string[];
  const mediatorCodes = [...new Set(orders.map(o => String(o.managerName || '').trim()).filter(Boolean))];

  const [disputes, campaignsArr, dealsArr, usersArr, mediatorsArr] = await Promise.all([
    // Batch dispute check: find all open dispute tickets for these orders
    db().ticket.findMany({
      where: { orderId: { in: orderIds }, status: 'Open', isDeleted: false },
      select: { orderId: true },
    }),
    // Batch campaign lookup
    campaignIds.length > 0
      ? db().campaign.findMany({
          where: { id: { in: campaignIds }, isDeleted: false },
          select: { id: true, assignments: true, brandUserId: true },
        })
      : [],
    // Batch deal lookup
    productIds.length > 0
      ? db().deal.findMany({
          where: { id: { in: productIds }, isDeleted: false },
          select: { id: true, payoutPaise: true },
        }).then(async (byId) => {
          return byId;
        })
      : [],
    // Batch user lookup (buyers + brands)
    userIds.length > 0
      ? db().user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, status: true, isDeleted: true },
        })
      : [],
    // Batch mediator lookup
    mediatorCodes.length > 0
      ? db().user.findMany({
          where: { mediatorCode: { in: mediatorCodes }, isDeleted: false },
          select: { id: true, mediatorCode: true },
        })
      : [],
  ]);

  // Build lookup maps for O(1) access during settlement
  const disputeOrderIds = new Set(disputes.map(t => t.orderId));
  const campaignMap = new Map(campaignsArr.map(c => [c.id, c]));
  const dealMap = new Map(dealsArr.map(d => [d.id ?? d.id, d]));
  const userMap = new Map(usersArr.map(u => [u.id, u]));
  const mediatorMap = new Map(mediatorsArr.map(m => [m.mediatorCode!, m]));

  // Batch cap counts: single GROUP BY aggregate instead of N individual count queries
  const capPairs = [...new Set(
    orders
      .filter(o => o.managerName && o.items?.[0]?.campaignId)
      .map(o => `${String(o.managerName).trim()}::${o.items![0].campaignId}`),
  )];
  const capCountMap = new Map<string, number>();
  if (capPairs.length > 0) {
    const mcCodes = [...new Set(capPairs.map(p => p.split('::')[0]))];
    const cids = [...new Set(capPairs.map(p => p.split('::')[1]))];
    const rows = await db().$queryRaw<Array<{ manager_name: string; campaign_id: string; cnt: bigint }>>(
      Prisma.sql`
        SELECT o."managerName" AS manager_name, oi."campaignId" AS campaign_id, COUNT(DISTINCT o.id)::bigint AS cnt
        FROM "Order" o
        JOIN "OrderItem" oi ON oi."orderId" = o.id AND oi."isDeleted" = false
        WHERE o."managerName" IN (${Prisma.join(mcCodes)})
          AND oi."campaignId" IN (${Prisma.join(cids)})
          AND (o."affiliateStatus" = 'Approved_Settled' OR o."paymentStatus" = 'Paid')
          AND o."isDeleted" = false
        GROUP BY o."managerName", oi."campaignId"
      `
    );
    for (const r of rows) {
      capCountMap.set(`${r.manager_name}::${r.campaign_id}`, Number(r.cnt));
    }
  }

  // Attach prefetched data to a context object passed into settleOne
  const prefetch = { disputeOrderIds, campaignMap, dealMap, userMap, mediatorMap, capCountMap };

  for (const order of orders) {
    const orderId = order.id ?? order.id;
    // Retry up to 2 times on transient DB errors (connection, timeout, deadlock)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const didSettle = await settleOne(order, env, prefetch);
        if (didSettle) settled++;
        else skipped++;
        break;
      } catch (err: any) {
        const code = err?.code ?? '';
        const isTransient = code === 'P1017' || code === 'P1001' || code === 'P1008' || code === 'P2034'
          || (err?.message && /deadlock|timeout|connection/i.test(err.message));
        if (isTransient && attempt < 2) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        errors++;
        logErrorEvent({
          error: err instanceof Error ? err : new Error(String(err)),
          message: `[cooling-settler] Failed to settle order ${orderId}` + (attempt > 0 ? ` (after ${attempt + 1} attempts)` : ''),
          category: 'BUSINESS_LOGIC',
          severity: 'high',
          metadata: { orderId, handler: 'coolingPeriodSettler', attempts: attempt + 1 },
        });
        break;
      }
    }
  }

  // If this batch was smaller than BATCH_SIZE, no more orders remain
  if (orders.length < BATCH_SIZE) break;
  } // end batch loop

  orderLog.info('[cooling-settler] Settlement run complete', { settled, skipped, errors });
  return { settled, skipped, errors };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Start the cooling period settlement loop. Call once at server startup. */
export function startCoolingPeriodSettler(env: Env, intervalMs?: number): void {
  const interval = intervalMs ?? env.SETTLER_INTERVAL_MS;
  if (intervalHandle) return; // already started

  // Run once immediately after a short delay (let server fully start)
  const startupDelay = setTimeout(() => {
    void processCoolingPeriodSettlements(env);
  }, 30_000);
  startupDelay.unref();

  // Then run periodically (default: every 15 minutes for faster settlements)
  intervalHandle = setInterval(() => {
    void processCoolingPeriodSettlements(env);
  }, interval);
  intervalHandle.unref(); // don't prevent graceful shutdown
  orderLog.info(`[cooling-settler] Scheduled every ${Math.round(interval / 60000)}min`);
}

/** Stop the settlement loop (call during graceful shutdown). */
export function stopCoolingPeriodSettler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
