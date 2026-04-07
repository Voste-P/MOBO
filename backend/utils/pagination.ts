/**
 * Reusable pagination helpers for list endpoints.
 * Returns { data, total, page, limit } envelope when client requests pagination,
 * otherwise returns plain array for backward compatibility.
 */

/** Parse page/limit from query params with safe bounds */
export function parsePagination(query: Record<string, unknown>, defaults?: { page?: number; limit?: number; maxLimit?: number }) {
  const maxCap = defaults?.maxLimit ?? 200;
  const page = Math.max(1, Number(query.page) || defaults?.page || 1);
  const limit = Math.min(maxCap, Math.max(1, Number(query.limit) || defaults?.limit || 50));
  const skip = (page - 1) * limit;
  // Cap offset to prevent expensive full-table scans
  if (skip > 100_000) {
    const cappedPage = Math.floor(100_000 / limit) + 1;
    return { page: cappedPage, limit, skip: (cappedPage - 1) * limit, isPaginated: true };
  }
  const isPaginated = query.page !== undefined || query.limit !== undefined;
  return { page, limit, skip, isPaginated };
}

/** Standard paginated response envelope */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Build response — returns paginated envelope if client sent ?page= or ?limit=,
 * otherwise returns plain array for backward compatibility.
 * The frontend `asArray()` helper handles both formats as defense-in-depth.
 */
export function paginatedResponse<T>(data: T[], total: number, page: number, limit: number, isPaginated: boolean): PaginatedResponse<T> | T[] {
  if (!isPaginated) return data;
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}
