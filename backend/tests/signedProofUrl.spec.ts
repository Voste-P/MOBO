import { describe, it, expect } from 'vitest';
import { createProofToken, verifyProofToken } from '../utils/signedProofUrl.js';

const env = { JWT_ACCESS_SECRET: 'test-secret-key-for-signing-proof-urls' };

describe('signedProofUrl', () => {
  it('creates and verifies a valid token', () => {
    const token = createProofToken('order-123', 'order', env);
    const result = verifyProofToken(token, env);
    expect(result).toEqual({ orderId: 'order-123', proofType: 'order' });
  });

  it('rejects token with wrong secret', () => {
    const token = createProofToken('order-123', 'order', env);
    const result = verifyProofToken(token, { JWT_ACCESS_SECRET: 'wrong-secret' });
    expect(result).toBeNull();
  });

  it('rejects tampered token', () => {
    const token = createProofToken('order-123', 'order', env);
    const tampered = token.slice(0, -4) + 'XXXX';
    const result = verifyProofToken(tampered, env);
    expect(result).toBeNull();
  });

  it('rejects token without dot separator', () => {
    expect(verifyProofToken('no-dot-here', env)).toBeNull();
  });

  it('preserves proof type in token', () => {
    for (const pt of ['order', 'payment', 'rating', 'review', 'returnwindow']) {
      const token = createProofToken('id-1', pt, env);
      const result = verifyProofToken(token, env);
      expect(result?.proofType).toBe(pt);
    }
  });
});
