import { User, Product, Order, Ticket } from '../types';
import { fixMojibakeDeep, maybeFixMojibake } from '../utils/mojibake';
import { getApiBaseUrl } from '../utils/apiBaseUrl';
import { isNetworkError, isTimeoutError, httpStatusToFriendlyMessage } from '../utils/errors';

// Real API Base URL
const API_URL = getApiBaseUrl();

/**
 * Extract a plain array from an API response that may be a paginated envelope
 * `{ data: T[] }` or a plain `T[]`.  Always returns a safe array.
 */
export function asArray<T = any>(response: unknown): T[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object' && Array.isArray((response as any).data)) {
    return (response as any).data;
  }
  return [];
}

export const TOKEN_STORAGE_KEY = 'mobo_tokens_v1';

function makeRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
      return (crypto as any).randomUUID() as string;
    }
  } catch {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function withRequestId(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers || {});
  if (!headers.has('x-request-id')) headers.set('x-request-id', makeRequestId());
  return { ...init, headers };
}

type TokenPair = { accessToken: string; refreshToken?: string };

let refreshPromise: Promise<TokenPair | null> | null = null;

const canUseStorage = () => typeof window !== 'undefined' && !!window.localStorage;

function notifyAuthChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('mobo-auth-changed'));
}

function readTokens(): TokenPair | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.accessToken !== 'string') return null;
    return parsed as TokenPair;
  } catch {
    return null;
  }
}

function writeTokens(tokens: TokenPair) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
    notifyAuthChange();
  } catch {
    // ignore storage failures
  }
}

function clearTokens() {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    notifyAuthChange();
  } catch {
    // ignore
  }
}

function authHeaders(): Record<string, string> {
  const tokens = readTokens();
  return tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {};
}

async function readPayloadSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isAuthError(res: Response, payload: any): boolean {
  const code = payload?.error?.code || payload?.code;
  return res.status === 401 || code === 'UNAUTHENTICATED' || code === 'INVALID_TOKEN';
}

/**
 * Event listeners for auth session expiry.
 * When a 401 cannot be recovered (refresh token also expired/invalid),
 * all registered callbacks fire so the UI can redirect to login.
 */
type AuthExpiredListener = () => void;
const authExpiredListeners = new Set<AuthExpiredListener>();

export function onAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener);
  return () => { authExpiredListeners.delete(listener); };
}

/**
 * Exported token helpers for use by realtime.ts (and tests).
 * All other callers should use the `api` object or `fetchJson` instead.
 */
export { readTokens, refreshTokens, notifyAuthExpired };

function notifyAuthExpired(): void {
  for (const fn of authExpiredListeners) {
    try { fn(); } catch { /* listener should not throw */ }
  }
}

async function refreshTokens(): Promise<TokenPair | null> {
  if (!canUseStorage()) return null;
  const current = readTokens();
  const refreshToken = current?.refreshToken;
  if (!refreshToken) return null;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(
          `${API_URL}/auth/refresh`,
          withRequestId({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
          })
        );
        const payload = await readPayloadSafe(res);
        if (!res.ok) throw toErrorFromPayload(payload, `Refresh failed: ${res.status}`);

        const tokens = payload?.tokens;
        if (tokens?.accessToken) {
          writeTokens({
            accessToken: String(tokens.accessToken),
            refreshToken: tokens.refreshToken ? String(tokens.refreshToken) : refreshToken,
          });
        }
        return readTokens();
      } catch {
        clearTokens();
        notifyAuthExpired();
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

function toErrorFromPayload(payload: any, fallback: string): Error {
  const message =
    payload?.error?.message ||
    payload?.message ||
    (typeof payload === 'string' ? payload : null) ||
    fallback;
  const err = new Error(maybeFixMojibake(String(message)));
  const code = payload?.error?.code || payload?.code;
  if (code) (err as any).code = code;
  const requestId = payload?.requestId || payload?.error?.requestId;
  if (requestId) (err as any).requestId = String(requestId);
  return err;
}

function isPwaGuardEnabled(): boolean {
  return typeof window !== 'undefined' && (globalThis as any).__MOBO_ENABLE_PWA_GUARDS__ === true;
}

function assertOnlineForWrite(init?: RequestInit) {
  if (!isPwaGuardEnabled()) return;

  const method = String(init?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  if (typeof navigator !== 'undefined' && navigator && 'onLine' in navigator && !navigator.onLine) {
    throw new Error('You appear to be offline. This action requires an internet connection.');
  }
}

/** Default request timeout (60s). Increased for AI endpoints that may take 15-45s. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Max retries for transient failures (502, 503, 429, network errors). */
const MAX_TRANSIENT_RETRIES = 2;

/** Base delay in ms for exponential backoff (doubled each retry). */
const RETRY_BASE_DELAY_MS = 800;

/** HTTP status codes that are safe to retry (server-side transient errors). */
const RETRYABLE_STATUS_CODES = new Set([502, 503, 429]);

/** Returns true if the method is idempotent and safe to retry automatically. */
function isIdempotentMethod(init?: RequestInit): boolean {
  const method = String(init?.method || 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

/** Sleep utility for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  // If the caller already provides an AbortSignal, respect it.
  if (init?.signal) return fetch(url, init).catch(wrapFetchError);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal })
    .catch(wrapFetchError)
    .finally(() => clearTimeout(timer));
}

/**
 * Fetch with automatic retry for transient failures (502, 503, 429, network errors).
 * Only retries idempotent requests (GET/HEAD/OPTIONS) to avoid duplicating side effects.
 * Uses exponential backoff: 800ms → 1600ms.
 */
async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  const canRetry = isIdempotentMethod(init);

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init);

      // Retry on transient server errors for idempotent requests only
      if (canRetry && RETRYABLE_STATUS_CODES.has(res.status) && attempt < MAX_TRANSIENT_RETRIES) {
        // Respect Retry-After header if present (cap at 10s)
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000 || RETRY_BASE_DELAY_MS, 10_000)
          : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      return res;
    } catch (err) {
      // Retry network/timeout errors for idempotent requests only
      if (canRetry && attempt < MAX_TRANSIENT_RETRIES && (isNetworkError(err) || isTimeoutError(err))) {
        await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
}

/** Convert raw fetch errors (network, abort) into user-friendly Error instances. */
function wrapFetchError(err: unknown): never {
  if (isTimeoutError(err)) {
    throw new Error('The request took too long. Please try again.');
  }
  if (isNetworkError(err)) {
    throw new Error('Unable to connect. Please check your internet connection and try again.');
  }
  throw err;
}

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  assertOnlineForWrite(init);
  const res = await fetchWithRetry(`${API_URL}${path}`, withRequestId(init));
  const payload = await readPayloadSafe(res);

  if (!res.ok && isAuthError(res, payload)) {
    const refreshed = await refreshTokens();
    if (refreshed?.accessToken) {
      const retryInit: RequestInit = {
        ...init,
        headers: { ...(init?.headers || {}), Authorization: `Bearer ${refreshed.accessToken}` },
      };
      const retryRes = await fetchWithRetry(`${API_URL}${path}`, withRequestId(retryInit));
      const retryPayload = await readPayloadSafe(retryRes);
      if (!retryRes.ok) throw toErrorFromPayload(retryPayload, httpStatusToFriendlyMessage(retryRes.status));
      return fixMojibakeDeep(retryPayload);
    }
    // Refresh failed — session is dead. Notify listeners (AuthContext) for redirect.
    notifyAuthExpired();
    throw toErrorFromPayload(payload, 'Your session has expired. Please log in again.');
  }

  if (!res.ok) throw toErrorFromPayload(payload, httpStatusToFriendlyMessage(res.status));
  return fixMojibakeDeep(payload);
}

async function fetchOk(path: string, init?: RequestInit): Promise<void> {
  assertOnlineForWrite(init);
  const res = await fetchWithRetry(`${API_URL}${path}`, withRequestId(init));
  const payload = await readPayloadSafe(res);

  if (!res.ok && isAuthError(res, payload)) {
    const refreshed = await refreshTokens();
    if (refreshed?.accessToken) {
      const retryInit: RequestInit = {
        ...init,
        headers: { ...(init?.headers || {}), Authorization: `Bearer ${refreshed.accessToken}` },
      };
      const retryRes = await fetchWithRetry(`${API_URL}${path}`, withRequestId(retryInit));
      const retryPayload = await readPayloadSafe(retryRes);
      if (!retryRes.ok) throw toErrorFromPayload(retryPayload, httpStatusToFriendlyMessage(retryRes.status));
      return;
    }
    // Refresh failed — session is dead. Notify listeners.
    notifyAuthExpired();
    throw toErrorFromPayload(payload, 'Your session has expired. Please log in again.');
  }

  if (!res.ok) throw toErrorFromPayload(payload, httpStatusToFriendlyMessage(res.status));
}

function unwrapAuthResponse(payload: any): any {
  // Supports either: { user, tokens } or direct user JSON.
  if (payload && typeof payload === 'object' && payload.user) {
    const tokens = payload.tokens;
    if (tokens?.accessToken) {
      writeTokens({
        accessToken: String(tokens.accessToken),
        refreshToken: tokens.refreshToken ? String(tokens.refreshToken) : undefined,
      });
    }
    const u = payload.user;
    if (u && typeof u === 'object' && typeof u.role === 'string') {
      // Backend uses `shopper`; UI expects legacy `user`.
      if (u.role === 'shopper') u.role = 'user';
    }
    // Normalize optional wallet fields expected by UI.
    if (u && typeof u === 'object') {
      if (typeof u.walletBalance === 'undefined') u.walletBalance = 0;
      if (typeof u.walletPending === 'undefined') u.walletPending = 0;
    }
    return u;
  }
  if (payload && typeof payload === 'object' && typeof payload.role === 'string') {
    if (payload.role === 'shopper') payload.role = 'user';
    if (typeof payload.walletBalance === 'undefined') payload.walletBalance = 0;
    if (typeof payload.walletPending === 'undefined') payload.walletPending = 0;
  }
  return payload;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Client-side image compression using <canvas>.
 * Resizes large images down to `maxDimension` (default 1200px) and
 * re-encodes as JPEG at `quality` (default 0.7).
 * This reduces upload payload size and AI token consumption.
 * Falls back to returning the original if compression fails (e.g. SSR).
 */
export const compressImage = async (
  base64: string,
  options: { maxDimension?: number; quality?: number } = {}
): Promise<string> => {
  // Only compress in the browser where we have canvas
  if (typeof document === 'undefined' || typeof Image === 'undefined') return base64;

  const maxDimension = options.maxDimension ?? 1200;
  const quality = options.quality ?? 0.7;

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to load image for compression'));
      image.src = base64;
    });

    const { width, height } = img;

    // Skip compression for images already small enough
    if (width <= maxDimension && height <= maxDimension) return base64;

    const scale = maxDimension / Math.max(width, height);
    const newWidth = Math.round(width * scale);
    const newHeight = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = newWidth;
    canvas.height = newHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return base64;

    ctx.drawImage(img, 0, 0, newWidth, newHeight);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    // Silently fall back to original if anything goes wrong
    return base64;
  }
};

/**
 * PRODUCTION API HANDLER
 * [FIX] Fully expanded the api object to include all methods used in the UI components
 * that were previously missing, causing "Property does not exist" errors.
 */
export const api = {
  auth: {
    me: async () => {
      const data = await fetchJson('/auth/me', {
        headers: { ...authHeaders() },
      });
      return unwrapAuthResponse(data);
    },
    login: async (mobile: string, pass: string) => {
      const data = await fetchJson('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, password: pass }),
      });
      return unwrapAuthResponse(data);
    },

    loginAdmin: async (username: string, pass: string) => {
      const data = await fetchJson('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pass }),
      });
      return unwrapAuthResponse(data);
    },
    /** [FIX] Added missing register method for AuthContext.tsx */
    register: async (name: string, mobile: string, pass: string, mediatorCode: string) => {
      const data = await fetchJson('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mobile, password: pass, mediatorCode }),
      });
      return unwrapAuthResponse(data);
    },
    /** [FIX] Added missing registerOps method for AuthContext.tsx */
    registerOps: async (name: string, mobile: string, pass: string, role: string, code: string) => {
      const data = await fetchJson('/auth/register-ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mobile, password: pass, role, code }),
      });

      // Mediator join via agency code returns an accepted-but-pending response.
      if (data && typeof data === 'object' && data.pendingApproval) {
        return {
          pendingApproval: true,
          message: typeof data.message === 'string' ? data.message : 'Pending approval',
        };
      }

      return unwrapAuthResponse(data);
    },
    /** [FIX] Added missing registerBrand method for AuthContext.tsx */
    registerBrand: async (name: string, mobile: string, pass: string, brandCode: string) => {
      const data = await fetchJson('/auth/register-brand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mobile, password: pass, brandCode }),
      });
      return unwrapAuthResponse(data);
    },
    updateProfile: async (userId: string, updates: Partial<User>) => {
      const data = await fetchJson('/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ userId, ...updates }),
      });
      return unwrapAuthResponse(data);
    },
  },
  products: {
    getAll: async (mediatorCode?: string) => {
      const query = mediatorCode ? `?mediatorCode=${encodeURIComponent(mediatorCode)}` : '';
      const data = await fetchJson(`/products${query}`, {
        headers: { ...authHeaders() },
      });
      return Array.isArray(data) ? data : [];
    },
  },
  orders: {
    /** [FIX] Added missing getUserOrders for Chatbot and Orders components */
    getUserOrders: async (userId: string) => {
      return fetchJson(`/orders/user/${encodeURIComponent(userId)}`, {
        headers: { ...authHeaders() },
      });
    },
    create: async (userId: string, items: any[], metadata: any) => {
      return fetchJson('/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ userId, items, ...metadata }),
      });
    },
    /** [FIX] Added missing submitClaim for Orders.tsx */
    submitClaim: async (orderId: string, proof: { type: string; data: string }) => {
      return fetchJson('/orders/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId, ...proof }),
      });
    },
    /** Get audit trail / activity log for a specific order */
    getOrderAudit: async (orderId: string) => {
      return fetchJson(`/orders/${encodeURIComponent(orderId)}/audit`, {
        headers: { ...authHeaders() },
      });
    },
    /** [FIX] Added missing extractDetails for Orders.tsx */
    extractDetails: async (file: File) => {
      const rawBase64 = await readFileAsDataUrl(file);
      // Compress before sending — phone screenshots can be 5-15 MB raw,
      // exceeding the Vercel proxy 4.5 MB body limit.
      // Use higher quality for extraction accuracy — OCR needs sharp text.
      const compressed = await compressImage(rawBase64, { maxDimension: 2400, quality: 0.92 });
      // Client-side timeout: 35 seconds. Prevents infinite waiting when Render cold-starts
      // or extraction runs long. The backend has its own 22s internal deadline.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35_000);
      try {
        return await fetchJson('/ai/extract-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ imageBase64: compressed }),
          signal: controller.signal,
        });
      } catch (err: any) {
        if (err?.name === 'AbortError' || controller.signal.aborted) {
          throw new Error('Screenshot analysis timed out. The server may be starting up — please try again in 30 seconds.');
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    },
    /** Pre-validate rating screenshot: checks account name + product name match */
    verifyRating: async (file: File, expectedBuyerName: string, expectedProductName: string, expectedReviewerName?: string) => {
      const rawBase64 = await readFileAsDataUrl(file);
      // Compress before sending to stay under Vercel proxy body limit.
      const compressed = await compressImage(rawBase64, { maxDimension: 1600, quality: 0.8 });
      return fetchJson('/ai/verify-rating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ imageBase64: compressed, expectedBuyerName, expectedProductName, ...(expectedReviewerName ? { expectedReviewerName } : {}) }),
      });
    },
  },
  chat: {
    /** [FIX] Updated signature to 7 arguments to match call in Chatbot.tsx */
    sendMessage: async (
      message: string,
      userId: string,
      userName: string,
      products: Product[],
      orders: Order[],
      tickets: Ticket[],
      image?: string,
      history?: Array<{ role: 'user' | 'assistant'; content: string }>,
      signal?: AbortSignal,
    ) => {
      return fetchJson('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          message,
          userId,
          userName,
          products,
          orders,
          tickets,
          image,
          history,
        }),
        signal,
      });
    },
  },
  ops: {
    /** [FIX] Expanded ops object with all methods used by MediatorDashboard and AgencyDashboard */
    getMediators: async (agencyCode: string, opts?: { search?: string }) => {
      const params = new URLSearchParams({ agencyCode });
      if (opts?.search) params.set('search', opts.search);
      return fetchJson(`/ops/mediators?${params}`, {
        headers: { ...authHeaders() },
      });
    },
    getCampaigns: async (mediatorCode?: string) => {
      const query = mediatorCode ? `?mediatorCode=${encodeURIComponent(mediatorCode)}` : '';
      return fetchJson(`/ops/campaigns${query}`, {
        headers: { ...authHeaders() },
      });
    },
    getDeals: async (mediatorCode: string, role?: string) => {
      const query = role
        ? `?mediatorCode=${encodeURIComponent(mediatorCode)}&role=${encodeURIComponent(role)}`
        : `?mediatorCode=${encodeURIComponent(mediatorCode)}`;
      return fetchJson(`/ops/deals${query}`, {
        headers: { ...authHeaders() },
      });
    },
    getMediatorOrders: async (mediatorCode: string, role?: string) => {
      const query = role
        ? `?mediatorCode=${encodeURIComponent(mediatorCode)}&role=${encodeURIComponent(role)}`
        : `?mediatorCode=${encodeURIComponent(mediatorCode)}`;
      return fetchJson(`/ops/orders${query}`, {
        headers: { ...authHeaders() },
      });
    },
    getPendingUsers: async (code: string) => {
      return fetchJson(`/ops/users/pending?code=${encodeURIComponent(code)}`, {
        headers: { ...authHeaders() },
      });
    },
    getVerifiedUsers: async (code: string) => {
      return fetchJson(`/ops/users/verified?code=${encodeURIComponent(code)}`, {
        headers: { ...authHeaders() },
      });
    },
    getAgencyLedger: async () => {
      return fetchJson('/ops/ledger', {
        headers: { ...authHeaders() },
      });
    },
    approveMediator: async (id: string) => {
      await fetchOk('/ops/mediators/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id }),
      });
    },
    rejectMediator: async (id: string) => {
      await fetchOk('/ops/mediators/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id }),
      });
    },
    approveUser: async (id: string) => {
      await fetchOk('/ops/users/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id }),
      });
    },
    rejectUser: async (id: string) => {
      await fetchOk('/ops/users/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id }),
      });
    },
    settleOrderPayment: async (orderId: string, settlementRef?: string, settlementMode?: 'wallet' | 'external') => {
      await fetchOk('/ops/orders/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId, settlementRef, settlementMode }),
      });
    },
    unsettleOrderPayment: async (orderId: string) => {
      await fetchOk('/ops/orders/unsettle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId }),
      });
    },
    verifyOrderClaim: async (orderId: string) => {
      return fetchJson('/ops/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId }),
      });
    },
    verifyOrderRequirement: async (orderId: string, type: 'review' | 'rating' | 'returnWindow') => {
      return fetchJson('/ops/orders/verify-requirement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId, type }),
      });
    },
    verifyAllSteps: async (orderId: string) => {
      return fetchJson('/ops/orders/verify-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId }),
      });
    },
    rejectOrderProof: async (orderId: string, type: 'order' | 'review' | 'rating' | 'returnWindow', reason: string) => {
      return fetchJson('/ops/orders/reject-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId, type, reason }),
      });
    },
    requestMissingProof: async (orderId: string, type: 'review' | 'rating' | 'returnWindow', note?: string) => {
      return fetchJson('/ops/orders/request-proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ orderId, type, note }),
      });
    },
    createCampaign: async (data: any) => {
      return fetchJson('/ops/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
    },
    updateCampaignStatus: async (campaignId: string, status: string) => {
      return fetchJson(`/ops/campaigns/${campaignId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status }),
      });
    },
    deleteCampaign: async (campaignId: string) => {
      await fetchOk(`/ops/campaigns/${encodeURIComponent(campaignId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
    },
    copyCampaign: async (campaignId: string) => {
      const data = await fetchJson('/ops/campaigns/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: campaignId }),
      });
      return data;
    },
    declineOffer: async (campaignId: string) => {
      await fetchOk('/ops/campaigns/decline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: campaignId }),
      });
    },
    assignSlots: async (
      id: string,
      assignments: any,
      dealType?: string,
      price?: number,
      payout?: number,
      commission?: number
    ) => {
      await fetchOk('/ops/campaigns/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id, assignments, dealType, price, payout, commission }),
      });
    },
    publishDeal: async (id: string, commission: number | undefined, mediatorCode: string) => {
      await fetchOk('/ops/deals/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id, commission: Number.isFinite(commission as number) ? commission : 0, mediatorCode }),
      });
    },
    payoutMediator: async (mediatorId: string, amount: number) => {
      await fetchOk('/ops/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ mediatorId, amount }),
      });
    },
    deletePayout: async (payoutId: string) => {
      await fetchOk(`/ops/payouts/${encodeURIComponent(payoutId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
    },
    generateMediatorInvite: async (agencyId: string) => {
      const data = await fetchJson('/ops/invites/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agencyId }),
      });
      return data?.code;
    },
    generateBuyerInvite: async (mediatorId: string) => {
      const data = await fetchJson('/ops/invites/generate-buyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ mediatorId }),
      });
      return data?.code;
    },
    connectBrand: async (brandCode: string) => {
      return fetchJson('/ops/brands/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ brandCode }),
      });
    },
  },
  /** [FIX] Added missing brand object used in BrandDashboard.tsx */
  brand: {
    getConnectedAgencies: async (brandId: string) => {
      return fetchJson(`/brand/agencies?brandId=${encodeURIComponent(brandId)}`, {
        headers: { ...authHeaders() },
      });
    },
    getBrandCampaigns: async (brandId: string) => {
      return fetchJson(`/brand/campaigns?brandId=${encodeURIComponent(brandId)}`, {
        headers: { ...authHeaders() },
      });
    },
    getBrandOrders: async (brandName: string) => {
      return fetchJson(`/brand/orders?brandName=${encodeURIComponent(brandName)}`, {
        headers: { ...authHeaders() },
      });
    },
    getTransactions: async (brandId: string) => {
      return fetchJson(`/brand/transactions?brandId=${encodeURIComponent(brandId)}`, {
        headers: { ...authHeaders() },
      });
    },
    payoutAgency: async (brandId: string, agencyId: string, amount: number, ref: string) => {
      return fetchJson('/brand/payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ brandId, agencyId, amount, ref }),
      });
    },
    resolveConnectionRequest: async (brandId: string, agencyId: string, action: string) => {
      await fetchOk('/brand/requests/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ brandId, agencyId, action }),
      });
    },
    removeAgency: async (brandId: string, agencyCode: string) => {
      await fetchOk('/brand/agencies/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ brandId, agencyCode }),
      });
    },
    createCampaign: async (data: any) => {
      return fetchJson('/brand/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
    },
    updateCampaign: async (campaignId: string, data: any) => {
      return fetchJson(`/brand/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
    },
    deleteCampaign: async (campaignId: string) => {
      await fetchOk(`/brand/campaigns/${encodeURIComponent(campaignId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
    },
    copyCampaign: async (campaignId: string) => {
      const data = await fetchJson('/brand/campaigns/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: campaignId }),
      });
      return data;
    },
  },
  admin: {
    getStats: async () =>
      fetchJson('/admin/stats', {
        headers: { ...authHeaders() },
      }),
    /** [FIX] Updated getUsers to accept an optional role argument for AdminPortal.tsx */
    getUsers: async (role: string = 'all', opts?: { search?: string; status?: string }) => {
      const params = new URLSearchParams({ role });
      if (opts?.search) params.set('search', opts.search);
      if (opts?.status) params.set('status', opts.status);
      return fetchJson(`/admin/users?${params}`, {
        headers: { ...authHeaders() },
      });
    },
    /** [FIX] Added missing admin methods used in AdminPortal.tsx */
    getFinancials: async (opts?: { status?: string }) => {
      const params = new URLSearchParams();
      if (opts?.status) params.set('status', opts.status);
      const qs = params.toString();
      return fetchJson(`/admin/financials${qs ? '?' + qs : ''}`, {
        headers: { ...authHeaders() },
      });
    },
    getProducts: async (opts?: { search?: string; active?: string }) => {
      const params = new URLSearchParams();
      if (opts?.search) params.set('search', opts.search);
      if (opts?.active) params.set('active', opts.active);
      const qs = params.toString();
      return fetchJson(`/admin/products${qs ? '?' + qs : ''}`, {
        headers: { ...authHeaders() },
      });
    },
    deleteProduct: async (dealId: string) => {
      await fetchOk(`/admin/products/${encodeURIComponent(dealId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders(), 'X-Confirm-Delete': 'true' },
      });
    },
    getGrowthAnalytics: async () =>
      fetchJson('/admin/growth', {
        headers: { ...authHeaders() },
      }),
    getInvites: async () =>
      fetchJson('/admin/invites', {
        headers: { ...authHeaders() },
      }),
    getConfig: async () =>
      fetchJson('/admin/config', {
        headers: { ...authHeaders() },
      }),
    updateConfig: async (updates: { adminContactEmail?: string }) =>
      fetchJson('/admin/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(updates),
      }),
    generateInvite: async (role: string, label: string) => {
      return fetchJson('/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ role, label }),
      });
    },
    deleteInvite: async (code: string) => {
      await fetchOk(`/admin/invites/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
    },
    updateUserStatus: async (userId: string, status: string) => {
      await fetchOk('/admin/users/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ userId, status }),
      });
    },
    deleteUser: async (userId: string) => {
      await fetchOk(`/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders(), 'X-Confirm-Delete': 'true' },
      });
    },
    deleteWallet: async (userId: string) => {
      await fetchOk(`/admin/wallets/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders(), 'X-Confirm-Delete': 'true' },
      });
    },
    getAuditLogs: async (filters?: { action?: string; entityType?: string; limit?: number; page?: number; from?: string; to?: string }) => {
      const params = new URLSearchParams();
      if (filters?.action) params.append('action', filters.action);
      if (filters?.entityType) params.append('entityType', filters.entityType);
      if (filters?.limit) params.append('limit', String(filters.limit));
      if (filters?.page) params.append('page', String(filters.page));
      if (filters?.from) params.append('from', filters.from);
      if (filters?.to) params.append('to', filters.to);
      const qs = params.toString();
      return fetchJson(`/admin/audit-logs${qs ? '?' + qs : ''}`, {
        headers: { ...authHeaders() },
      });
    },
  },
  /** [FIX] Added missing tickets object used across various dashboards */
  tickets: {
    getAll: async () =>
      fetchJson('/tickets', {
        headers: { ...authHeaders() },
      }),
    getIssueTypes: async () =>
      fetchJson('/tickets/issue-types', {
        headers: { ...authHeaders() },
      }),
    create: async (data: any) => {
      await fetchOk('/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
    },
    update: async (id: string, status: string, resolutionNote?: string) => {
      await fetchOk(`/tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status, ...(resolutionNote ? { resolutionNote } : {}) }),
      });
    },
    escalate: async (id: string) => {
      await fetchOk(`/tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status: 'Open', escalate: true }),
      });
    },
    delete: async (id: string) => {
      await fetchOk(`/tickets/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
    },
  },
  /** AI-powered features for chat and proof verification */
  ai: {
    chat: async (payload: {
      message: string;
      userName?: string;
      products?: any[];
      orders?: any[];
      tickets?: any[];
      image?: string;
    }) => {
      return fetchJson('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
      });
    },
  },

  notifications: {
    list: async () => {
      return fetchJson('/notifications', {
        method: 'GET',
        headers: { ...authHeaders() },
      });
    },
    push: {
      publicKey: async () => {
        return fetchJson('/notifications/push/public-key', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
      },
      subscribe: async (payload: {
        app: 'buyer' | 'mediator';
        subscription: {
          endpoint: string;
          expirationTime?: number | null;
          keys: { p256dh: string; auth: string };
        };
        userAgent?: string;
      }) => {
        await fetchOk('/notifications/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(payload),
        });
      },
      unsubscribe: async (endpoint: string) => {
        await fetchOk('/notifications/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ endpoint }),
        });
      },
    },
  },

  /** ── Google Sheets Export ─────────────────────────────────── */
  sheets: {
    /** Export data to a new Google Spreadsheet. Returns spreadsheet URL. */
    export: async (data: {
      title: string;
      headers: string[];
      rows: (string | number)[][];
      sheetName?: string;
    }): Promise<{ spreadsheetId: string; spreadsheetUrl: string; sheetTitle: string }> => {
      return fetchJson('/sheets/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(data),
      });
    },
  },

  /** ── Google OAuth (for user-level Sheets export to their own Drive) ── */
  google: {
    /** Get the Google OAuth consent URL. Frontend opens this in a popup. */
    getAuthUrl: async (): Promise<{ url: string }> => {
      return fetchJson('/google/auth', {
        headers: authHeaders(),
      });
    },
    /** Check if the current user has a Google account connected. */
    getStatus: async (): Promise<{ connected: boolean; googleEmail: string | null }> => {
      return fetchJson('/google/status', {
        headers: authHeaders(),
      });
    },
    /** Disconnect the user's Google account. */
    disconnect: async (): Promise<{ ok: boolean }> => {
      return fetchJson('/google/disconnect', {
        method: 'POST',
        headers: authHeaders(),
      });
    },
  },
};
