import { randomUUID } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { AppError } from '../middleware/errors.js';
import { writeAuditLog } from './audit.js';
import { walletLog } from '../config/logger.js';
import { logChangeEvent, logErrorEvent } from '../config/appLogs.js';

/** Re-export the union so callers don't have to change imports. */
export type TransactionType =
  | 'brand_deposit' | 'platform_fee'
  | 'commission_lock' | 'commission_settle'
  | 'cashback_lock' | 'cashback_settle'
  | 'order_settlement_debit'
  | 'commission_reversal' | 'margin_reversal'
  | 'agency_payout' | 'agency_receipt'
  | 'payout_request' | 'payout_complete' | 'payout_failed'
  | 'refund';

export type WalletMutationInput = {
  idempotencyKey: string;
  type: TransactionType;
  /** PG UUID of the wallet owner */
  ownerUserId: string;
  amountPaise: number;
  fromUserId?: string;
  toUserId?: string;
  orderId?: string;
  campaignId?: string;
  payoutId?: string;
  metadata?: unknown;
  /** When provided, the caller owns the Prisma interactive transaction. */
  tx?: any;
};

/**
 * Concurrency-safe wallet creation via Prisma upsert.
 * @param ownerUserId PG UUID of the user
 */
export async function ensureWallet(ownerUserId: string) {
  const db = prisma();
  try {
    return await db.wallet.upsert({
      where: { ownerUserId },
      update: {},
      create: {
        mongoId: randomUUID(),
        ownerUserId,
        currency: 'INR',
        availablePaise: 0,
        pendingPaise: 0,
        lockedPaise: 0,
        version: 0,
      },
    });
  } catch (err: any) {
    // Handle P2002 (unique constraint violation)
    if (err?.code === 'P2002') {
      const existing = await db.wallet.findUnique({ where: { ownerUserId } });
      if (existing) return existing;
    }
    throw err;
  }
}

export async function applyWalletCredit(input: WalletMutationInput) {
  if (input.amountPaise <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be positive');
  if (!Number.isInteger(input.amountPaise)) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be an integer (paise)');

  walletLog.info('Wallet credit initiated', { userId: input.ownerUserId, type: input.type, amountPaise: input.amountPaise, key: input.idempotencyKey, orderId: input.orderId, campaignId: input.campaignId });

  const execute = async (tx: any) => {
    // Idempotency: if a transaction with this key already exists, return it.
    const existingTx = await tx.transaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existingTx) {
      walletLog.info('Wallet credit idempotency hit (duplicate key)', { userId: input.ownerUserId, type: input.type, key: input.idempotencyKey });
      return existingTx;
    }

    // Safety limit: prevent runaway balances (default 1 crore paise = ₹1,00,000).
    const MAX_BALANCE_PAISE = Number(process.env.WALLET_MAX_BALANCE_PAISE) || 1_00_00_000;

    // Ensure wallet exists first
    await tx.wallet.upsert({
      where: { ownerUserId: input.ownerUserId },
      update: {},
      create: {
        mongoId: randomUUID(),
        ownerUserId: input.ownerUserId,
        currency: 'INR',
        availablePaise: 0,
        pendingPaise: 0,
        lockedPaise: 0,
        version: 0,
      },
    });

    // Atomic credit with max-balance ceiling check via updateMany.
    // This prevents the race condition where two concurrent credits both pass
    // a read-then-write check and exceed the wallet limit.
    const updated = await tx.wallet.updateMany({
      where: {
        ownerUserId: input.ownerUserId,
        isDeleted: false,
        availablePaise: { lte: MAX_BALANCE_PAISE - input.amountPaise },
      },
      data: {
        availablePaise: { increment: input.amountPaise },
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // Distinguish wallet-not-found from limit exceeded
      const existing = await tx.wallet.findUnique({ where: { ownerUserId: input.ownerUserId } });
      if (!existing || existing.isDeleted) {
        logErrorEvent({ category: 'BUSINESS_LOGIC', severity: 'high', message: 'Wallet credit failed — wallet not found', operation: 'applyWalletCredit', userId: input.ownerUserId, metadata: { type: input.type, amountPaise: input.amountPaise } });
        throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
      }
      logErrorEvent({ category: 'BUSINESS_LOGIC', severity: 'medium', message: 'Wallet credit failed — balance limit exceeded', operation: 'applyWalletCredit', userId: input.ownerUserId, metadata: { type: input.type, amountPaise: input.amountPaise } });
      throw new AppError(409, 'BALANCE_LIMIT_EXCEEDED', 'Wallet balance limit exceeded');
    }

    // Re-read wallet to get walletId for the transaction record
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: input.ownerUserId } });

    const txn = await tx.transaction.create({
      data: {
        mongoId: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        type: input.type as any,
        status: 'completed',
        amountPaise: input.amountPaise,
        currency: 'INR',
        walletId: wallet.id,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        orderId: input.orderId,
        campaignId: input.campaignId,
        payoutId: input.payoutId,
        metadata: input.metadata as any,
      },
    });

    walletLog.info('Wallet credit completed', { userId: input.ownerUserId, type: input.type, amountPaise: input.amountPaise, txnId: txn.id, walletId: wallet?.id });
    return txn;
  };

  // If the caller provides an external tx, run within it (no new transaction).
  if (input.tx) {
    const result = await execute(input.tx);
    logChangeEvent({ actorUserId: input.fromUserId, entityType: 'Wallet', entityId: input.ownerUserId, action: 'UPDATE', changedFields: ['availablePaise'], metadata: { operation: 'CREDIT', amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey, orderId: input.orderId } });
    writeAuditLog({ action: 'WALLET_CREDIT', entityType: 'Wallet', entityId: input.ownerUserId, metadata: { amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey } });
    return result;
  }

  const db = prisma();
  const result = await db.$transaction(async (tx) => execute(tx));
  logChangeEvent({ actorUserId: input.fromUserId, entityType: 'Wallet', entityId: input.ownerUserId, action: 'UPDATE', changedFields: ['availablePaise'], metadata: { operation: 'CREDIT', amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey, orderId: input.orderId } });
  writeAuditLog({ action: 'WALLET_CREDIT', entityType: 'Wallet', entityId: input.ownerUserId, metadata: { amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey } });
  return result;
}

export async function applyWalletDebit(input: WalletMutationInput) {
  if (input.amountPaise <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be positive');
  if (!Number.isInteger(input.amountPaise)) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be an integer (paise)');

  walletLog.info('Wallet debit initiated', { userId: input.ownerUserId, type: input.type, amountPaise: input.amountPaise, key: input.idempotencyKey, orderId: input.orderId, campaignId: input.campaignId });

  const execute = async (tx: any) => {
    // Idempotency: if a transaction with this key already exists, return it.
    const existingTx = await tx.transaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existingTx) {
      walletLog.info('Wallet debit idempotency hit (duplicate key)', { userId: input.ownerUserId, type: input.type, key: input.idempotencyKey });
      return existingTx;
    }

    // Atomic debit with balance-floor check via updateMany
    const updated = await tx.wallet.updateMany({
      where: {
        ownerUserId: input.ownerUserId,
        isDeleted: false,
        availablePaise: { gte: input.amountPaise },
      },
      data: {
        availablePaise: { decrement: input.amountPaise },
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // Distinguish wallet-not-found from insufficient-funds
      const existing = await tx.wallet.findUnique({
        where: { ownerUserId: input.ownerUserId },
      });
      if (!existing || existing.isDeleted) {
        logErrorEvent({ category: 'BUSINESS_LOGIC', severity: 'high', message: 'Wallet debit failed — wallet not found', operation: 'applyWalletDebit', userId: input.ownerUserId, metadata: { type: input.type, amountPaise: input.amountPaise } });
        throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
      }
      logErrorEvent({ category: 'BUSINESS_LOGIC', severity: 'medium', message: 'Wallet debit failed — insufficient funds', operation: 'applyWalletDebit', userId: input.ownerUserId, metadata: { type: input.type, amountPaise: input.amountPaise, available: existing.availablePaise } });
      throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Insufficient available balance');
    }

    // Re-read wallet to get the walletId for the transaction record
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: input.ownerUserId } });

    const txn = await tx.transaction.create({
      data: {
        mongoId: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        type: input.type as any,
        status: 'completed',
        amountPaise: input.amountPaise,
        currency: 'INR',
        walletId: wallet?.id,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        orderId: input.orderId,
        campaignId: input.campaignId,
        payoutId: input.payoutId,
        metadata: input.metadata as any,
      },
    });

    return txn;
  };

  // If the caller provides an external tx, run within it (no new transaction).
  if (input.tx) {
    const result = await execute(input.tx);
    walletLog.info('Wallet debit completed', { userId: input.ownerUserId, type: input.type, amountPaise: input.amountPaise, txnId: result.id });
    logChangeEvent({ actorUserId: input.toUserId, entityType: 'Wallet', entityId: input.ownerUserId, action: 'UPDATE', changedFields: ['availablePaise'], metadata: { operation: 'DEBIT', amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey, orderId: input.orderId } });
    writeAuditLog({ action: 'WALLET_DEBIT', entityType: 'Wallet', entityId: input.ownerUserId, metadata: { amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey } });
    return result;
  }

  const db = prisma();
  const result = await db.$transaction(async (tx) => execute(tx));
  walletLog.info('Wallet debit completed', { userId: input.ownerUserId, type: input.type, amountPaise: input.amountPaise, txnId: result.id });
  logChangeEvent({ actorUserId: input.toUserId, entityType: 'Wallet', entityId: input.ownerUserId, action: 'UPDATE', changedFields: ['availablePaise'], metadata: { operation: 'DEBIT', amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey, orderId: input.orderId } });
  writeAuditLog({ action: 'WALLET_DEBIT', entityType: 'Wallet', entityId: input.ownerUserId, metadata: { amountPaise: input.amountPaise, type: input.type, idempotencyKey: input.idempotencyKey } });
  return result;
}
