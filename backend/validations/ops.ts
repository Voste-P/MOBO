import { z } from 'zod';

export const approveByIdSchema = z.object({
  id: z.string().min(1),
});

export const rejectByIdSchema = z.object({
  id: z.string().min(1),
});

export const verifyOrderSchema = z.object({
  orderId: z.string().min(1),
});

export const verifyOrderRequirementSchema = z.object({
  orderId: z.string().min(1),
  type: z.enum(['review', 'rating', 'returnWindow']),
});

export const rejectOrderProofSchema = z.object({
  orderId: z.string().min(1),
  type: z.enum(['order', 'review', 'rating', 'returnWindow']),
  reason: z.string().min(5).max(500).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()),
});

export const cancelOrderProofsSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(5).max(500).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()),
});

export const requestMissingProofSchema = z.object({
  orderId: z.string().min(1),
  type: z.enum(['review', 'rating', 'returnWindow']),
  note: z.string().max(300).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()).optional(),
});

const normalizeQueryString = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
};

/** Reusable pagination params for list endpoints (page 1-based, default limit 200, max 1000). */
const paginationMixin = {
  page: z.preprocess((v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }, z.number().int().min(1).default(1)),
  limit: z.preprocess((v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 1000) : 200;
  }, z.number().int().min(1).max(1000).default(200)),
};

export const opsOrdersQuerySchema = z.object({
  ...paginationMixin,
  mediatorCode: z.preprocess(normalizeQueryString, z.string().min(1).optional()),
  role: z.preprocess(
    normalizeQueryString,
    z.enum(['agency', 'mediator']).optional()
  ),
});

export const opsMediatorQuerySchema = z.object({
  ...paginationMixin,
  agencyCode: z.preprocess(normalizeQueryString, z.string().min(1).optional()),
  search: z.preprocess(normalizeQueryString, z.string().max(120).optional()),
});

export const opsCodeQuerySchema = z.object({
  ...paginationMixin,
  code: z.preprocess(normalizeQueryString, z.string().min(1).optional()),
  search: z.preprocess(normalizeQueryString, z.string().max(120).optional()),
});

export const opsCampaignsQuerySchema = z.object({
  ...paginationMixin,
  mediatorCode: z.preprocess(normalizeQueryString, z.string().min(1).optional()),
  status: z.preprocess(normalizeQueryString, z.enum(['all', 'active', 'paused', 'completed', 'draft']).default('all')),
});

export const opsDealsQuerySchema = z.object({
  ...paginationMixin,
  mediatorCode: z.preprocess(normalizeQueryString, z.string().min(1).optional()),
  role: z.preprocess(normalizeQueryString, z.enum(['agency', 'mediator']).optional()),
});

export const deleteByIdParamSchema = z.object({
  id: z.string().min(1),
});
export const settleOrderSchema = z.object({
  orderId: z.string().min(1),
  settlementRef: z.string().trim().min(2).max(128).optional(),
  settlementMode: z.enum(['wallet', 'external']).optional(),
});

export const unsettleOrderSchema = z.object({
  orderId: z.string().min(1),
});

export const createCampaignSchema = z.object({
  // For privileged roles (admin/ops): required and must point at a brand user.
  // For non-privileged (agency/mediator): optional; backend will default to requester.
  brandUserId: z.string().min(1).optional(),
  brandName: z.string().max(200).optional(),
  title: z.string().min(1).max(200),
  platform: z.string().min(1).max(80),
  dealType: z.enum(['Discount', 'Review', 'Rating']).optional(),
  price: z.number().nonnegative().max(10_00_000),
  originalPrice: z.number().nonnegative().max(10_00_000),
  payout: z.number().nonnegative().max(10_00_000),
  image: z.string().min(1),
  productUrl: z.string().min(1),
  totalSlots: z.number().int().min(0),
  allowedAgencies: z.array(z.string().min(1)).default([]),
  returnWindowDays: z.number().int().min(0).max(365).optional(),
});

export const assignSlotsSchema = z.object({
  id: z.string().min(1),
  assignments: z.record(
    z.string(),
    z.union([
      z.number().int().min(0).max(10_000),
      z.object({
        limit: z.number().int().min(0).max(10_000),
        payout: z.number().nonnegative().max(10_00_000).optional(),
      }),
    ])
  ).optional().default({}),
  openToAll: z.boolean().optional(),
  dealType: z.enum(['Discount', 'Review', 'Rating']).optional(),
  price: z.number().nonnegative().max(10_00_000).optional(),
  payout: z.number().nonnegative().max(10_00_000).optional(),
  commission: z.number().nonnegative().max(10_00_000).optional(),
});

export const updateCampaignStatusSchema = z.object({
  status: z.enum(['active', 'paused', 'completed', 'draft']),
});

export const publishDealSchema = z.object({
  id: z.string().min(1), // campaign id
  // Commission can be negative (mediator absorbs the loss to attract buyers).
  commission: z.number().default(0),
  mediatorCode: z.string().min(1),
});

export const payoutMediatorSchema = z.object({
  mediatorId: z.string().min(1),
  amount: z.number().positive().max(1_00_00_000),
  ref: z.string().trim().min(1).max(128),
});

export const copyCampaignSchema = z.object({
  id: z.string().min(1, 'Valid campaign ID is required'),
});

export const declineOfferSchema = z.object({
  id: z.string().min(1, 'Valid campaign ID is required'),
});

export const forceApproveOrderSchema = z.object({
  orderId: z.string().min(1),
  note: z.string().max(500).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()).optional(),
});

export const cancelOrderSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(5).max(500).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()),
});
