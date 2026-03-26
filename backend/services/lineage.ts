import { prisma } from '../database/prisma.js';

// ─── Simple TTL cache for hierarchical lookups ─────────────────────────
const LINEAGE_TTL_MS = 60_000; // 60 seconds
interface CacheEntry<T> { value: T; expiresAt: number; }

const mediatorCodesCache = new Map<string, CacheEntry<string[]>>();
const agencyCodeCache = new Map<string, CacheEntry<string | null>>();
const activeCache = new Map<string, CacheEntry<boolean>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  return getCachedLRU(cache, key);
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  // LRU eviction: first key is least-recently-accessed (promoted on read in getCached)
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  cache.set(key, { value, expiresAt: Date.now() + LINEAGE_TTL_MS });
}

/** Promote entry on read for LRU behaviour */
function getCachedLRU<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return undefined; }
  // LRU promotion: move to end of Map iteration order
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

/** Clear all lineage caches (call on user/role mutations) */
export function clearLineageCache(): void {
  mediatorCodesCache.clear();
  agencyCodeCache.clear();
  activeCache.clear();
}

/** Purge expired entries from all lineage caches */
function purgeExpiredEntries(): void {
  const now = Date.now();
  for (const cache of [mediatorCodesCache, agencyCodeCache, activeCache]) {
    for (const [key, entry] of cache) {
      if (now > (entry as CacheEntry<unknown>).expiresAt) cache.delete(key);
    }
  }
}

// Background cleanup every 5 minutes to prevent stale entry accumulation
const _lineageCacheCleanup = setInterval(purgeExpiredEntries, 5 * 60_000);
if (typeof _lineageCacheCleanup.unref === 'function') _lineageCacheCleanup.unref();
// ───────────────────────────────────────────────────────────────────────

export async function listMediatorCodesForAgency(agencyCode: string): Promise<string[]> {
  if (!agencyCode) return [];
  const cached = getCached(mediatorCodesCache, agencyCode);
  if (cached !== undefined) return cached;
  const db = prisma();
  const mediators = await db.user.findMany({
    where: { roles: { has: 'mediator' as any }, parentCode: agencyCode, isDeleted: false },
    select: { mediatorCode: true },
  });
  const codes = mediators.map((m) => String(m.mediatorCode || '')).filter(Boolean);
  setCached(mediatorCodesCache, agencyCode, codes);
  return codes;
}

export async function getAgencyCodeForMediatorCode(mediatorCode: string): Promise<string | null> {
  if (!mediatorCode) return null;
  const cached = getCached(agencyCodeCache, mediatorCode);
  if (cached !== undefined) return cached;
  const db = prisma();
  const mediator = await db.user.findFirst({
    where: { roles: { has: 'mediator' as any }, mediatorCode, isDeleted: false },
    select: { parentCode: true },
  });
  const agencyCode = mediator ? String(mediator.parentCode || '').trim() : '';
  const result = agencyCode || null;
  setCached(agencyCodeCache, mediatorCode, result);
  return result;
}

/** Batch version: resolve multiple mediator codes → agency codes in one query */
export async function getAgencyCodesForMediatorCodes(mediatorCodes: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const uncached: string[] = [];
  for (const code of mediatorCodes) {
    if (!code) { result.set(code, null); continue; }
    const cached = getCached(agencyCodeCache, code);
    if (cached !== undefined) { result.set(code, cached); } else { uncached.push(code); }
  }
  if (uncached.length > 0) {
    const db = prisma();
    const mediators = await db.user.findMany({
      where: { roles: { has: 'mediator' as any }, mediatorCode: { in: uncached }, isDeleted: false },
      select: { mediatorCode: true, parentCode: true },
    });
    const byCode = new Map(mediators.map((m) => [String(m.mediatorCode), String(m.parentCode || '').trim() || null]));
    for (const code of uncached) {
      const agencyCode = byCode.get(code) ?? null;
      setCached(agencyCodeCache, code, agencyCode);
      result.set(code, agencyCode);
    }
  }
  return result;
}

export async function isAgencyActive(agencyCode: string): Promise<boolean> {
  if (!agencyCode) return false;
  const cached = getCached(activeCache, `agency:${agencyCode}`);
  if (cached !== undefined) return cached;
  const db = prisma();
  const agency = await db.user.findFirst({
    where: { roles: { has: 'agency' as any }, mediatorCode: agencyCode, isDeleted: false },
    select: { status: true },
  });
  const result = !!agency && agency.status === 'active';
  setCached(activeCache, `agency:${agencyCode}`, result);
  return result;
}

export async function isMediatorActive(mediatorCode: string): Promise<boolean> {
  if (!mediatorCode) return false;
  const cached = getCached(activeCache, `mediator:${mediatorCode}`);
  if (cached !== undefined) return cached;
  const db = prisma();
  const mediator = await db.user.findFirst({
    where: { roles: { has: 'mediator' as any }, mediatorCode, isDeleted: false },
    select: { status: true },
  });
  const result = !!mediator && mediator.status === 'active';
  setCached(activeCache, `mediator:${mediatorCode}`, result);
  return result;
}
