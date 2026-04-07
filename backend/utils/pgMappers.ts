/**
 * PG → Controller Mappers
 *
 * Transforms Prisma (PostgreSQL) results into the nested-document format
 * expected by uiMappers and controller logic.
 *
 * Key transformations:
 * 1. `_id = id` — PG primary key used as the canonical identifier.
 * 2. User: flat KYC / bank fields → nested kycDocuments / bankDetails objects.
 * 3. Order: flat screenshot / rejection fields → nested subdocuments.
 */

import { safeIso } from './uiMappers.js';

// ────────────── generic ──────────────

/** Add `_id = id` for backward compat with legacy API shapes. */
export function withId<T extends { id: string }>(raw: T): T & { _id: string } {
  return { ...raw, _id: raw.id };
}

/** Map an array of PG results – null-safe. */
export function mapAll<T>(items: T[] | null | undefined, mapper: (item: T) => any): any[] {
  if (!items) return [];
  return items.map(mapper);
}

// ────────────── User ──────────────

/** Map PG User to controller-compatible format. */
export function pgUser(raw: any): any {
  if (!raw) return null;
  return {
    ...raw,
    _id: raw.id,
    kycDocuments: {
      panCard: raw.kycPanCard ?? null,
      aadhaar: raw.kycAadhaar ?? null,
      gst: raw.kycGst ?? null,
    },
    bankDetails: {
      accountNumber: raw.bankAccountNumber ?? null,
      ifsc: raw.bankIfsc ?? null,
      bankName: raw.bankName ?? null,
      holderName: raw.bankHolderName ?? null,
    },
    pendingConnections: Array.isArray(raw.pendingConnections)
      ? raw.pendingConnections.map((p: any) => ({
          agencyId: p.agencyUserId ?? p.agencyId,
          agencyName: p.agencyName,
          agencyCode: p.agencyCode,
          timestamp: safeIso(p.createdAt) ?? new Date().toISOString(),
        }))
      : [],
  };
}

// ────────────── Order ──────────────

/** Map PG Order to controller-compatible format. */
export function pgOrder(raw: any): any {
  if (!raw) return null;
  return {
    ...raw,
    _id: raw.id,
    userId: raw.userId,
    // Filter out soft-deleted items when loaded via include: { items: true }
    items: Array.isArray(raw.items) ? raw.items.filter((i: any) => !i.isDeleted) : raw.items,
    screenshots: {
      order: raw.screenshotOrder ?? null,
      payment: raw.screenshotPayment ?? null,
      review: raw.screenshotReview ?? null,
      rating: raw.screenshotRating ?? null,
      returnWindow: raw.screenshotReturnWindow ?? null,
    },
    rejection: raw.rejectionType
      ? {
          type: raw.rejectionType,
          reason: raw.rejectionReason ?? null,
          rejectedAt: raw.rejectionAt ?? null,
          rejectedBy: raw.rejectionBy ?? null,
        }
      : null,
    // verification: JSONB – comes as-is
    // events: JSONB – comes as-is
    // missingProofRequests: JSONB – comes as-is
  };
}

// ────────────── Campaign ──────────────

/** Map PG Campaign. Assignments is already JSONB. */
export function pgCampaign(raw: any): any {
  if (!raw) return null;
  return {
    ...raw,
    _id: raw.id,
    // assignments: JSONB – comes as-is
    // allowedAgencyCodes: string[] – stored as text[]
  };
}

// ────────────── Deal ──────────────

export function pgDeal(raw: any): any {
  if (!raw) return null;
  return { ...raw, _id: raw.id };
}

// ────────────── Ticket ──────────────

export function pgTicket(raw: any): any {
  if (!raw) return null;
  return { ...raw, _id: raw.id };
}

// ────────────── Wallet ──────────────

export function pgWallet(raw: any): any {
  if (!raw) return null;
  return { ...raw, _id: raw.id };
}

// ────────────── Transaction ──────────────

export function pgTransaction(raw: any): any {
  if (!raw) return null;
  return { ...raw, _id: raw.id };
}

// ────────────── Invite ──────────────

export function pgInvite(raw: any): any {
  if (!raw) return null;
  return { ...raw, _id: raw.id };
}

// ────────────── Payout ──────────────

export function pgPayout(raw: any): any {
  if (!raw) return null;
  return { ...raw, _id: raw.id };
}

// ────────────── Suspension ──────────────

export function pgSuspension(raw: any): any {
  if (!raw) return null;
  return { ...raw, _id: raw.id };
}
