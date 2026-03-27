import { describe, it, expect } from 'vitest';
import { rupeesToPaise, paiseToRupees } from '../../utils/money.js';

describe('money utils', () => {
  describe('rupeesToPaise', () => {
    it('converts whole rupees', () => {
      expect(rupeesToPaise(100)).toBe(10000);
      expect(rupeesToPaise(1)).toBe(100);
      expect(rupeesToPaise(0)).toBe(0);
    });

    it('converts fractional rupees with rounding', () => {
      expect(rupeesToPaise(99.99)).toBe(9999);
      expect(rupeesToPaise(1.005)).toBe(100); // IEEE 754: 1.005*100 = 100.4999…
      expect(rupeesToPaise(0.01)).toBe(1);
    });

    it('handles edge cases', () => {
      expect(rupeesToPaise(NaN)).toBe(0);
      expect(rupeesToPaise(Infinity)).toBe(0);
      expect(rupeesToPaise(-Infinity)).toBe(0);
      expect(rupeesToPaise(-50)).toBe(-5000);
    });
  });

  describe('paiseToRupees', () => {
    it('converts paise to rupees', () => {
      expect(paiseToRupees(10000)).toBe(100);
      expect(paiseToRupees(100)).toBe(1);
      expect(paiseToRupees(0)).toBe(0);
      expect(paiseToRupees(1)).toBe(0.01);
      expect(paiseToRupees(99)).toBe(0.99);
    });

    it('handles edge cases', () => {
      expect(paiseToRupees(NaN)).toBe(0);
      expect(paiseToRupees(Infinity)).toBe(0);
      expect(paiseToRupees(-5000)).toBe(-50);
    });

    it('rounds fractional paise', () => {
      expect(paiseToRupees(1.7)).toBe(0.02);
      expect(paiseToRupees(1.4)).toBe(0.01);
    });
  });
});
