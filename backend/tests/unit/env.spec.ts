import { describe, it, expect } from 'vitest';
import { loadEnv, parseCorsOrigins } from '../../config/env.js';

describe('env config', () => {
  describe('loadEnv', () => {
    it('loads with minimal test config', () => {
      const env = loadEnv({ NODE_ENV: 'test' });
      expect(env.NODE_ENV).toBe('test');
      expect(env.PORT).toBe(8080);
      expect(env.REQUEST_BODY_LIMIT).toBe('12mb');
      expect(typeof env.JWT_ACCESS_SECRET).toBe('string');
      expect(env.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
    });

    it('respects custom port', () => {
      const env = loadEnv({ NODE_ENV: 'test', PORT: '3000' });
      expect(env.PORT).toBe(3000);
    });

    it('generates JWT secrets in test mode if not provided', () => {
      const env = loadEnv({ NODE_ENV: 'test' });
      expect(env.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(env.JWT_REFRESH_SECRET.length).toBeGreaterThanOrEqual(32);
    });

    it('uses provided JWT secrets in dev/test', () => {
      const env = loadEnv({
        NODE_ENV: 'test',
        JWT_ACCESS_SECRET: 'my-custom-dev-secret',
        JWT_REFRESH_SECRET: 'my-custom-refresh-secret',
      });
      expect(env.JWT_ACCESS_SECRET).toBe('my-custom-dev-secret');
      expect(env.JWT_REFRESH_SECRET).toBe('my-custom-refresh-secret');
    });

    it('rejects invalid port', () => {
      expect(() => loadEnv({ NODE_ENV: 'test', PORT: '99999' })).toThrow();
    });

    it('sets correct AI defaults', () => {
      const env = loadEnv({ NODE_ENV: 'test' });
      expect(env.AI_ENABLED).toBe(true);
      expect(env.AI_PROOF_CONFIDENCE_THRESHOLD).toBe(70);
      expect(env.AI_AUTO_VERIFY_THRESHOLD).toBe(80);
      expect(env.COOLING_PERIOD_DAYS).toBe(14);
      expect(env.MAX_REPROOF_ATTEMPTS).toBe(5);
    });

    it('disables AI with AI_ENABLED=false', () => {
      const env = loadEnv({ NODE_ENV: 'test', AI_ENABLED: 'false' });
      expect(env.AI_ENABLED).toBe(false);
    });

    it('disables AI with AI_ENABLED=0', () => {
      const env = loadEnv({ NODE_ENV: 'test', AI_ENABLED: '0' });
      expect(env.AI_ENABLED).toBe(false);
    });

    it('requires DATABASE_URL in production', () => {
      expect(() =>
        loadEnv({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'a'.repeat(64),
          JWT_REFRESH_SECRET: 'b'.repeat(64),
          CORS_ORIGINS: 'https://example.com',
        }),
      ).toThrow('DATABASE_URL');
    });

    it('requires CORS_ORIGINS in production', () => {
      expect(() =>
        loadEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://user:pass@host/db',
          JWT_ACCESS_SECRET: 'a'.repeat(64),
          JWT_REFRESH_SECRET: 'b'.repeat(64),
        }),
      ).toThrow('CORS_ORIGINS');
    });

    it('requires strong JWT secrets in production', () => {
      expect(() =>
        loadEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://user:pass@host/db',
          CORS_ORIGINS: 'https://example.com',
          JWT_ACCESS_SECRET: 'short',
          JWT_REFRESH_SECRET: 'b'.repeat(64),
        }),
      ).toThrow('JWT_ACCESS_SECRET');
    });
  });

  describe('parseCorsOrigins', () => {
    it('parses comma-separated origins', () => {
      const result = parseCorsOrigins('https://a.com, https://b.com');
      expect(result).toContain('https://a.com');
      expect(result).toContain('https://b.com');
    });

    it('strips trailing slashes', () => {
      const result = parseCorsOrigins('https://a.com/');
      expect(result).toContain('https://a.com');
    });

    it('returns empty array for empty string', () => {
      expect(parseCorsOrigins('')).toEqual([]);
    });

    it('handles wildcard patterns', () => {
      const result = parseCorsOrigins('.vercel.app');
      expect(result.length).toBe(1);
      expect(result[0]).toBe('.vercel.app');
    });

    it('strips outer quotes', () => {
      const result = parseCorsOrigins('"https://example.com"');
      expect(result).toContain('https://example.com');
    });

    it('normalizes URLs to origin only', () => {
      const result = parseCorsOrigins('https://example.com/api/v1');
      expect(result).toContain('https://example.com');
    });
  });
});
