# Money Flow (Current Implementation)

This document maps the _current_ money primitives and flows in the backend. It is a snapshot to support auditing and next-step hardening (conservation, idempotency, RBAC, and reconciliation).

## Primitives

- Wallet (Prisma model `Wallet`)
  - Fields: `availablePaise`, `pendingPaise`, `lockedPaise` (today only `availablePaise` is mutated in code paths found).
  - Uniqueness: one wallet per user (`is_deleted`-aware unique index).

- Transaction (Prisma model `Transaction`)
  - Immutable ledger entry for wallet mutations.
  - Strong idempotency: `idempotencyKey` is unique (`is_deleted`-aware).
  - Types (enum): `brand_deposit`, `agency_payout`, `agency_receipt`, `commission_settle`, `payout_complete`, ... (many are defined but currently unused).

- Wallet mutation service ([backend/services/walletService.ts](../backend/services/walletService.ts))
  - `applyWalletCredit(...)`: increments `availablePaise` and inserts a `Transaction`.
  - `applyWalletDebit(...)`: decrements `availablePaise` (requires sufficient balance) and inserts a `Transaction`.
  - Both are wrapped in a database transaction and are idempotent via `Transaction.idempotencyKey`.

## Flows found in code

### 1) Brand funding (test/E2E seed)

- Creates a positive balance for a brand wallet.
- Implementation: `applyWalletCredit({ type: 'brand_deposit', ownerUserId: brandId, ... })`
- Surface: not currently exposed as a production API route.

### 2) Brand -> Agency payout (brand portal)

Endpoint: `POST /api/brand/payout`

- Preconditions:
  - Brand must be active.
  - Agency must be active.
  - For non-privileged callers: agency must be connected to the brand.
  - Requires a `ref` (used in idempotency key).

- Money moves:
  - Debit brand wallet: `applyWalletDebit({ type: 'agency_payout', ownerUserId: brandId, fromUserId: brandId, toUserId: agencyId, idempotencyKey: brand_agency_payout:<brand>:<agency>:<ref> })`
  - Credit agency wallet: `applyWalletCredit({ type: 'agency_receipt', ownerUserId: agencyId, fromUserId: brandId, toUserId: agencyId, idempotencyKey: <same>:credit })`

Notes:

- This flow is double-click safe (idempotent keys).
- Debit happens first; credit only occurs after a successful debit.

### 3) Order settlement credits (ops)

Endpoint: `POST /api/ops/orders/settle` (admin/ops only)

- Preconditions:
  - Order must be `workflowStatus == 'APPROVED'` and not frozen.
  - Must have no open dispute ticket.
  - Upstream mediator/agency must be active.

- Money moves (when order is not cap-exceeded):
  - Debit brand wallet by deal payout: `applyWalletDebit({ type: 'order_settlement_debit', ownerUserId: brandId, amountPaise: deal.payoutPaise, idempotencyKey: order-settlement-debit-<orderId> })`
  - Credit buyer commission: `applyWalletCredit({ type: 'commission_settle', ownerUserId: buyerUserId, amountPaise: commissionPaise, idempotencyKey: order-commission-<orderId> })`
  - Credit mediator margin: `applyWalletCredit({ type: 'commission_settle', ownerUserId: mediatorUserId, amountPaise: (deal.payoutPaise - commissionPaise), idempotencyKey: order-margin-<orderId> })`

Conservation note:

- With the brand debit in place, settlement is conservation-safe for orders that have resolvable brand ownership.

### 4) Mediator payout withdrawal (ops)

Endpoint: `POST /api/ops/payouts` (admin/ops only)

- Creates a `Payout` with status `paid`.
- Debits beneficiary wallet: `applyWalletDebit({ type: 'payout_complete', ownerUserId: mediatorId, amountPaise, idempotencyKey: payout_complete:<payoutId> })`

Notes:

- Today this is recorded as a manual payout (no provider callback flow wired).

## Next hardening checkpoints (recommended)

- Conservation invariant: for every settlement credit, define and enforce the corresponding funding debit (brand escrow, platform wallet, or agency wallet) with a linked `Transaction` pair.
- Pending/locked balances: either implement for “cooling” windows and disputes, or remove fields if not needed.
- Reconciliation tooling: build an admin report that can compute per-user and global sums of credits/debits by `Transaction.type`.
