import { describe, it, expect, beforeEach } from 'vitest';
import { authCacheGet, authCacheSet, authCacheInvalidate, authCacheClear, authCacheStats } from '../../utils/authCache.js';

describe('authCache', () => {
  beforeEach(() => {
    authCacheClear();
  });

  it('stores and retrieves values', () => {
    authCacheSet('user-1', { roles: ['admin'], status: 'active' });
    const result = authCacheGet('user-1');
    expect(result).toEqual({ roles: ['admin'], status: 'active' });
  });

  it('returns undefined for missing keys', () => {
    expect(authCacheGet('nonexistent')).toBeUndefined();
  });

  it('invalidates specific user', () => {
    authCacheSet('user-1', { roles: ['admin'] });
    authCacheSet('user-2', { roles: ['brand'] });
    authCacheInvalidate('user-1');
    expect(authCacheGet('user-1')).toBeUndefined();
    expect(authCacheGet('user-2')).toEqual({ roles: ['brand'] });
  });

  it('clears all entries', () => {
    authCacheSet('user-1', { roles: ['admin'] });
    authCacheSet('user-2', { roles: ['brand'] });
    authCacheClear();
    expect(authCacheGet('user-1')).toBeUndefined();
    expect(authCacheGet('user-2')).toBeUndefined();
  });

  it('reports cache statistics', () => {
    authCacheSet('user-1', { roles: ['admin'] });
    authCacheGet('user-1'); // hit
    authCacheGet('user-2'); // miss
    const stats = authCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(50);
  });

  it('resets stats on clear', () => {
    authCacheSet('user-1', { test: true });
    authCacheGet('user-1');
    authCacheClear();
    const stats = authCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(0);
  });

  it('overwrites existing entries', () => {
    authCacheSet('user-1', { version: 1 });
    authCacheSet('user-1', { version: 2 });
    expect(authCacheGet('user-1')).toEqual({ version: 2 });
  });
});
