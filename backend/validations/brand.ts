import { z } from 'zod';

export const payoutAgencySchema = z.object({
  // UI sends these fields; backend uses auth user by default.
  brandId: z.string().min(1).optional(),
  agencyId: z.string().min(1),
  amount: z.coerce.number().positive().max(1_00_00_000, 'Amount cannot exceed ₹1 crore'), // INR
  ref: z.string().trim().min(1).max(128),
});

export const createBrandCampaignSchema = z.object({
  brandId: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  brand: z.string().max(200).optional(),
  platform: z.string().min(1).max(80),
  dealType: z.enum(['Discount', 'Review', 'Rating']).optional(),
  price: z.number().nonnegative().max(10_00_000),
  originalPrice: z.number().nonnegative().max(10_00_000),
  payout: z.number().nonnegative().max(10_00_000),
  image: z.string().url('Image must be a valid URL'),
  productUrl: z.string().url('Product URL must be a valid URL'),
  totalSlots: z.number().int().min(0),
  allowedAgencies: z.array(z.string().min(1)).min(1, 'allowedAgencies is required'),
  returnWindowDays: z.number().int().min(0).max(365).optional(),
});

export const updateBrandCampaignSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  platform: z.string().min(1).max(80).optional(),
  dealType: z.enum(['Discount', 'Review', 'Rating']).optional(),
  price: z.number().nonnegative().max(10_00_000).optional(),
  originalPrice: z.number().nonnegative().max(10_00_000).optional(),
  payout: z.number().nonnegative().max(10_00_000).optional(),
  image: z.string().url('Image must be a valid URL').optional(),
  productUrl: z.string().url('Product URL must be a valid URL').optional(),
  totalSlots: z.number().int().min(0).optional(),
  status: z.string().min(1).max(30).optional(),
  allowedAgencies: z.array(z.string().min(1)).optional(),
});

// ─── Query param validation ─────────────────────────────────────
export const brandCampaignsQuerySchema = z.object({
  brandId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export const brandOrdersQuerySchema = z.object({
  brandName: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export const brandTransactionsQuerySchema = z.object({
  brandId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();
