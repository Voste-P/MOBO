import { z } from 'zod';

export const updateUserStatusSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(['active', 'suspended', 'pending']),
  reason: z.string().min(1).max(500).optional(),
}).refine(
  (data) => data.status !== 'suspended' || (data.reason && data.reason.trim().length > 0),
  { message: 'Reason is required when suspending a user', path: ['reason'] },
);

export const reactivateOrderSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(1).max(500).optional(),
});

const normalizeRole = (value: unknown) => {
  const s = String(value ?? '').trim().toLowerCase();
  return s || undefined;
};
const normalizeOptionalString = (value: unknown) => {
  const s = String(value ?? '').trim();
  return s || undefined;
};

export const adminUsersQuerySchema = z.object({
  role: z.preprocess(
    normalizeRole,
    z.enum(['all', 'user', 'mediator', 'agency', 'brand', 'admin']).default('all')
  ),
  search: z.preprocess(normalizeOptionalString, z.string().max(120).optional()),
  status: z.preprocess(
    normalizeOptionalString,
    z.enum(['all', 'active', 'suspended', 'pending']).default('all')
  ),
});

export const adminFinancialsQuerySchema = z.object({
  status: z.preprocess(
    normalizeOptionalString,
    z.enum(['all', 'Pending_Cooling', 'Approved_Settled', 'Rejected', 'Fraud_Alert', 'Unchecked', 'Cap_Exceeded', 'Frozen_Disputed']).default('all')
  ),
  search: z.preprocess(normalizeOptionalString, z.string().max(120).optional()),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const adminProductsQuerySchema = z.object({
  search: z.preprocess(normalizeOptionalString, z.string().max(120).optional()),
  active: z.preprocess(
    normalizeOptionalString,
    z.enum(['all', 'true', 'false']).default('all')
  ),
});

export const adminAuditLogsQuerySchema = z.object({
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(200).optional(),
  actorUserId: z.string().max(200).optional(),
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
