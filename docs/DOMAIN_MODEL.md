# Domain Model (Current Implementation)

> **20 Prisma models, 22 enums** — PostgreSQL via Prisma ORM. Last updated: June 2025.

Source: [backend/prisma/schema.prisma](../backend/prisma/schema.prisma)

This document summarizes the current backend domain entities and how they relate. It is an "as built" map, not a final product spec.

## Enums

| Enum                  | Values                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UserRole`            | shopper, mediator, agency, brand, admin, ops                                                                                                                                                           |
| `UserStatus`          | active, suspended, pending                                                                                                                                                                             |
| `KycStatus`           | none, pending, verified, rejected                                                                                                                                                                      |
| `BrandStatus`         | active, suspended, pending                                                                                                                                                                             |
| `AgencyStatus`        | active, suspended, pending                                                                                                                                                                             |
| `MediatorStatus`      | active, suspended, pending                                                                                                                                                                             |
| `OrderWorkflowStatus` | CREATED → REDIRECTED → ORDERED → PROOF_SUBMITTED → UNDER_REVIEW → APPROVED → REWARD_PENDING → COMPLETED / REJECTED / FAILED                                                                            |
| `OrderStatus`         | Ordered, Shipped, Delivered, Cancelled, Returned                                                                                                                                                       |
| `PaymentStatus`       | Pending, Paid, Refunded, Failed                                                                                                                                                                        |
| `AffiliateStatus`     | Unchecked, Pending_Cooling, Approved_Settled, Rejected, Cap_Exceeded, Frozen_Disputed                                                                                                                    |
| `SettlementMode`      | wallet, external                                                                                                                                                                                       |
| `DealType`            | Discount, Review, Rating                                                                                                                                                                               |
| `CampaignStatus`      | draft, active, paused, completed                                                                                                                                                                       |
| `TransactionType`     | brand_deposit, platform_fee, commission_lock/settle, cashback_lock/settle, order_settlement_debit, commission_reversal, margin_reversal, agency_payout/receipt, payout_request/complete/failed, refund |
| `TransactionStatus`   | pending, completed, failed, reversed                                                                                                                                                                   |
| `PayoutStatus`        | requested, processing, paid, failed, canceled, recorded                                                                                                                                                |
| `InviteStatus`        | active, used, revoked, expired                                                                                                                                                                         |
| `TicketStatus`        | Open, Resolved, Rejected                                                                                                                                                                               |
| `SuspensionAction`    | suspend, unsuspend                                                                                                                                                                                     |
| `PushApp`             | buyer, mediator                                                                                                                                                                                        |
| `RejectionType`       | order, review, rating, returnWindow                                                                                                                                                                    |
| `MissingProofType`    | review, rating, returnWindow                                                                                                                                                                           |

## Core Entities

### User (table: `users`)

Roles: `shopper` (buyer), `mediator`, `agency`, `brand`, `ops`, `admin`

Key linkage fields:

- `mediatorCode`: stable code for agency and mediator users
- `parentCode`: for mediator → parent agency's mediatorCode; for shopper → parent mediator's mediatorCode
- `brandCode`: stable code for brand connection requests
- `connectedAgencies[]`: agency codes connected to this brand user

Status & enforcement:

- `status`: active / suspended / pending
- `kycStatus`: none / pending / verified / rejected
- Backend auth middleware enforces upstream suspension (shopper → mediator → agency)

### Brand (table: `brands`)

Dedicated brand entity with `brandCode` (unique), `ownerUserId`, `connectedAgencyCodes[]`, `status`.

### Agency (table: `agencies`)

Dedicated agency entity with `agencyCode` (unique), `ownerUserId`, `status`.

### MediatorProfile (table: `mediator_profiles`)

Linked to User via `userId` (unique). Has `mediatorCode` (unique), `parentAgencyCode`, `status`.

### ShopperProfile (table: `shopper_profiles`)

Linked to User via `userId` (unique). Has `defaultMediatorCode`.

### PendingConnection (table: `pending_connections`)

Join table for brand-agency connection requests. Fields: `userId` (FK→User), `agencyId`, `agencyName`, `agencyCode`.

### Invite (table: `invites`)

- `code` (unique): used for registration
- `role`: role to be created (must match)
- `parentCode`: upstream parent code
- `status`: active / used / revoked / expired
- Supports `maxUses` with usage log (`uses[]` JSONB)

### Campaign (table: `campaigns`)

Brand-owned offer "template" distributed to agencies/mediators.

- Ownership: `brandUserId` + `brandName`
- Visibility: `allowedAgencyCodes[]`, `assignments` (JSONB: mediatorCode → { limit, payout? })
- Economics: `pricePaise`, `originalPricePaise`, `payoutPaise`
- Capacity: `totalSlots`, `usedSlots`
- Immutability: `locked` + `lockedReason` (locked after slot assignment or first order)

### Deal (table: `deals`)

Published mediator-scoped offer from a campaign.

- Uniqueness: one deal per `(campaignId, mediatorCode)`
- Snapshots campaign fields for stability
- Economics: `commissionPaise` (buyer), `payoutPaise` (mediator via agency; margin = payoutPaise − commissionPaise)

### Order (table: `orders`)

Buyer claiming a deal/campaign.

- Linkages: `userId` (buyer), `brandUserId` (brand), `managerName` (= mediatorCode)
- State machine: `workflowStatus` (enforced in services)
- Business statuses: `affiliateStatus`, `paymentStatus`
- Fraud: unique `externalOrderId`, unique `(userId, items[0].productId)` for non-terminal workflows
- `events` (JSONB): audit trail of state transitions
- `frozen`: locks order from further mutations

### OrderItem (table: `order_items`)

Line items linked to Order and Campaign. Fields: `productId`, `title`, `priceAtPurchasePaise`, `commissionPaise`, `campaignId`, `dealType`, `quantity`.

### Wallet (table: `wallets`)

Per-user balances: `availablePaise`, `pendingPaise`, `lockedPaise`, `version` (optimistic concurrency).

### Transaction (table: `transactions`)

Idempotent ledger entries with unique `idempotencyKey`. 15 transaction types covering deposits, settlements, payouts, reversals.

### Payout (table: `payouts`)

Withdrawal requests: `beneficiaryUserId`, `walletId`, `amountPaise`, `status`, `provider`, `providerRef`. Unique constraint on `(provider, providerRef)`.

### Ticket (table: `tickets`)

Support tickets. Can reference an order via `orderId`. Fields: `issueType`, `description`, `status`, `resolvedBy`, `resolutionNote`.

### PushSubscription (table: `push_subscriptions`)

Web push subscriptions per user/app (buyer or mediator). Unique on `endpoint`.

### Suspension (table: `suspensions`)

Audit record: `targetUserId`, `action` (suspend/unsuspend), `reason`, `adminUserId`.

### AuditLog (table: `audit_logs`)

Append-only: `actorUserId`, `actorRoles[]`, `action`, `entityType`, `entityId`, `ip`, `metadata` (JSONB).

### SystemConfig (table: `system_configs`)

System key-value config. Unique key (default `"system"`). Fields: `adminContactEmail`.

### MigrationSync (table: `migration_sync`)

Mongo→PG migration tracking. Unique on `collection`. Fields: `status`, `syncedCount`, `errorCount`.

## Relationship Diagram

```
Brand ──────────── Campaign ───── Deal
  │                   │              │
  │ connectedAgencies │ assignments  │ mediatorCode
  │                   │              │
Agency ─── MediatorProfile ─── User ─── ShopperProfile
              │                  │
              │ parentAgencyCode │ parentCode
              │                  │
              └──────────────────┘
                     │
                   Order ──── OrderItem
                     │
              Wallet ─── Transaction ─── Payout
```

- **Agency** creates mediator invites; owns mediators via `mediator.parentCode == agency.mediatorCode`
- **Mediator** creates buyer invites; owns buyers via `shopper.parentCode == mediator.mediatorCode`; publishes deals
- **Brand** connects to agencies via `connectedAgencyCodes[]`; owns campaigns via `brandUserId`
- **Buyer** sees deals for their mediator; creates orders against available campaigns
- **Admin** manages all entities; append-only audit log tracks all admin actions

## Soft-Delete Rule

Every destructive operation sets `deletedAt` — **no hard deletes in production code**. Only test cleanup scripts use `.delete()`.
