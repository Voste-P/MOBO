import { Prisma as _Prisma } from '../generated/prisma/client.js';

/**
 * Reusable Prisma `select` configurations for list queries.
 *
 * List endpoints don't need events (unbounded JSONB array),
 * AI verification (3 JSONB blocks), or missing-proof requests.
 * Stripping them reduces row transfer size significantly.
 */

/**
 * Prisma `select` for User existence checks.
 * Only fetches id to confirm the record exists.
 */
export const userExistsSelect = {
  id: true,
} as const;

/**
 * Prisma `select` for User status/auth checks.
 * Used when we need to verify a user's role, status, or identity.
 */
export const userStatusSelect = {
  id: true,

  status: true,
  roles: true,
  mediatorCode: true,
  parentCode: true,
  isDeleted: true,
} as const;

/**
 * Prisma `select` for User lookups needing brand connection info.
 */
export const userBrandSelect = {
  id: true,

  name: true,
  status: true,
  roles: true,
  connectedAgencies: true,
} as const;

/**
 * Prisma `select` for admin User list queries.
 * Excludes sensitive fields: passwordHash, googleRefreshToken, fcmTokens, etc.
 * Includes all fields needed by toUiUser() + pgUser().
 */
export const userAdminListSelect = {
  id: true,

  name: true,
  mobile: true,
  email: true,
  role: true,
  roles: true,
  status: true,
  mediatorCode: true,
  parentCode: true,
  generatedCodes: true,
  brandCode: true,
  connectedAgencies: true,
  pendingConnections: { where: { isDeleted: false } },
  kycStatus: true,
  kycPanCard: true,
  kycAadhaar: true,
  kycGst: true,
  isVerifiedByMediator: true,
  upiId: true,
  // qrCode excluded from list queries (50-500KB blobs, only needed in detail/pay views)
  qrCode: false,
  bankAccountNumber: true,
  bankIfsc: true,
  bankName: true,
  bankHolderName: true,
  // avatar included — typically 5-20KB compressed JPEG; needed for profile photos in lists
  avatar: true,
  createdAt: true,
  // EXCLUDED: passwordHash, googleRefreshToken, fcmTokens, isDeleted
} as const;

/**
 * Prisma `select` for User LIST queries (ops mediators/buyers, brand users, etc.).
 * Excludes base64 blob columns (avatar, qrCode) that can be 50KB-500KB each.
 * Use this for any endpoint that returns arrays of users.
 */
export const userListSelect = {
  id: true,

  name: true,
  mobile: true,
  email: true,
  role: true,
  roles: true,
  status: true,
  mediatorCode: true,
  parentCode: true,
  generatedCodes: true,
  brandCode: true,
  connectedAgencies: true,
  pendingConnections: { where: { isDeleted: false } },
  kycStatus: true,
  kycPanCard: true,
  kycAadhaar: true,
  kycGst: true,
  isVerifiedByMediator: true,
  upiId: true,
  // qrCode excluded from list queries (50-500KB blobs, only needed in pay/detail views)
  // avatar included — typically 5-20KB compressed JPEG; needed for profile photos in lists
  avatar: true,
  bankAccountNumber: true,
  bankIfsc: true,
  bankName: true,
  bankHolderName: true,
  createdAt: true,
} as const;

/**
 * Prisma `select` for Campaign list queries.
 * Includes all fields needed by toUiCampaign() but EXCLUDES `image` column
 * which can be a large base64 blob. Frontend should use productUrl or
 * a separate image proxy endpoint for thumbnails.
 */
export const campaignListSelect = {
  id: true,

  title: true,
  brandUserId: true,
  brandName: true,
  platform: true,
  image: true,
  productUrl: true,
  originalPricePaise: true,
  pricePaise: true,
  payoutPaise: true,
  returnWindowDays: true,
  dealType: true,
  totalSlots: true,
  usedSlots: true,
  status: true,
  allowedAgencyCodes: true,
  assignments: true,
  openToAll: true,
  locked: true,
  lockedAt: true,
  lockedReason: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  // Excluded: updatedBy, isDeleted (already filtered in WHERE)
} as const;

/**
 * Prisma `select` for Deal list queries.
 * Includes fields needed by toUiDeal() / pgDeal().
 */
export const dealListSelect = {
  id: true,

  campaignId: true,
  mediatorCode: true,
  title: true,
  description: true,
  image: true,
  productUrl: true,
  platform: true,
  brandName: true,
  dealType: true,
  originalPricePaise: true,
  pricePaise: true,
  commissionPaise: true,
  payoutPaise: true,
  rating: true,
  category: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Prisma `select` for Transaction list queries.
 * Excludes heavy metadata JSONB when listing.
 */
export const transactionListSelect = {
  id: true,

  type: true,
  amountPaise: true,
  status: true,
  fromUserId: true,
  toUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Prisma `select` for Order existence checks.
 */
export const orderExistsSelect = {
  id: true,
} as const;

/**
 * Prisma `select` for Order proof retrieval and authorization.
 * Only fetches fields needed for proof access checks and screenshot values.
 * Avoids fetching items, events, AI verification JSONB, and other heavy columns.
 */
export const orderProofSelect = {
  id: true,

  userId: true,
  brandUserId: true,
  brandName: true,
  agencyName: true,
  managerName: true,
  screenshotOrder: true,
  screenshotPayment: true,
  screenshotReview: true,
  screenshotRating: true,
  screenshotReturnWindow: true,
  reviewLink: true,
} as const;

/**
 * Lightweight select for batch proof URL generation.
 * Only checks existence of proofs (boolean-ish), does NOT load base64 blobs.
 * Uses raw SQL fragments to avoid reading multi-MB screenshot columns.
 */
export const orderProofExistsSelect = {
  id: true,

  userId: true,
  brandUserId: true,
  reviewLink: true,
} as const;

/**
 * Prisma `select` for notification order queries.
 * Fetches only the fields needed for notification processing.
 */
export const orderNotificationSelect = {
  id: true,

  workflowStatus: true,
  paymentStatus: true,
  affiliateStatus: true,
  reviewLink: true,
  verification: true,
  rejectionReason: true,
  missingProofRequests: true,
  managerName: true,
  buyerName: true,
  brandName: true,
  updatedAt: true,
  createdAt: true,
  items: { where: { isDeleted: false }, select: { id: true, dealType: true, title: true } },
} as const;

/**
 * Lightweight Prisma `select` for admin/bulk Order list queries.
 * EXCLUDES screenshot base64 blobs (can be 100KB-5MB each).
 * Proof boolean flags are derived from a separate lightweight query.
 */
export const orderListSelectLite = {
  id: true,
  userId: true,
  brandUserId: true,
  totalPaise: true,
  workflowStatus: true,
  frozen: true,
  frozenAt: true,
  frozenReason: true,
  status: true,
  paymentStatus: true,
  affiliateStatus: true,
  externalOrderId: true,
  orderDate: true,
  soldBy: true,
  extractedProductName: true,
  settlementRef: true,
  settlementMode: true,
  // Screenshot columns EXCLUDED — use getProofFlags() helper instead
  reviewLink: true,
  returnWindowDays: true,
  // Rejection flat fields
  rejectionType: true,
  rejectionReason: true,
  rejectionAt: true,
  rejectionBy: true,
  // Verification JSONB (small, needed for verified-status flags)
  verification: true,
  // Display names
  managerName: true,
  agencyName: true,
  buyerName: true,
  buyerMobile: true,
  reviewerName: true,
  brandName: true,
  // Timestamps
  expectedSettlementDate: true,
  createdAt: true,
  updatedAt: true,
  // Relations — items only need deal type / platform info for list view
  items: { select: { dealType: true, platform: true, brandName: true, title: true, image: true, quantity: true, priceAtPurchasePaise: true } },
  // missingProofRequests: small JSONB array needed for "Action Required" banners
  missingProofRequests: true,
} as const;

/**
 * Fetch lightweight boolean proof flags for a batch of order IDs.
 * Uses raw SQL to avoid transferring base64 screenshot blobs.
 * Returns a Map<orderId, proofFlags> for O(1) merging.
 */
export async function getProofFlags(
  prisma: any,
  orderIds: string[],
): Promise<Map<string, { hasOrderProof: boolean; hasReviewProof: boolean; hasRatingProof: boolean; hasReturnWindowProof: boolean }>> {
  if (orderIds.length === 0) return new Map();

  // Guard against unbounded arrays — callers should never pass more than 10 000 IDs
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validIds = orderIds.filter((id) => UUID_RE.test(id)).slice(0, 10_000);
  if (validIds.length === 0) return new Map();

  const rows: Array<{ id: string; hop: boolean; hrp: boolean; hrap: boolean; hrwp: boolean }> =
    await prisma.$queryRaw`SELECT id,
        (screenshot_order IS NOT NULL OR screenshot_payment IS NOT NULL) AS hop,
        (review_link IS NOT NULL OR screenshot_review IS NOT NULL) AS hrp,
        (screenshot_rating IS NOT NULL) AS hrap,
        (screenshot_return_window IS NOT NULL) AS hrwp
       FROM orders WHERE id = ANY(${validIds}::uuid[])`;

  const map = new Map<string, { hasOrderProof: boolean; hasReviewProof: boolean; hasRatingProof: boolean; hasReturnWindowProof: boolean }>();
  for (const r of rows) {
    map.set(r.id, {
      hasOrderProof: !!r.hop,
      hasReviewProof: !!r.hrp,
      hasRatingProof: !!r.hrap,
      hasReturnWindowProof: !!r.hrwp,
    });
  }
  return map;
}
