import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, asArray, extractPaginationMeta } from '../services/api';
import { subscribeRealtime } from '../services/realtime';
import { useEffect, useRef } from 'react';
import { invalidateQueries } from '../context/QueryProvider';
import type { Product, Order } from '../types';

// ── Query key factories ──────────────────────────────────────────────
export const queryKeys = {
  products: (mediatorCode?: string, page = 1, limit = 50) =>
    ['products', mediatorCode ?? 'all', page, limit] as const,
  userOrders: (userId: string, page = 1, limit = 50) =>
    ['orders', userId, page, limit] as const,
  notifications: (userId: string) => ['notifications', userId] as const,
  campaigns: (mediatorCode?: string, page = 1, limit = 50) =>
    ['campaigns', mediatorCode ?? 'all', page, limit] as const,
  deals: (mediatorCode: string, role?: string, page = 1, limit = 50) =>
    ['deals', mediatorCode, role ?? 'all', page, limit] as const,
  mediatorOrders: (mediatorCode: string, role?: string, page = 1, limit = 50) =>
    ['mediatorOrders', mediatorCode, role ?? 'all', page, limit] as const,
  mediators: (agencyCode: string, search?: string, page = 1, limit = 50) =>
    ['mediators', agencyCode, search ?? '', page, limit] as const,
  pendingUsers: (code: string, page = 1, limit = 50) =>
    ['pendingUsers', code, page, limit] as const,
  verifiedUsers: (code: string, page = 1, limit = 50) =>
    ['verifiedUsers', code, page, limit] as const,
  brandCampaigns: (brandId: string, page = 1, limit = 50) =>
    ['brandCampaigns', brandId, page, limit] as const,
  brandOrders: (brandName: string, page = 1, limit = 50) =>
    ['brandOrders', brandName, page, limit] as const,
  brandAgencies: (brandId: string, page = 1, limit = 50) =>
    ['brandAgencies', brandId, page, limit] as const,
  brandTransactions: (brandId: string, page = 1, limit = 50) =>
    ['brandTransactions', brandId, page, limit] as const,
  adminStats: () => ['adminStats'] as const,
  adminUsers: (role: string, opts?: { search?: string; status?: string; page?: number; limit?: number }) =>
    ['adminUsers', role, opts?.search ?? '', opts?.status ?? '', opts?.page ?? 1, opts?.limit ?? 50] as const,
  adminProducts: (opts?: { search?: string; active?: string; page?: number; limit?: number }) =>
    ['adminProducts', opts?.search ?? '', opts?.active ?? '', opts?.page ?? 1, opts?.limit ?? 50] as const,
  adminFinancials: (opts?: { status?: string; page?: number; limit?: number }) =>
    ['adminFinancials', opts?.status ?? '', opts?.page ?? 1, opts?.limit ?? 50] as const,
  adminAuditLogs: (filters?: Record<string, unknown>) =>
    ['adminAuditLogs', JSON.stringify(filters ?? {})] as const,
  adminInvites: (page = 1, limit = 50) => ['adminInvites', page, limit] as const,
  adminConfig: () => ['adminConfig'] as const,
  adminGrowth: () => ['adminGrowth'] as const,
  tickets: (page = 1, limit = 50) => ['tickets', page, limit] as const,
  ticketIssueTypes: () => ['ticketIssueTypes'] as const,
  agencyLedger: (page = 1, limit = 50) => ['agencyLedger', page, limit] as const,
} as const;

// ── Realtime-aware invalidation hook ─────────────────────────────────
/**
 * Subscribe to SSE events and auto-invalidate matching query keys.
 * Uses debounce to batch rapid events into a single invalidation.
 */
export function useRealtimeInvalidation(eventToKeys: Record<string, string[][]>) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Set<string>>(new Set());
  const qc = useQueryClient();

  useEffect(() => {
    const unsub = subscribeRealtime((msg) => {
      const keys = eventToKeys[msg.type];
      if (!keys) return;
      for (const k of keys) pendingRef.current.add(JSON.stringify(k));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        for (const raw of pendingRef.current) {
          const parsed = JSON.parse(raw) as string[];
          qc.invalidateQueries({ queryKey: parsed });
        }
        pendingRef.current.clear();
        timerRef.current = null;
      }, 400);
    });
    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [eventToKeys, qc]);
}

// ── Products (Buyer Explore) ─────────────────────────────────────────
export function useProducts(mediatorCode?: string, page = 1, limit = 50) {
  const query = useQuery({
    queryKey: queryKeys.products(mediatorCode, page, limit),
    queryFn: async () => {
      const data = await api.products.getAll(mediatorCode, page, limit);
      return asArray<Product>(data);
    },
    staleTime: 30_000,
  });

  // Auto-invalidate on realtime deals.changed
  useRealtimeInvalidation({
    'deals.changed': [['products']],
  });

  return query;
}

// ── User Orders (Buyer) ──────────────────────────────────────────────
export function useUserOrders(userId: string | undefined, page = 1, limit = 50) {
  const query = useQuery({
    queryKey: queryKeys.userOrders(userId ?? '', page, limit),
    queryFn: async () => {
      if (!userId) return { data: [] as Order[], meta: null };
      const raw = await api.orders.getUserOrders(userId, page, limit);
      return {
        data: asArray<Order>(raw),
        meta: extractPaginationMeta(raw),
      };
    },
    enabled: !!userId,
    staleTime: 15_000,
  });

  useRealtimeInvalidation({
    'orders.changed': [['orders']],
  });

  return query;
}

// ── Notifications ────────────────────────────────────────────────────
export function useNotifications(userId: string | undefined) {
  const query = useQuery({
    queryKey: queryKeys.notifications(userId ?? ''),
    queryFn: () => api.notifications.list(),
    enabled: !!userId,
    staleTime: 20_000,
  });

  useRealtimeInvalidation({
    'orders.changed': [['notifications']],
    'users.changed': [['notifications']],
    'wallets.changed': [['notifications']],
    'notifications.changed': [['notifications']],
    'tickets.changed': [['notifications']],
  });

  return query;
}

// ── Campaigns (Mediator/Agency) ──────────────────────────────────────
export function useCampaigns(mediatorCode?: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.campaigns(mediatorCode, page, limit),
    queryFn: () => api.ops.getCampaigns(mediatorCode, page, limit),
    enabled: !!mediatorCode,
    staleTime: 30_000,
  });
}

// ── Deals (Mediator) ─────────────────────────────────────────────────
export function useDeals(mediatorCode: string, role?: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.deals(mediatorCode, role, page, limit),
    queryFn: () => api.ops.getDeals(mediatorCode, role, page, limit),
    enabled: !!mediatorCode,
    staleTime: 30_000,
  });
}

// ── Mediator Orders ──────────────────────────────────────────────────
export function useMediatorOrders(mediatorCode: string, role?: string, page = 1, limit = 50) {
  const query = useQuery({
    queryKey: queryKeys.mediatorOrders(mediatorCode, role, page, limit),
    queryFn: () => api.ops.getMediatorOrders(mediatorCode, role, page, limit),
    enabled: !!mediatorCode,
    staleTime: 15_000,
  });

  useRealtimeInvalidation({
    'orders.changed': [['mediatorOrders']],
  });

  return query;
}

// ── Mediators (Agency) ───────────────────────────────────────────────
export function useMediators(agencyCode: string, search?: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.mediators(agencyCode, search, page, limit),
    queryFn: () => api.ops.getMediators(agencyCode, { search, page, limit }),
    enabled: !!agencyCode,
    staleTime: 30_000,
  });
}

// ── Pending Users ────────────────────────────────────────────────────
export function usePendingUsers(code: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.pendingUsers(code, page, limit),
    queryFn: () => api.ops.getPendingUsers(code, page, limit),
    enabled: !!code,
    staleTime: 15_000,
  });
}

// ── Verified Users ───────────────────────────────────────────────────
export function useVerifiedUsers(code: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.verifiedUsers(code, page, limit),
    queryFn: () => api.ops.getVerifiedUsers(code, page, limit),
    enabled: !!code,
    staleTime: 30_000,
  });
}

// ── Brand Campaigns ──────────────────────────────────────────────────
export function useBrandCampaigns(brandId: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.brandCampaigns(brandId, page, limit),
    queryFn: () => api.brand.getBrandCampaigns(brandId, page, limit),
    enabled: !!brandId,
    staleTime: 30_000,
  });
}

// ── Brand Orders ─────────────────────────────────────────────────────
export function useBrandOrders(brandName: string, page = 1, limit = 50) {
  const query = useQuery({
    queryKey: queryKeys.brandOrders(brandName, page, limit),
    queryFn: () => api.brand.getBrandOrders(brandName, page, limit),
    enabled: !!brandName,
    staleTime: 15_000,
  });

  useRealtimeInvalidation({
    'orders.changed': [['brandOrders']],
  });

  return query;
}

// ── Brand Agencies ───────────────────────────────────────────────────
export function useBrandAgencies(brandId: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.brandAgencies(brandId, page, limit),
    queryFn: () => api.brand.getConnectedAgencies(brandId, page, limit),
    enabled: !!brandId,
    staleTime: 60_000,
  });
}

// ── Brand Transactions ───────────────────────────────────────────────
export function useBrandTransactions(brandId: string, page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.brandTransactions(brandId, page, limit),
    queryFn: () => api.brand.getTransactions(brandId, page, limit),
    enabled: !!brandId,
    staleTime: 30_000,
  });
}

// ── Admin Stats ──────────────────────────────────────────────────────
export function useAdminStats() {
  return useQuery({
    queryKey: queryKeys.adminStats(),
    queryFn: () => api.admin.getStats(),
    staleTime: 30_000,
  });
}

// ── Admin Users ──────────────────────────────────────────────────────
export function useAdminUsers(role = 'all', opts?: { search?: string; status?: string; page?: number; limit?: number }) {
  return useQuery({
    queryKey: queryKeys.adminUsers(role, opts),
    queryFn: () => api.admin.getUsers(role, opts),
    staleTime: 15_000,
  });
}

// ── Admin Products ───────────────────────────────────────────────────
export function useAdminProducts(opts?: { search?: string; active?: string; page?: number; limit?: number }) {
  return useQuery({
    queryKey: queryKeys.adminProducts(opts),
    queryFn: () => api.admin.getProducts(opts),
    staleTime: 30_000,
  });
}

// ── Admin Financials ─────────────────────────────────────────────────
export function useAdminFinancials(opts?: { status?: string; page?: number; limit?: number }) {
  return useQuery({
    queryKey: queryKeys.adminFinancials(opts),
    queryFn: () => api.admin.getFinancials(opts),
    staleTime: 30_000,
  });
}

// ── Admin Audit Logs ─────────────────────────────────────────────────
export function useAdminAuditLogs(filters?: Parameters<typeof api.admin.getAuditLogs>[0]) {
  return useQuery({
    queryKey: queryKeys.adminAuditLogs(filters as Record<string, unknown>),
    queryFn: () => api.admin.getAuditLogs(filters),
    staleTime: 15_000,
  });
}

// ── Admin Invites ────────────────────────────────────────────────────
export function useAdminInvites(page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.adminInvites(page, limit),
    queryFn: () => api.admin.getInvites({ page, limit }),
    staleTime: 30_000,
  });
}

// ── Admin Config ─────────────────────────────────────────────────────
export function useAdminConfig() {
  return useQuery({
    queryKey: queryKeys.adminConfig(),
    queryFn: () => api.admin.getConfig(),
    staleTime: 60_000,
  });
}

// ── Admin Growth ─────────────────────────────────────────────────────
export function useAdminGrowth() {
  return useQuery({
    queryKey: queryKeys.adminGrowth(),
    queryFn: () => api.admin.getGrowthAnalytics(),
    staleTime: 60_000,
  });
}

// ── Tickets ──────────────────────────────────────────────────────────
export function useTickets(page = 1, limit = 50) {
  const query = useQuery({
    queryKey: queryKeys.tickets(page, limit),
    queryFn: () => api.tickets.getAll({ page, limit }),
    staleTime: 20_000,
  });

  useRealtimeInvalidation({
    'tickets.changed': [['tickets']],
  });

  return query;
}

// ── Ticket Issue Types ───────────────────────────────────────────────
export function useTicketIssueTypes() {
  return useQuery({
    queryKey: queryKeys.ticketIssueTypes(),
    queryFn: () => api.tickets.getIssueTypes(),
    staleTime: 5 * 60_000, // Rarely changes
  });
}

// ── Agency Ledger ────────────────────────────────────────────────────
export function useAgencyLedger(page = 1, limit = 50) {
  return useQuery({
    queryKey: queryKeys.agencyLedger(page, limit),
    queryFn: () => api.ops.getAgencyLedger(page, limit),
    staleTime: 30_000,
  });
}

// ── Mutation helpers ─────────────────────────────────────────────────

/** Generic mutation that invalidates specified query keys on success */
export function useInvalidatingMutation<TArgs, TResult>(
  mutationFn: (args: TArgs) => Promise<TResult>,
  invalidateKeys: string[][],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of invalidateKeys) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** Convenience: invalidate all query data after a mutation completes */
export function invalidateAll() {
  invalidateQueries([]);
}
