import type { Migration } from './types.js';

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (value as any)[key];
          return acc;
        }, {});
    }
    return value;
  });
}

async function findDuplicateKeys(opts: {
  db: any;
  collection: string;
  match: Record<string, unknown>;
  groupId: Record<string, unknown>;
  limit?: number;
}): Promise<Array<{ _id: unknown; count: number }>> {
  const limit = opts.limit ?? 10;

  const rows = await opts.db
    .collection(opts.collection)
    .aggregate([
      { $match: opts.match },
      { $group: { _id: opts.groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ])
    .toArray();

  return rows as Array<{ _id: unknown; count: number }>;
}

async function ensureIndex(opts: {
  db: any;
  collection: string;
  keys: Record<string, 1 | -1>;
  options?: Record<string, any>;
  dropIfOptionsConflict?: boolean;
  knownOldNamesToDrop?: string[];
}): Promise<void> {
  const coll = opts.db.collection(opts.collection);
  const name = (opts.options?.name as string | undefined) ?? undefined;

  if (opts.knownOldNamesToDrop?.length) {
    const existing = await coll.indexes();
    const existingNames = new Set((existing as Array<{ name: string }>).map((i) => i.name));
    for (const oldName of opts.knownOldNamesToDrop) {
      if (existingNames.has(oldName)) {
        await coll.dropIndex(oldName);
      }
    }
  }

  try {
    await coll.createIndex(opts.keys, opts.options);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const isOptionsConflict =
      msg.includes('IndexOptionsConflict') ||
      msg.includes('already exists with different options') ||
      msg.includes('equivalent index already exists');

    if (!opts.dropIfOptionsConflict || !isOptionsConflict) throw err;

    // If we get here, we intentionally replace the existing index.
    // Prefer dropping by explicit name (if provided), otherwise fall back to the default name.
    const defaultName = Object.entries(opts.keys)
      .map(([k, dir]) => `${k}_${dir}`)
      .join('_');
    const dropName = name ?? defaultName;

    await coll.dropIndex(dropName);
    await coll.createIndex(opts.keys, opts.options);
  }
}

export const m20260108_indexes_softdelete_unique: Migration = {
  id: '2026-01-08-indexes-softdelete-unique',
  description:
    'Ensure soft-delete-safe unique indexes for Users/Wallets/Transactions/Payouts (create/replace as needed)',
  async up(ctx) {
    const { db, log } = ctx;

    // Preflight duplicate checks so unique index creation fails with actionable info.
    // Note: these checks only look at "active" docs (isDeleted is null or missing), matching our partial indexes.
    const dupUserMobile = await findDuplicateKeys({
      db,
      collection: 'users',
      match: { isDeleted: false, mobile: { $type: 'string' } },
      groupId: { mobile: '$mobile' },
    });
    if (dupUserMobile.length) {
      throw new Error(
        `Cannot create unique users.mobile index: found duplicates (sample): ${stableStringify(dupUserMobile)}`
      );
    }

    const dupUserEmail = await findDuplicateKeys({
      db,
      collection: 'users',
      match: { isDeleted: false, email: { $type: 'string' } },
      groupId: { email: '$email' },
    });
    if (dupUserEmail.length) {
      throw new Error(
        `Cannot create unique users.email index: found duplicates (sample): ${stableStringify(dupUserEmail)}`
      );
    }

    const dupMediatorCode = await findDuplicateKeys({
      db,
      collection: 'users',
      match: { isDeleted: false, mediatorCode: { $type: 'string' } },
      groupId: { mediatorCode: '$mediatorCode' },
    });
    if (dupMediatorCode.length) {
      throw new Error(
        `Cannot create unique users.mediatorCode index: found duplicates (sample): ${stableStringify(dupMediatorCode)}`
      );
    }

    const dupWalletOwner = await findDuplicateKeys({
      db,
      collection: 'wallets',
      match: { isDeleted: false, ownerUserId: { $exists: true } },
      groupId: { ownerUserId: '$ownerUserId' },
    });
    if (dupWalletOwner.length) {
      throw new Error(
        `Cannot create unique wallets.ownerUserId index: found duplicates (sample): ${stableStringify(dupWalletOwner)}`
      );
    }

    const dupTxIdempotency = await findDuplicateKeys({
      db,
      collection: 'transactions',
      match: { isDeleted: false, idempotencyKey: { $type: 'string' } },
      groupId: { idempotencyKey: '$idempotencyKey' },
    });
    if (dupTxIdempotency.length) {
      throw new Error(
        `Cannot create unique transactions.idempotencyKey index: found duplicates (sample): ${stableStringify(
          dupTxIdempotency
        )}`
      );
    }

    const dupPayoutProviderRef = await findDuplicateKeys({
      db,
      collection: 'payouts',
      match: {
        isDeleted: false,
        provider: { $type: 'string' },
        providerRef: { $type: 'string' },
      },
      groupId: { provider: '$provider', providerRef: '$providerRef' },
    });
    if (dupPayoutProviderRef.length) {
      throw new Error(
        `Cannot create unique payouts(provider,providerRef) index: found duplicates (sample): ${stableStringify(
          dupPayoutProviderRef
        )}`
      );
    }

    log('Ensuring Users indexes...');
    await ensureIndex({
      db,
      collection: 'users',
      keys: { mobile: 1 },
      options: {
        unique: true,
        partialFilterExpression: { isDeleted: false },
      },
      dropIfOptionsConflict: true,
    });

    await ensureIndex({
      db,
      collection: 'users',
      keys: { email: 1 },
      options: {
        unique: true,
        partialFilterExpression: { isDeleted: false, email: { $type: 'string' } },
      },
      dropIfOptionsConflict: true,
    });

    await ensureIndex({
      db,
      collection: 'users',
      keys: { mediatorCode: 1 },
      options: {
        unique: true,
        partialFilterExpression: { isDeleted: false, mediatorCode: { $type: 'string' } },
      },
      dropIfOptionsConflict: true,
    });

    await ensureIndex({
      db,
      collection: 'users',
      keys: { brandCode: 1 },
      options: {
        partialFilterExpression: { isDeleted: false, brandCode: { $type: 'string' } },
      },
      dropIfOptionsConflict: true,
    });

    await ensureIndex({
      db,
      collection: 'users',
      keys: { brandCode: 1, roles: 1, isDeleted: 1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'users',
      keys: { mediatorCode: 1, roles: 1, isDeleted: 1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'users',
      keys: { roles: 1, status: 1, isDeleted: 1 },
      dropIfOptionsConflict: false,
    });

    log('Ensuring Wallets indexes...');
    await ensureIndex({
      db,
      collection: 'wallets',
      keys: { isDeleted: 1, createdAt: -1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'wallets',
      keys: { ownerUserId: 1 },
      options: {
        unique: true,
        partialFilterExpression: { isDeleted: false },
      },
      dropIfOptionsConflict: true,
    });

    log('Ensuring Transactions indexes...');
    await ensureIndex({
      db,
      collection: 'transactions',
      keys: { status: 1, type: 1, createdAt: -1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'transactions',
      keys: { isDeleted: 1, createdAt: -1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'transactions',
      keys: { walletId: 1, createdAt: -1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'transactions',
      keys: { idempotencyKey: 1 },
      options: {
        unique: true,
        partialFilterExpression: { isDeleted: false },
      },
      dropIfOptionsConflict: true,
    });

    log('Ensuring Payouts indexes...');
    await ensureIndex({
      db,
      collection: 'payouts',
      keys: { status: 1, requestedAt: -1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'payouts',
      keys: { beneficiaryUserId: 1, requestedAt: -1 },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'payouts',
      keys: { providerRef: 1 },
      options: { sparse: true },
      dropIfOptionsConflict: false,
    });

    await ensureIndex({
      db,
      collection: 'payouts',
      keys: { provider: 1, providerRef: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          isDeleted: false,
          provider: { $type: 'string' },
          providerRef: { $type: 'string' },
        },
      },
      dropIfOptionsConflict: true,
    });
  },
};
