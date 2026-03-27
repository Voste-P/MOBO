import { describe, it, expect } from 'vitest';
import { parsePagination, paginatedResponse } from '../../utils/pagination.js';

describe('pagination utils', () => {
  describe('parsePagination', () => {
    it('returns defaults when no query params', () => {
      const result = parsePagination({});
      expect(result).toEqual({ page: 1, limit: 50, skip: 0, isPaginated: false });
    });

    it('parses page and limit from query', () => {
      const result = parsePagination({ page: '3', limit: '25' });
      expect(result).toEqual({ page: 3, limit: 25, skip: 50, isPaginated: true });
    });

    it('clamps page to minimum 1', () => {
      const result = parsePagination({ page: '-5', limit: '10' });
      expect(result.page).toBe(1);
      expect(result.skip).toBe(0);
    });

    it('clamps limit to maxLimit', () => {
      const result = parsePagination({ page: '1', limit: '9999' });
      expect(result.limit).toBe(200); // default maxLimit
    });

    it('clamps limit to minimum 1', () => {
      const result = parsePagination({ page: '1', limit: '0' });
      expect(result.limit).toBeGreaterThanOrEqual(1);
    });

    it('respects custom defaults', () => {
      const result = parsePagination({}, { page: 2, limit: 10, maxLimit: 100 });
      expect(result).toEqual({ page: 2, limit: 10, skip: 10, isPaginated: false });
    });

    it('handles non-numeric values gracefully', () => {
      const result = parsePagination({ page: 'abc', limit: 'xyz' });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });

    it('marks as paginated when page is provided', () => {
      expect(parsePagination({ page: '1' }).isPaginated).toBe(true);
    });

    it('marks as paginated when limit is provided', () => {
      expect(parsePagination({ limit: '25' }).isPaginated).toBe(true);
    });

    it('calculates skip correctly for higher pages', () => {
      const result = parsePagination({ page: '5', limit: '20' });
      expect(result.skip).toBe(80);
    });
  });

  describe('paginatedResponse', () => {
    const data = [{ id: 1 }, { id: 2 }, { id: 3 }];

    it('returns paginated envelope when isPaginated is true', () => {
      const result = paginatedResponse(data, 100, 1, 10, true);
      expect(result).toEqual({
        data,
        total: 100,
        page: 1,
        limit: 10,
        totalPages: 10,
      });
    });

    it('returns plain array when isPaginated is false', () => {
      const result = paginatedResponse(data, 3, 1, 50, false);
      expect(result).toEqual(data);
    });

    it('calculates totalPages correctly', () => {
      const result = paginatedResponse([], 101, 1, 10, true) as any;
      expect(result.totalPages).toBe(11);
    });

    it('handles empty data', () => {
      const result = paginatedResponse([], 0, 1, 10, true) as any;
      expect(result.totalPages).toBe(0);
      expect(result.data).toEqual([]);
    });
  });
});
