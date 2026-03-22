/**
 * Reusable pagination helpers for list endpoints.
 * Provides a standard { data, total, page, limit } envelope.
 * Backward-compatible: returns plain array if client doesn't send ?page= or ?limit=
 */

/** Parse page/limit from query params with safe bounds */
export function parsePagination(query: Record<string, unknown>, defaults?: { page?: number; limit?: number; maxLimit?: number }) {
  const maxCap = defaults?.maxLimit ?? 500;
  const page = Math.max(1, Number(query.page) || defaults?.page || 1);
  const limit = Math.min(maxCap, Math.max(1, Number(query.limit) || defaults?.limit || 50));
  const skip = (page - 1) * limit;
  const isPaginated = query.page !== undefined || query.limit !== undefined;
  return { page, limit, skip, isPaginated };
}

/** Standard paginated response envelope */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Build response — always returns plain array for maximum backward compatibility.
 * The frontend `asArray()` helper handles both formats as defense-in-depth.
 */
export function paginatedResponse<T>(data: T[], _total: number, _page: number, _limit: number, _isPaginated: boolean): T[] {
  return data;
}
