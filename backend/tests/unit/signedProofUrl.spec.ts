import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProofToken, verifyProofToken } from '../../utils/signedProofUrl.js';

const env = { JWT_ACCESS_SECRET: 'test-secret-key-for-hmac-signing-32chars!' };

describe('signedProofUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('createProofToken', () => {
    it('creates a valid base64url token with signature', () => {
      const token = createProofToken('order-123', 'screenshot', env);
      expect(typeof token).toBe('string');
      expect(token).toContain('.');
      const parts = token.split('.');
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it('produces different tokens for different orders', () => {
      const t1 = createProofToken('order-1', 'screenshot', env);
      const t2 = createProofToken('order-2', 'screenshot', env);
      expect(t1).not.toBe(t2);
    });

    it('produces different tokens for different proof types', () => {
      const t1 = createProofToken('order-1', 'screenshot', env);
      const t2 = createProofToken('order-1', 'review', env);
      expect(t1).not.toBe(t2);
    });
  });

  describe('verifyProofToken', () => {
    it('verifies a valid token', () => {
      const token = createProofToken('order-abc', 'review', env);
      const result = verifyProofToken(token, env);
      expect(result).toEqual({ orderId: 'order-abc', proofType: 'review' });
    });

    it('rejects token with wrong secret', () => {
      const token = createProofToken('order-abc', 'review', env);
      const result = verifyProofToken(token, { JWT_ACCESS_SECRET: 'wrong-secret-key-that-is-different!' });
      expect(result).toBeNull();
    });

    it('rejects tampered payload', () => {
      const token = createProofToken('order-abc', 'review', env);
      const parts = token.split('.');
      // Tamper with payload
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      payload.oid = 'hacked-order';
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = `${tamperedPayload}.${parts[1]}`;
      expect(verifyProofToken(tamperedToken, env)).toBeNull();
    });

    it('rejects expired tokens', () => {
      // Mock Date.now to create a token, then advance time past expiry
      const originalNow = Date.now;
      const baseTime = originalNow.call(Date);

      vi.spyOn(Date, 'now').mockReturnValue(baseTime);
      const token = createProofToken('order-abc', 'review', env);

      // Advance past 7 days
      vi.spyOn(Date, 'now').mockReturnValue(baseTime + 8 * 24 * 60 * 60 * 1000);
      expect(verifyProofToken(token, env)).toBeNull();

      vi.restoreAllMocks();
    });

    it('rejects malformed tokens', () => {
      expect(verifyProofToken('', env)).toBeNull();
      expect(verifyProofToken('noperiod', env)).toBeNull();
      expect(verifyProofToken('not.valid.token', env)).toBeNull();
    });

    it('rejects token with missing fields', () => {
      // Create a manually signed token with missing fields
      const crypto = require('node:crypto');
      const payload = Buffer.from(JSON.stringify({ oid: 'test' })).toString('base64url'); // missing pt and exp
      const sig = crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(payload).digest('base64url');
      expect(verifyProofToken(`${payload}.${sig}`, env)).toBeNull();
    });
  });
});
