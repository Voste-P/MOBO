import { describe, it, expect } from 'vitest';
import { normalizeMediatorCode, buildMediatorCodeRegex } from '../../utils/mediatorCode.js';

describe('mediatorCode utils', () => {
  describe('normalizeMediatorCode', () => {
    it('trims whitespace', () => {
      expect(normalizeMediatorCode('  MED_CODE  ')).toBe('MED_CODE');
    });

    it('handles null/undefined', () => {
      expect(normalizeMediatorCode(null)).toBe('');
      expect(normalizeMediatorCode(undefined)).toBe('');
      expect(normalizeMediatorCode('')).toBe('');
    });

    it('converts number to string', () => {
      expect(normalizeMediatorCode(12345)).toBe('12345');
    });

    it('preserves case', () => {
      expect(normalizeMediatorCode('Test_Code')).toBe('Test_Code');
    });
  });

  describe('buildMediatorCodeRegex', () => {
    it('builds case-insensitive regex', () => {
      const regex = buildMediatorCodeRegex('MED_TEST');
      expect(regex).not.toBeNull();
      expect(regex!.test('MED_TEST')).toBe(true);
      expect(regex!.test('med_test')).toBe(true);
      expect(regex!.test('Med_Test')).toBe(true);
    });

    it('returns null for empty input', () => {
      expect(buildMediatorCodeRegex('')).toBeNull();
      expect(buildMediatorCodeRegex(null)).toBeNull();
      expect(buildMediatorCodeRegex(undefined)).toBeNull();
    });

    it('anchors to full string', () => {
      const regex = buildMediatorCodeRegex('MED');
      expect(regex!.test('MED')).toBe(true);
      expect(regex!.test('MED_EXTRA')).toBe(false);
      expect(regex!.test('PREMED')).toBe(false);
    });

    it('escapes regex special characters', () => {
      const regex = buildMediatorCodeRegex('CODE.+*?');
      expect(regex).not.toBeNull();
      expect(regex!.test('CODE.+*?')).toBe(true);
      expect(regex!.test('CODEABC')).toBe(false);
    });
  });
});
