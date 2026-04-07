import { describe, it, expect } from 'vitest';
import { isUUID, idWhere } from '../../utils/idWhere.js';

describe('idWhere', () => {
  describe('isUUID', () => {
    it('recognizes valid UUIDs', () => {
      expect(isUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
      expect(isUUID('00000000-0000-0000-0000-000000000000')).toBe(true);
    });

    it('rejects non-UUIDs', () => {
      expect(isUUID('507f1f77bcf86cd799439011')).toBe(false); // MongoDB ObjectId
      expect(isUUID('not-a-uuid')).toBe(false);
      expect(isUUID('')).toBe(false);
      expect(isUUID('550e8400-e29b-41d4-a716')).toBe(false); // truncated
    });

    it('is case-insensitive', () => {
      expect(isUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });
  });

  describe('idWhere', () => {
    it('returns { id } for UUID values', () => {
      const result = idWhere('550e8400-e29b-41d4-a716-446655440000');
      expect(result).toEqual({ id: '550e8400-e29b-41d4-a716-446655440000' });
    });

    it('returns nil UUID for non-UUID values', () => {
      const result = idWhere('507f1f77bcf86cd799439011');
      expect(result).toEqual({ id: '00000000-0000-0000-0000-000000000000' });
    });

    it('returns nil UUID for arbitrary strings', () => {
      const result = idWhere('some-legacy-id');
      expect(result).toEqual({ id: '00000000-0000-0000-0000-000000000000' });
    });
  });
});
