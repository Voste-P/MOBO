import { GoogleGenAI, Type } from '@google/genai';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../config/env.js';
import { aiLog } from '../config/logger.js';
import { logPerformance, logErrorEvent } from '../config/appLogs.js';

// ── Tesseract Worker Pool ──
// Reuse workers across OCR calls instead of creating/terminating per request.
// This avoids repeated WASM init + eng.traineddata download on every OCR call.

const __ocrDirname = path.dirname(fileURLToPath(import.meta.url));
// In dist/ the compiled JS lives at dist/services/aiService.js → go up 2 levels to backend/
// In source (tsx watch) it lives at services/aiService.ts → go up 1 level to backend/
const __backendRoot = path.basename(path.resolve(__ocrDirname, '..')) === 'dist'
  ? path.resolve(__ocrDirname, '..', '..')
  : path.resolve(__ocrDirname, '..');

// Use local eng.traineddata to avoid CDN downloads in production
const LOCAL_LANG_PATH = path.join(__backendRoot, '/');

let OCR_POOL_SIZE = 2; // overridden by env.AI_OCR_POOL_SIZE at first call
const _ocrPool: Array<Awaited<ReturnType<typeof createWorker>>> = [];
let _ocrPoolReady: Promise<void> | null = null;
let _ocrPoolInitializing = false;

// ── Gemini Circuit Breaker ──
// After consecutive Gemini failures, skip directly to OCR fallback for a cooldown period.
let _geminiConsecutiveFails = 0;
let _geminiLastFailTimestamp = 0;
let _circuitBreakerThreshold = 3;      // overridden by env
let _circuitBreakerCooldownMs = 300_000; // 5 min, overridden by env

/** Circuit state for proper half-open handling. */
let _circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

function isGeminiCircuitOpen(): boolean {
  if (_circuitState === 'CLOSED') return false;
  if (_circuitState === 'HALF_OPEN') return false; // allow one probe request

  // Circuit is OPEN — check if cooldown has expired
  const elapsed = Date.now() - _geminiLastFailTimestamp;
  if (elapsed >= _circuitBreakerCooldownMs) {
    // Transition to HALF_OPEN: allow exactly one probe request
    _circuitState = 'HALF_OPEN';
    aiLog.info(`[Circuit Breaker] HALF_OPEN — allowing probe request after ${Math.round(elapsed / 1000)}s cooldown`);
    return false;
  }
  return true; // circuit is OPEN → skip Gemini
}

function recordGeminiSuccess(): void {
  if (_circuitState === 'HALF_OPEN') {
    aiLog.info('[Circuit Breaker] CLOSED — probe request succeeded');
  }
  _geminiConsecutiveFails = 0;
  _circuitState = 'CLOSED';
}

function recordGeminiFailure(): void {
  _geminiConsecutiveFails++;
  _geminiLastFailTimestamp = Date.now();
  if (_circuitState === 'HALF_OPEN') {
    // Probe failed — immediately re-open the circuit
    _circuitState = 'OPEN';
    aiLog.warn(`[Circuit Breaker] OPEN (probe failed) — re-opening for ${_circuitBreakerCooldownMs / 1000}s.`);
  } else if (_geminiConsecutiveFails >= _circuitBreakerThreshold) {
    _circuitState = 'OPEN';
    aiLog.warn(`[Circuit Breaker] OPEN — ${_geminiConsecutiveFails} consecutive Gemini failures. Skipping Gemini for ${_circuitBreakerCooldownMs / 1000}s.`);
  }
}

// ── Confidence Score Constants ──
// Named constants for AI confidence scoring thresholds used across all verification pipelines.
const CONFIDENCE = {
  /** Minimum confidence to consider an extraction "usable" */
  OCR_BASE: 30,
  OCR_ORDER_ID_BONUS: 30,
  OCR_AMOUNT_BONUS: 25,
  OCR_BOTH_BONUS: 10,
  OCR_MAX_CAP: 95,
  RATING_BASE: 20,
  RATING_FIELD_WEIGHT: 35,
  RETURN_WINDOW_BASE: 15,
  RETURN_WINDOW_ORDER_BONUS: 20,
  RETURN_WINDOW_PRODUCT_WEIGHT: 20,
  RETURN_WINDOW_AMOUNT_BONUS: 15,
  RETURN_WINDOW_SOLD_BONUS: 10,
  RETURN_WINDOW_CLOSED_BONUS: 10,
  /** Fallback score when no fields extracted */
  FALLBACK_NONE: 25,
  /** Minimum usable AI fallback score */
  FALLBACK_LOW: 10,
  FALLBACK_OCR_ONLY: 15,
} as const;

/** Call once at startup or first AI request to sync env-driven config values. */
export function initAiServiceConfig(env: { AI_OCR_POOL_SIZE?: number; AI_CIRCUIT_BREAKER_THRESHOLD?: number; AI_CIRCUIT_BREAKER_COOLDOWN_MS?: number }): void {
  if (env.AI_OCR_POOL_SIZE) OCR_POOL_SIZE = env.AI_OCR_POOL_SIZE;
  if (env.AI_CIRCUIT_BREAKER_THRESHOLD) _circuitBreakerThreshold = env.AI_CIRCUIT_BREAKER_THRESHOLD;
  if (env.AI_CIRCUIT_BREAKER_COOLDOWN_MS) _circuitBreakerCooldownMs = env.AI_CIRCUIT_BREAKER_COOLDOWN_MS;
}

async function _initOcrPool(): Promise<void> {
  if (_ocrPool.length >= OCR_POOL_SIZE || _ocrPoolInitializing) return;
  _ocrPoolInitializing = true;
  try {
    const promises: Promise<void>[] = [];
    for (let i = _ocrPool.length; i < OCR_POOL_SIZE; i++) {
      promises.push(
        createWorker('eng', undefined, { langPath: LOCAL_LANG_PATH })
          .then((w) => { _ocrPool.push(w); })
          .catch((err) => {
            aiLog.warn('Failed to init Tesseract worker (will create on-demand)', { error: err });
          })
      );
    }
    await Promise.allSettled(promises);
  } finally {
    _ocrPoolInitializing = false;
  }
}

/** Maximum total OCR workers (pool + temporary) to prevent OOM under burst load. */
function getMaxOcrWorkers(): number { return Math.max(OCR_POOL_SIZE + 4, 8); }
let _activeOcrWorkerCount = 0;

/** Get a worker from the pool or create a fresh one on demand (bounded). */
async function acquireOcrWorker(): Promise<Awaited<ReturnType<typeof createWorker>>> {
  // Lazy-init pool on first call
  if (!_ocrPoolReady) _ocrPoolReady = _initOcrPool();
  await _ocrPoolReady;

  const w = _ocrPool.pop();
  if (w) {
    _activeOcrWorkerCount++;
    return w;
  }

  const maxWorkers = getMaxOcrWorkers();
  // Cap total workers to prevent memory exhaustion
  if (_activeOcrWorkerCount >= maxWorkers) {
    aiLog.warn(`[OCR] Worker limit reached (${_activeOcrWorkerCount}/${maxWorkers}). Waiting for release...`);
    // Wait briefly for a worker to be returned to the pool
    await new Promise((r) => setTimeout(r, 500));
    const retryW = _ocrPool.pop();
    if (retryW) { _activeOcrWorkerCount++; return retryW; }
    // Hard-reject instead of creating overflow workers — prevents OOM on Render
    throw new Error('OCR_CAPACITY_EXCEEDED: All OCR workers are busy. Please try again shortly.');
  }

  _activeOcrWorkerCount++;
  // Pool exhausted — create a temporary worker
  return createWorker('eng', undefined, { langPath: LOCAL_LANG_PATH });
}

/** Return a worker to the pool (or terminate if pool is full). */
async function releaseOcrWorker(worker: Awaited<ReturnType<typeof createWorker>> | null, hadError = false): Promise<void> {
  if (!worker) return;
  _activeOcrWorkerCount = Math.max(0, _activeOcrWorkerCount - 1);
  // If the worker errored, it may be in a broken state. Terminate and create a fresh one.
  if (hadError) {
    try { await worker.terminate(); } catch { /* ignore */ }
    // Replenish pool with a fresh worker in the background
    if (_ocrPool.length < OCR_POOL_SIZE) {
      createWorker('eng', undefined, { langPath: LOCAL_LANG_PATH })
        .then((w) => { if (_ocrPool.length < OCR_POOL_SIZE) _ocrPool.push(w); else w.terminate().catch(() => {}); })
        .catch(() => { /* pool will be replenished on next acquire */ });
    }
    return;
  }
  if (_ocrPool.length < OCR_POOL_SIZE) {
    _ocrPool.push(worker);
  } else {
    try { await worker.terminate(); } catch { /* ignore */ }
  }
}

/** Graceful shutdown: terminate all pooled OCR workers. */
async function _shutdownOcrPool(): Promise<void> {
  const workers = _ocrPool.splice(0);
  await Promise.allSettled(workers.map((w) => w.terminate().catch(() => {})));
}
// Register cleanup handlers for graceful shutdown (do NOT call process.exit —
// let the main process handler in index.ts coordinate shutdown order).
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { _shutdownOcrPool().catch(() => {}); });
}

type ChatPayload = {
  message: string;
  userName: string;
  products?: Array<{
    id?: string;
    title?: string;
    price?: number;
    originalPrice?: number;
    platform?: string;
  }>;
  orders?: unknown[];
  tickets?: unknown[];
  image?: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
};

type ChatModelResponse = {
  responseText: string;
  intent:
    | 'greeting'
    | 'search_deals'
    | 'check_order_status'
    | 'check_ticket_status'
    | 'navigation'
    | 'unknown';
  navigateTo?: 'home' | 'explore' | 'orders' | 'profile';
  recommendedProductIds?: string[];
  extractedValues?: {
    orderId?: string;
    amount?: string;
    orderDate?: string;
    seller?: string;
    productName?: string;
    paymentMethod?: string;
    platform?: string;
  };
};

export type ChatUiResponse = {
  text: string;
  intent: ChatModelResponse['intent'];
  navigateTo?: ChatModelResponse['navigateTo'];
  uiType?: 'product_card';
  data?: unknown;
  /** Structured values extracted from an uploaded image */
  extractedValues?: {
    orderId?: string;
    amount?: string;
    orderDate?: string;
    seller?: string;
    productName?: string;
    paymentMethod?: string;
    platform?: string;
  };
};

const GEMINI_MODEL_FALLBACKS = [
  // Use fully-qualified model names as returned by `ai.models.list()`.
  'models/gemini-2.5-flash',
  'models/gemini-2.0-flash',
  'models/gemini-2.0-flash-001',
  'models/gemini-2.0-flash-exp',
  'models/gemini-2.5-pro',
] as const;

export function isGeminiConfigured(env: Env): boolean {
  return Boolean(env.GEMINI_API_KEY && String(env.GEMINI_API_KEY).trim());
}

function requireGeminiKey(env: Env): string {
  if (env.AI_ENABLED === false) {
    throw Object.assign(new Error('AI is disabled. Set AI_ENABLED=true to enable Gemini calls.'), {
      statusCode: 503,
    });
  }
  if (!env.GEMINI_API_KEY) {
    throw Object.assign(new Error('Gemini is not configured. Set GEMINI_API_KEY on the backend.'), {
      statusCode: 503,
    });
  }
  return env.GEMINI_API_KEY;
}

function sanitizeAiError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (err instanceof Error) {
    // Avoid leaking stack traces or any accidental sensitive info.
    return String(err.message || 'AI request failed').slice(0, 300);
  }
  return String(err).slice(0, 300);
}

/** Per-model timeout (15s). Prevents a single slow model from blocking the whole fallback chain. */
const PER_MODEL_TIMEOUT_MS = 15_000;

function withModelTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Model response timed out')), PER_MODEL_TIMEOUT_MS);
    }),
  ]);
}

/** Per-OCR-call timeout (20s). Prevents Tesseract from blocking indefinitely on complex images. */
const OCR_CALL_TIMEOUT_MS = 20_000;

function withOcrTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('OCR recognition timed out')), OCR_CALL_TIMEOUT_MS);
    }),
  ]);
}

function _createInputError(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function stripUnsafeContent(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ') // HTML
    .replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/\{[^{}]*\}/g, ' ') // JSON blobs (non-greedy: only innermost braces)
    .replace(/(stack trace:|traceback:)[\s\S]*/gi, ' ') // stack traces
    .replace(/[\r\n]+/g, ' ') // logs/newlines
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Detect adversarial prompt injection attempts.
 * Returns `true` if the input contains suspicious patterns that try to override system instructions.
 */
function containsPromptInjection(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const patterns = [
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
    /\byou\s+are\s+now\b/i,
    /\bsystem\s*prompt\b/i,
    /\bforget\s+(your|all|everything)\b/i,
    /\bdo\s+not\s+follow\s+(any|your|the)\s+(rules?|instructions?)\b/i,
    /\boverride\s+(all|your|the|system)\b/i,
    /\bact\s+as\s+(if|though)\s+you\s+(are|were)\b/i,
    /\bjailbreak\b/i,
    /\bDAN\s*mode\b/i,
  ];
  return patterns.some((p) => p.test(lower));
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateTokensFromImage(base64: string): number {
  if (!base64) return 0;
  // Gemini processes images as fixed 768×768 tiles.
  // Most images fit in 1–4 tiles → ~258–1030 tokens regardless of file size.
  // The base64 length only tells us the file size, NOT the token count.
  // A conservative estimate: 1 tile (258 tokens) per 500KB of raw image data.
  const rawBytes = Math.ceil(base64.length * 3 / 4);
  const tilesEstimate = Math.max(1, Math.ceil(rawBytes / 500_000));
  return tilesEstimate * 258;
}

function sanitizeUserMessage(env: Env, message: string): string {
  if (!message) return '';
  if (message.length > env.AI_MAX_INPUT_CHARS) {
    message = message.slice(0, env.AI_MAX_INPUT_CHARS);
  }

  // Reject prompt injection attempts before further processing.
  if (containsPromptInjection(message)) {
    aiLog.warn('[Security] Prompt injection attempt detected and blocked', {
      inputLength: message.length,
      preview: message.slice(0, 80),
    });
    return 'How can I help you today?';
  }

  const cleaned = stripUnsafeContent(message);
  if (!cleaned) return '';

  if (cleaned.length > env.AI_MAX_INPUT_CHARS) {
    return cleaned.slice(0, env.AI_MAX_INPUT_CHARS);
  }

  return cleaned;
}

function sanitizeHistory(env: Env, history: ChatPayload['history']) {
  const items = Array.isArray(history) ? history : [];
  // Per-message limit: use env config (default 4000) but cap at 2000 for history to save context budget
  const maxHistoryChars = Math.min(env.AI_MAX_INPUT_CHARS, 2000);
  const trimmed = items.slice(-env.AI_MAX_HISTORY_MESSAGES).map((item) => ({
    role: item.role,
    content: sanitizeUserMessage(env, item.content).slice(0, maxHistoryChars),
  }));

  const older = items.slice(0, Math.max(0, items.length - trimmed.length));
  const summary = older.length
    ? older
        .map((m) => stripUnsafeContent(m.content))
        .join(' | ')
        .slice(0, env.AI_HISTORY_SUMMARY_CHARS)
    : '';

  return { trimmed, summary };
}

export async function checkGeminiApiKey(env: Env): Promise<{ ok: boolean; model: string; error?: string }> {
  const apiKey = requireGeminiKey(env);
  const ai = new GoogleGenAI({ apiKey });

  for (const model of GEMINI_MODEL_FALLBACKS) {
    try {
      // A tiny request whose only purpose is to validate connectivity + auth.
      await withModelTimeout(ai.models.generateContent({
        model,
        contents: 'ping',
      }));
      return { ok: true, model };
    } catch (err) {
      // Try the next model; return last error if all fail.
      const error = sanitizeAiError(err);
      if (model === GEMINI_MODEL_FALLBACKS[GEMINI_MODEL_FALLBACKS.length - 1]) {
        return { ok: false, model, error };
      }
    }
  }

  return { ok: false, model: GEMINI_MODEL_FALLBACKS[0], error: 'AI request failed' };
}

function safeJsonParse<T>(raw: string | undefined | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch?.[1]) {
    const inner = codeBlockMatch[1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) return inner;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1).trim();
}

function parseModelResponse(raw: string | undefined | null): ChatModelResponse | null {
  if (!raw) return null;
  const direct = safeJsonParse<ChatModelResponse>(raw);
  if (direct) return direct;
  const extracted = extractJsonObject(raw);
  if (!extracted) return null;
  return safeJsonParse<ChatModelResponse>(extracted);
}

function sanitizeModelText(raw: string | undefined | null): string {
  if (!raw) return '';
  let cleaned = String(raw);
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/here is the json requested:?/gi, ' ');
  // Only strip "json" when it's a standalone formatting artifact (e.g., model returning "json {}")
  // Avoid stripping it from legitimate sentences like "I can export JSON files".
  cleaned = cleaned.replace(/^\s*json\s*$/gim, ' ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned;
}

export async function generateChatUiResponse(
  env: Env,
  payload: ChatPayload
): Promise<ChatUiResponse> {
  const apiKey = requireGeminiKey(env);
  const ai = new GoogleGenAI({ apiKey });

  const clampText = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

  let imageForPrompt = payload.image;
  if (imageForPrompt && imageForPrompt.length > env.AI_MAX_IMAGE_CHARS) {
    imageForPrompt = undefined;
  }

  const sanitizedMessage = sanitizeUserMessage(env, payload.message || '');
  const { trimmed: historyMessages, summary: historySummary } = sanitizeHistory(env, payload.history);

  const products = Array.isArray(payload.products) ? payload.products : [];
  const dealContextRaw = products
    .slice(0, 10)
    .map((p) => {
      const id = p.id ?? 'unknown';
      const title = p.title ?? 'Untitled';
      const price = typeof p.price === 'number' ? p.price : 0;
      const originalPrice = typeof p.originalPrice === 'number' ? p.originalPrice : price;
      const platform = p.platform ?? 'Unknown';
      return `[ID: ${id}] ${title} - Price: ₹${price} (Product Price: ₹${originalPrice}) on ${platform}`;
    })
    .join('\n');

  let dealContext = clampText(dealContextRaw, 800);

  let ordersSnippet = clampText(
    JSON.stringify((payload.orders || []).slice(0, 3)),
    Math.min(env.AI_MAX_INPUT_CHARS, 600)
  );
  let ticketsSnippet = clampText(
    JSON.stringify((payload.tickets || []).slice(0, 2)),
    Math.min(env.AI_MAX_INPUT_CHARS, 600)
  );

  let historyMessagesForPrompt = historyMessages;

  const buildSystemPrompt = (
    deals: string,
    orders: string,
    tickets: string,
    summary: string,
    hasImage: boolean
  ) => `
You are 'BUZZMA', a world-class AI shopping strategist for ${payload.userName || 'Guest'}.

CONTEXT:
- DEALS: ${deals}
- RECENT ORDERS: ${orders}
- TICKETS: ${tickets}
${summary ? `- SUMMARY: ${summary}` : ''}

BEHAVIOR:
1. Be concise and friendly.
2. If user mentions "shoes", "deals", "offers", identify matching IDs and put them in 'recommendedProductIds'.
3. Classify intent: 'search_deals', 'check_order_status', 'check_ticket_status', 'navigation', 'greeting', or 'unknown'.
4. For navigation, use: 'home', 'explore', 'orders', 'profile'.
5. Use **bold** for key info like **₹599** or **Delivered**.
6. Always respond in JSON format with responseText, intent, and optional fields.
${
  hasImage
    ? `7. IMAGE ANALYSIS (HIGHEST PRIORITY):
   - The user has uploaded an image. IGNORE the 'RECENT ORDERS' list for identification purposes.
   - EXTRACT ALL of the following values from the image and put them in the 'extractedValues' JSON object:
     * orderId: The Order ID exactly as appearing in the image (e.g., Amazon '404-1234567...', Flipkart 'OD123...', Myntra 'MYN...', Meesho, etc.). STRICTLY IGNORE system UUIDs or IDs starting with SYS/MOBO.
     * amount: The Final Order Amount/Total paid (e.g., "₹599", "₹1,299"). Look for "Total", "Grand Total", "Amount Paid", "Order Total". Use the FINAL amount after discounts.
     * orderDate: The order date (e.g., "15 Jan 2025", "2025-01-15"). Look for "Ordered on", "Order Date", "Placed on".
     * seller: The seller/vendor name. Look for "Sold by", "Seller", "Fulfilled by".
     * productName: The main product name or title visible in the image.
     * paymentMethod: Payment method used (e.g., "UPI", "Credit Card", "COD", "Wallet"). Look for "Paid via", "Payment Method", "Payment".
     * platform: The e-commerce platform (e.g., "Amazon", "Flipkart", "Myntra", "Meesho", "Ajio").
   - For EACH value: if clearly visible, extract it exactly. If not visible or unreadable, omit that field.
   - Your responseText should summarize ALL extracted values in a readable format using **bold** for values.
   - If you see an Order ID, your response text MUST begin with: "Found Order ID: **<ID>**".
   - If you cannot read ANY values clearly, say "Could not extract details from this image. Please upload a clearer screenshot."`
    : ''
}
`;

  let systemPrompt = buildSystemPrompt(
    dealContext,
    ordersSnippet,
    ticketsSnippet,
    historySummary,
    !!imageForPrompt
  );

  let historyText = clampText(
    historyMessagesForPrompt.map((m) => `[${m.role}] ${m.content}`).join('\n'),
    Math.min(env.AI_MAX_INPUT_CHARS, 1200)
  );
  const safeMessage = sanitizedMessage || 'Hello';

  let estimatedTokens =
    estimateTokensFromText(systemPrompt) +
    estimateTokensFromText(safeMessage) +
    estimateTokensFromText(historyText) +
    estimateTokensFromImage(imageForPrompt || '');

  if (estimatedTokens > env.AI_MAX_ESTIMATED_TOKENS) {
    historyMessagesForPrompt = historyMessages.slice(-2);
    historyText = clampText(
      historyMessagesForPrompt.map((m) => `[${m.role}] ${m.content}`).join('\n'),
      Math.min(env.AI_MAX_INPUT_CHARS, 600)
    );
    dealContext = clampText(dealContextRaw, 300);
    ordersSnippet = '';
    ticketsSnippet = '';
    const reducedSummary = historySummary ? clampText(historySummary, 120) : '';
    systemPrompt = buildSystemPrompt(
      dealContext,
      ordersSnippet,
      ticketsSnippet,
      reducedSummary,
      !!imageForPrompt
    );
    estimatedTokens =
      estimateTokensFromText(systemPrompt) +
      estimateTokensFromText(safeMessage) +
      estimateTokensFromText(historyText) +
      estimateTokensFromImage(imageForPrompt || '');
  }

  if (estimatedTokens > env.AI_MAX_ESTIMATED_TOKENS) {
    historyMessagesForPrompt = [];
    historyText = '';
    dealContext = '';
    ordersSnippet = '';
    ticketsSnippet = '';
    systemPrompt = buildSystemPrompt('', '', '', '', !!imageForPrompt);
    estimatedTokens =
      estimateTokensFromText(systemPrompt) +
      estimateTokensFromText(safeMessage) +
      estimateTokensFromText(historyText) +
      estimateTokensFromImage(imageForPrompt || '');
  }

  if (estimatedTokens > env.AI_MAX_ESTIMATED_TOKENS && imageForPrompt) {
    imageForPrompt = undefined;
    estimatedTokens =
      estimateTokensFromText(systemPrompt) +
      estimateTokensFromText(safeMessage) +
      estimateTokensFromText(historyText);
  }

  const contents = imageForPrompt
    ? [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageForPrompt.split(',')[1] || imageForPrompt,
          },
        },
        { text: safeMessage || 'Analyze this image.' },
      ]
    : [
        ...(historyMessagesForPrompt.length
          ? historyMessagesForPrompt.map((m) => ({ text: `[${m.role}] ${m.content}` }))
          : []),
        { text: safeMessage },
      ];

  try {
    let lastError: unknown = null;

    for (const model of GEMINI_MODEL_FALLBACKS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await withModelTimeout(ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS_CHAT,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                responseText: { type: Type.STRING },
                intent: {
                  type: Type.STRING,
                  enum: [
                    'greeting',
                    'search_deals',
                    'check_order_status',
                    'check_ticket_status',
                    'navigation',
                    'unknown',
                  ],
                },
                navigateTo: { type: Type.STRING, enum: ['home', 'explore', 'orders', 'profile'] },
                recommendedProductIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                extractedValues: {
                  type: Type.OBJECT,
                  properties: {
                    orderId: { type: Type.STRING },
                    amount: { type: Type.STRING },
                    orderDate: { type: Type.STRING },
                    seller: { type: Type.STRING },
                    productName: { type: Type.STRING },
                    paymentMethod: { type: Type.STRING },
                    platform: { type: Type.STRING },
                  },
                },
              },
              required: ['responseText', 'intent'],
            },
          },
        }));

        const parsed = parseModelResponse(response.text) ?? {
          responseText:
            sanitizeModelText(response.text) ||
            "I'm here to help with deals, orders, or tickets. What would you like?",
          intent: 'unknown',
        };

        const recommendedIds = Array.isArray(parsed.recommendedProductIds)
          ? parsed.recommendedProductIds
          : [];
        let recommendedProducts = recommendedIds.length
          ? products.filter((p) => p.id && recommendedIds.includes(String(p.id)))
          : [];

        if (parsed.intent === 'search_deals' && recommendedProducts.length === 0 && products.length) {
          recommendedProducts = products.slice(0, 5);
        }

        aiLog.info('Gemini chat usage estimate', {
          model,
          estimatedTokens,
        });

        recordGeminiSuccess();

        // Build extractedValues from the AI response (only include non-empty fields)
        let extractedValues: ChatUiResponse['extractedValues'] | undefined;
        if (parsed.extractedValues && typeof parsed.extractedValues === 'object') {
          const ev = parsed.extractedValues as Record<string, unknown>;
          const cleaned: Record<string, string> = {};
          for (const key of ['orderId', 'amount', 'orderDate', 'seller', 'productName', 'paymentMethod', 'platform'] as const) {
            const val = ev[key];
            if (typeof val === 'string' && val.trim()) {
              cleaned[key] = val.trim();
            }
          }
          if (Object.keys(cleaned).length > 0) {
            extractedValues = cleaned as ChatUiResponse['extractedValues'];
          }
        }

        return {
          text: parsed.responseText,
          intent: parsed.intent ?? 'unknown',
          navigateTo: parsed.navigateTo,
          ...(recommendedProducts.length
            ? { uiType: 'product_card' as const, data: recommendedProducts }
            : {}),
          ...(extractedValues ? { extractedValues } : {}),
        };
      } catch (innerError) {
        aiLog.warn('[Chatbot] Model fallback error', { error: innerError instanceof Error ? innerError.message : innerError });
        lastError = innerError;
        continue;
      }
    }

    recordGeminiFailure();
    throw lastError ?? new Error('Gemini request failed');
  } catch (error) {
    // Fallback response if AI fails
    aiLog.error('Gemini API error', { error });
    logErrorEvent({ error: error instanceof Error ? error : new Error(String(error)), message: 'Chat AI generation failed', category: 'EXTERNAL_SERVICE', severity: 'medium', metadata: { handler: 'generateChatUiResponse', userName: payload.userName } });
    return {
      text: `Hi ${payload.userName}! I'm experiencing some technical difficulties right now, but I'm here to help. Could you try rephrasing your question?`,
      intent: 'unknown',
    };
  }
}

type ProofPayload = {
  imageBase64: string;
  expectedOrderId: string;
  expectedAmount: number;
};

type ProofVerificationResult = {
  orderIdMatch: boolean;
  amountMatch: boolean;
  confidenceScore: number;
  detectedOrderId?: string;
  detectedAmount?: number;
  discrepancyNote?: string;
  verificationMethod?: 'gemini' | 'ocr' | 'combined';
};

type ExtractOrderPayload = {
  imageBase64: string;
};

/**
 * Detect MIME type from a base64 data-URL or raw base64 magic bytes.
 * Returns a safe default of 'image/jpeg' when detection fails.
 */
function detectImageMimeType(base64: string): string {
  // data:image/png;base64,...
  const dataMatch = base64.match(/^data:(image\/[a-z+]+);base64,/i);
  if (dataMatch) return dataMatch[1].toLowerCase();

  // Check raw base64 magic bytes
  const raw = base64.slice(0, 16);
  if (raw.startsWith('iVBOR')) return 'image/png';
  if (raw.startsWith('/9j/') || raw.startsWith('/9J/')) return 'image/jpeg';
  if (raw.startsWith('R0lGOD')) return 'image/gif';
  if (raw.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

/**
 * OCR-based proof verification fallback.
 * When Gemini is unavailable, run Tesseract on the proof image and do deterministic matching
 * against the expected order ID and amount.
 */
async function verifyProofWithOcr(
  imageBase64: string,
  expectedOrderId: string,
  expectedAmount: number,
): Promise<ProofVerificationResult> {
  try {
    const rawData = imageBase64.includes(',') ? imageBase64.split(',')[1]! : imageBase64;
    const imgBuffer = Buffer.from(rawData, 'base64');

    // Preprocess with Sharp for better OCR accuracy
    let processedBuffer: Buffer;
    try {
      processedBuffer = await sharp(imgBuffer)
        .greyscale()
        .normalize()
        .sharpen()
        .toBuffer();
    } catch {
      processedBuffer = imgBuffer;
    }

    let worker = await acquireOcrWorker();
    try {
      const { data } = await withOcrTimeout(worker.recognize(processedBuffer));
      await releaseOcrWorker(worker);
      worker = null as any;

      let ocrText = (data.text || '').trim();

      // High-contrast fallback for faded/dark screenshots OR garbage OCR text
      // Trigger on: short text, OR low alphanumeric ratio (garbage), OR no digits found
      const _needsHcFallback = ocrText.length < 50
        || ((ocrText.match(/[a-zA-Z0-9]/g) || []).length / Math.max(ocrText.length, 1) < 0.4)
        || !/\d/.test(ocrText);
      if (_needsHcFallback) {
        let hcWorker: any = null;
        try {
          const hcBuffer = await sharp(imgBuffer)
            .greyscale()
            .linear(1.6, -40)
            .sharpen({ sigma: 2 })
            .toBuffer();
          hcWorker = await acquireOcrWorker();
          const hcResult: any = await withOcrTimeout(hcWorker.recognize(hcBuffer));
          await releaseOcrWorker(hcWorker);
          hcWorker = null;
          const hcText = (hcResult.data.text || '').trim();
          if (hcText.length > ocrText.length) ocrText = hcText;
        } catch {
          if (hcWorker) try { await releaseOcrWorker(hcWorker, true); } catch { /* ignore */ }
        }
      }

      // Inverted fallback for dark-mode screenshots
      const _needsInvertFallback = ocrText.length < 50
        || ((ocrText.match(/[a-zA-Z0-9]/g) || []).length / Math.max(ocrText.length, 1) < 0.4);
      if (_needsInvertFallback) {
        let invWorker: any = null;
        try {
          const invBuffer = await sharp(imgBuffer)
            .negate({ alpha: false })
            .greyscale()
            .normalize()
            .sharpen()
            .toBuffer();
          invWorker = await acquireOcrWorker();
          const invResult: any = await withOcrTimeout(invWorker.recognize(invBuffer));
          await releaseOcrWorker(invWorker);
          invWorker = null;
          const invText = (invResult.data.text || '').trim();
          if (invText.length > ocrText.length) ocrText = invText;
        } catch {
          if (invWorker) try { await releaseOcrWorker(invWorker, true); } catch { /* ignore */ }
        }
      }

      if (!ocrText || ocrText.length < 5) {
        return {
          orderIdMatch: false,
          amountMatch: false,
          confidenceScore: 15,
          discrepancyNote: 'OCR could not read text from the image. Please verify manually.',
        };
      }

    // Normalize OCR digit confusion
    const normalized = ocrText
      .replace(/[Oo]/g, (m) => (/[A-Za-z]/.test(m) ? m : '0'))
      .replace(/[Il|]/g, '1')
      .replace(/[Ss]/g, (m) => (/[A-Za-z]/.test(m) ? m : '5'));

    // Check if expected order ID appears in OCR text
    const orderIdNormalized = expectedOrderId.replace(/[\s\-]/g, '');
    const ocrNormalized = normalized.replace(/[\s\-]/g, '');
    let orderIdMatch = ocrNormalized.toUpperCase().includes(orderIdNormalized.toUpperCase());

    // If exact match failed, try matching with OCR digit normalization on both sides
    if (!orderIdMatch) {
      const digitNormalize = (s: string) => s
        .replace(/[Oo]/g, '0')
        .replace(/[Il|]/g, '1')
        .replace(/S/g, '5')
        .replace(/B/g, '8')
        .replace(/Z/g, '2')
        .replace(/[\s\-\.]/g, '')
        .toUpperCase();
      const expectedNorm = digitNormalize(expectedOrderId);
      const ocrDigitNorm = digitNormalize(ocrText);
      orderIdMatch = ocrDigitNorm.includes(expectedNorm);
    }

    // Last resort: check if the numeric part of the order ID appears in OCR text
    if (!orderIdMatch) {
      const expectedDigits = expectedOrderId.replace(/[^0-9]/g, '');
      if (expectedDigits.length >= 8) {
        const ocrDigits = ocrText.replace(/[^0-9]/g, '');
        orderIdMatch = ocrDigits.includes(expectedDigits);
      }
    }

    // Check if expected amount appears in OCR text (allow smart tolerance for OCR errors)
    // ±₹3 for orders under ₹500, ±1% for higher-value orders (min ₹3)
    const amountTolerance = Math.max(3, expectedAmount >= 500 ? Math.ceil(expectedAmount * 0.01) : 3);
    const amountPatterns = [
      String(expectedAmount),
      expectedAmount.toFixed(2),
      // Indian comma format: 1,23,456
      expectedAmount.toLocaleString('en-IN'),
      // Without decimals if integer
      ...(expectedAmount === Math.floor(expectedAmount) ? [String(Math.floor(expectedAmount))] : []),
      // With .00 suffix
      String(expectedAmount) + '.00',
      // Without trailing zeros: 599.00 → 599
      ...(expectedAmount % 1 === 0 ? [] : [String(Math.round(expectedAmount))]),
    ];
    let amountMatch = amountPatterns.some((p) => ocrText.includes(p));

    // If exact match failed, try ±tolerance (OCR may misread 499 as 497, etc.)
    if (!amountMatch) {
      for (let delta = -amountTolerance; delta <= amountTolerance; delta++) {
        if (delta === 0) continue;
        const nearby = expectedAmount + delta;
        if (nearby <= 0) continue;
        if (ocrText.includes(String(nearby)) || ocrText.includes(nearby.toFixed(2))
          || ocrText.includes(nearby.toLocaleString('en-IN'))) {
          amountMatch = true;
          break;
        }
      }
    }

    // Also try extracting all ₹/Rs amounts from the OCR text and compare numerically
    if (!amountMatch) {
      // Extended regex handles: ₹, Rs, INR, R5/Ri/RI (Tesseract confusion), Rupees, and trailing /-
      const amountRegex = /(?:₹|rs\.?|inr|r[s5$iI]\.?|rupees?)\s*\.?\s*([0-9][0-9,\s]*(?:\.[0-9]{1,2})?)(?:\s*\/-)?/gi;
      for (const m of ocrText.matchAll(amountRegex)) {
        const val = Number(m[1].replace(/[,\s]/g, ''));
        if (Number.isFinite(val) && Math.abs(val - expectedAmount) <= amountTolerance) {
          amountMatch = true;
          break;
        }
      }
    }
    // Final attempt: look for bare numbers within ±2 of expected amount (handles ₹ read as 2/%)
    if (!amountMatch) {
      const bareNumbers = ocrText.match(/\b\d[\d,\s]*(?:\.\d{1,2})?\b/g) || [];
      for (const raw of bareNumbers) {
        const val = Number(raw.replace(/[,\s]/g, ''));
        if (Number.isFinite(val) && val > 10 && Math.abs(val - expectedAmount) <= amountTolerance) {
          amountMatch = true;
          break;
        }
      }
    }

    let confidenceScore: number = CONFIDENCE.OCR_BASE;
    if (orderIdMatch) confidenceScore += CONFIDENCE.OCR_ORDER_ID_BONUS;
    if (amountMatch) confidenceScore += CONFIDENCE.OCR_AMOUNT_BONUS;
    if (orderIdMatch && amountMatch) confidenceScore = Math.min(confidenceScore + CONFIDENCE.OCR_BOTH_BONUS, CONFIDENCE.OCR_MAX_CAP);

    const detectedNotes: string[] = [];
    if (!orderIdMatch) detectedNotes.push(`Order ID "${expectedOrderId}" not found in screenshot.`);
    if (!amountMatch) detectedNotes.push(`Amount ₹${expectedAmount} not found in screenshot.`);
    if (orderIdMatch && amountMatch) detectedNotes.push('Both order ID and amount matched via OCR.');

    return {
      orderIdMatch,
      amountMatch,
      confidenceScore,
      discrepancyNote: detectedNotes.join(' ') || 'OCR fallback verification complete.',
    };
    } catch (workerErr) {
      if (worker) try { await releaseOcrWorker(worker, true); } catch { /* ignore */ }
      throw workerErr;
    }
  } catch (err) {
    aiLog.error('OCR proof verification error', { error: err });
    return {
      orderIdMatch: false,
      amountMatch: false,
      confidenceScore: 0,
      discrepancyNote: 'Auto verification unavailable. Please verify manually.',
    };
  }
}

export async function verifyProofWithAi(env: Env, payload: ProofPayload): Promise<ProofVerificationResult> {
  const _aiStart = Date.now();
  const geminiAvailable = isGeminiConfigured(env);

  if (payload.imageBase64.length > env.AI_MAX_IMAGE_CHARS) {
    return {
      orderIdMatch: false,
      amountMatch: false,
      confidenceScore: 0,
      discrepancyNote: 'Auto verification unavailable. Please verify manually.',
    };
  }

  const estimatedTokens =
    estimateTokensFromImage(payload.imageBase64) +
    estimateTokensFromText(payload.expectedOrderId) +
    estimateTokensFromText(String(payload.expectedAmount));

  if (estimatedTokens > env.AI_MAX_ESTIMATED_TOKENS) {
    return {
      orderIdMatch: false,
      amountMatch: false,
      confidenceScore: 0,
      discrepancyNote: 'Auto verification unavailable. Please verify manually.',
    };
  }

  // If Gemini is not available or circuit breaker is open, fall back to OCR-based verification.
  if (!geminiAvailable || isGeminiCircuitOpen()) {
    const ocrResult = await verifyProofWithOcr(payload.imageBase64, payload.expectedOrderId, payload.expectedAmount);
    return { ...ocrResult, verificationMethod: 'ocr' as const };
  }

  const apiKey = env.GEMINI_API_KEY!;
  const ai = new GoogleGenAI({ apiKey });
  const mimeType = detectImageMimeType(payload.imageBase64);

  try {
    let lastError: unknown = null;

    for (const model of GEMINI_MODEL_FALLBACKS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await withModelTimeout(ai.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                mimeType,
                data: payload.imageBase64.split(',')[1] || payload.imageBase64,
              },
            },
            {
              text: [
                `PROOF VERIFICATION TASK — GOD-LEVEL ACCURACY REQUIRED`,
                ``,
                `You must verify whether this screenshot proves a purchase with:`,
                `  Expected Order ID: ${payload.expectedOrderId}`,
                `  Expected Amount: ₹${payload.expectedAmount}`,
                ``,
                `MULTI-DEVICE: This screenshot may be from a mobile phone, desktop browser, tablet, or laptop.`,
                `- Desktop/laptop screenshots have wide layouts with info spread across columns.`,
                `- Mobile screenshots are narrow and vertical. Read ALL visible text regardless of device.`,
                `- Handle both light mode and dark mode UIs.`,
                ``,
                `RULES:`,
                `1. Extract the ACTUAL order ID visible in the screenshot. Look for labels like "Order ID", "Order No", "Order #", or platform-specific patterns (Amazon: 3-7-7 digits, Flipkart: OD..., Myntra: MYN..., Meesho: MSH..., etc.)`,
                `2. IGNORE tracking IDs, shipment numbers, AWB numbers, transaction IDs, UTR numbers, UPI references, and invoice numbers — these are NOT order IDs.`,
                `3. Extract the GRAND TOTAL / FINAL amount paid (look for "Grand Total", "Amount Paid", "You Paid", "Order Total", "Net Amount", "Payable", "Your Total", "Final Amount", "To Pay"). IGNORE MRP, List Price, Item Price, Subtotal unless no other total exists.`,
                `4. For amount matching: ₹${payload.expectedAmount} should match even if displayed as ₹${payload.expectedAmount}.00 or with Indian comma formatting (e.g., ₹1,23,456). Allow ±₹2 tolerance for rounding or OCR errors.`,
                `5. For order ID matching: Compare after removing spaces, hyphens, and case differences. Partial matches count as mismatches.`,
                `6. Also extract the PRODUCT NAME visible in the screenshot. This helps detect fraud (wrong product uploaded).`,
                `7. Set confidenceScore 0-100: 90+ if both clearly visible and matched, 60-89 if partially matched or slightly unclear, below 60 if mismatched or unreadable.`,
                `8. Always fill detectedOrderId and detectedAmount with what you actually see in the image, even if they don't match the expected values.`,
                `9. If the screenshot is from a dark mode UI, still extract all text carefully.`,
                `10. If the order ID has OCR-like digit confusion (O vs 0, I vs 1, S vs 5), normalize before comparing.`,
              ].join('\n'),
            },
          ],
          config: {
            maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS_PROOF,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                orderIdMatch: { type: Type.BOOLEAN },
                amountMatch: { type: Type.BOOLEAN },
                confidenceScore: { type: Type.INTEGER },
                detectedOrderId: { type: Type.STRING },
                detectedAmount: { type: Type.NUMBER },
                discrepancyNote: { type: Type.STRING },
              },
              required: ['orderIdMatch', 'amountMatch', 'confidenceScore'],
            },
          },
        }));

        const parsed = safeJsonParse<ProofVerificationResult>(response.text);
        if (!parsed) {
          throw new Error('Failed to parse AI verification response');
        }

        // Clamp confidenceScore to 0-100
        parsed.confidenceScore = Math.max(0, Math.min(100, parsed.confidenceScore ?? 0));

        aiLog.info('Gemini proof usage estimate', { model, estimatedTokens });

        recordGeminiSuccess();
        logPerformance({
          operation: 'AI_VERIFY_PROOF',
          durationMs: Date.now() - _aiStart,
          metadata: { method: 'gemini', model, confidenceScore: parsed.confidenceScore },
        });
        return { ...parsed, verificationMethod: 'gemini' as const };
      } catch (innerError) {
        aiLog.warn('[Proof] Model fallback error', { error: innerError instanceof Error ? innerError.message : innerError });
        lastError = innerError;
        continue;
      }
    }

    recordGeminiFailure();
    throw lastError ?? new Error('Gemini proof verification failed');
  } catch (error) {
    logErrorEvent({
      category: 'EXTERNAL_SERVICE',
      errorCode: 'AI_PROOF_VERIFICATION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      severity: 'medium',
      metadata: { expectedOrderId: payload.expectedOrderId, method: 'gemini' },
    });
    aiLog.error('Gemini proof verification error', { error });
    // Fall back to OCR when Gemini fails at runtime.
    const ocrResult = await verifyProofWithOcr(payload.imageBase64, payload.expectedOrderId, payload.expectedAmount);
    logPerformance({
      operation: 'AI_VERIFY_PROOF',
      durationMs: Date.now() - _aiStart,
      metadata: { method: 'ocr_fallback', confidenceScore: ocrResult.confidenceScore },
    });
    return { ...ocrResult, verificationMethod: 'ocr' as const };
  }
}


// ──────────────────────────────────────────────────────────
// RATING SCREENSHOT VERIFICATION
// Verifies: 1) Account holder name matches buyer name
//           2) Product name in rating matches expected product
// ──────────────────────────────────────────────────────────

export type RatingVerificationPayload = {
  imageBase64: string;
  expectedBuyerName: string;
  expectedProductName: string;
  /** Marketplace reviewer / profile name (may differ from buyer's real name) */
  expectedReviewerName?: string;
};

export type RatingVerificationResult = {
  accountNameMatch: boolean;
  productNameMatch: boolean;
  detectedAccountName?: string;
  detectedProductName?: string;
  confidenceScore: number;
  discrepancyNote?: string;
};

async function verifyRatingWithOcr(
  imageBase64: string,
  expectedBuyerName: string,
  expectedProductName: string,
  expectedReviewerName?: string,
): Promise<RatingVerificationResult> {
  try {
    const rawData = imageBase64.includes(',') ? imageBase64.split(',')[1]! : imageBase64;
    const imgBuffer = Buffer.from(rawData, 'base64');
    let processedBuffer: Buffer;
    try {
      processedBuffer = await sharp(imgBuffer).greyscale().normalize().sharpen().toBuffer();
    } catch { processedBuffer = imgBuffer; }

    // Detect orientation for multi-crop
    let isLandscape = false;
    let isTablet = false;
    try {
      const meta = await sharp(imgBuffer).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      const ratio = w / Math.max(h, 1);
      isLandscape = ratio > 1;
      isTablet = ratio > 0.65 && ratio < 1.55; // tablet-like aspect ratio
    } catch { /* ignore */ }

    const allTexts: string[] = [];

    // Helper to run OCR on a buffer
    const ocrOnBuffer = async (buf: Buffer, _label: string): Promise<string> => {
      let worker: any = null;
      try {
        worker = await acquireOcrWorker();
        const { data }: any = await withOcrTimeout(worker.recognize(buf));
        await releaseOcrWorker(worker);
        worker = null;
        return (data.text || '').trim();
      } catch {
        if (worker) try { await releaseOcrWorker(worker, true); } catch { /* ignore */ }
        return '';
      }
    };

    // Pass 1: standard enhanced
    const text1 = await ocrOnBuffer(processedBuffer, 'standard');
    if (text1) allTexts.push(text1);

    // Pass 2: high-contrast
    if (!text1 || text1.length < 50) {
      try {
        const hcBuffer = await sharp(imgBuffer)
          .greyscale()
          .linear(1.6, -40)
          .sharpen({ sigma: 2 })
          .toBuffer();
        const text2 = await ocrOnBuffer(hcBuffer, 'high-contrast');
        if (text2 && text2.length > (text1?.length ?? 0)) allTexts.push(text2);
      } catch { /* ignore */ }
    }

    // Pass 3: crop variants for multi-device screenshots
    const cropVariants: Array<{ label: string; left?: number; top?: number; width?: number; height?: number }> = [];
    if (isLandscape) {
      // Desktop: rating/review area is often center or right
      cropVariants.push({ label: 'center-60', left: 0.2, width: 0.6 });
      cropVariants.push({ label: 'right-50', left: 0.45, width: 0.55, top: 0.1, height: 0.7 });
    } else if (isTablet) {
      // Tablet: wider than phone, narrower than desktop
      cropVariants.push({ label: 'center-70', left: 0.15, width: 0.7, top: 0.1, height: 0.6 });
      cropVariants.push({ label: 'top-60', top: 0, height: 0.6 });
    } else {
      // Phone portrait: vertically distributed
      cropVariants.push({ label: 'top-50', top: 0, height: 0.5 });
      cropVariants.push({ label: 'middle-50', top: 0.25, height: 0.5 });
    }

    for (const crop of cropVariants) {
      try {
        const meta = await sharp(imgBuffer).metadata();
        const w = meta.width ?? 0;
        const h = meta.height ?? 0;
        if (w < 50 || h < 50) continue;
        const cropBuf = await sharp(imgBuffer)
          .extract({
            left: Math.round((crop.left ?? 0) * w),
            top: Math.round((crop.top ?? 0) * h),
            width: Math.min(Math.round((crop.width ?? 1) * w), w - Math.round((crop.left ?? 0) * w)),
            height: Math.min(Math.round((crop.height ?? 1) * h), h - Math.round((crop.top ?? 0) * h)),
          })
          .greyscale()
          .normalize()
          .sharpen()
          .toBuffer();
        const cropText = await ocrOnBuffer(cropBuf, crop.label);
        if (cropText && cropText.length > 20) allTexts.push(cropText);
      } catch { /* ignore crop errors */ }
    }

    // Combine all OCR texts
    const ocrText = allTexts.sort((a, b) => b.length - a.length).join('\n');

    if (!ocrText || ocrText.length < 5) {
      return { accountNameMatch: false, productNameMatch: false, confidenceScore: 10,
        discrepancyNote: 'OCR could not read text from the rating screenshot.' };
    }

    const lower = ocrText.toLowerCase();
    // Common stop words that cause false positives when matching names/products in OCR text
    const STOP_WORDS = new Set(['the','for','and','with','from','that','this','you','your','was','are','has','have','been','not','but','all','can','had','her','his','one','our','out','use','how','its','may','new','now','old','see','way','who','boy','did','get','him','let','say','she','too','any','per','set','top','end','off','big','own','put','run','two','via','pro','free','pack','item','best','good','great','nice','mini','max','size','pair','home','made','full','high','low','day','set','box','buy','kit']);

    // Account name matching: fuzzy — check if any 2+ word segment of the buyer name or reviewer name appears
    const buyerParts = expectedBuyerName.toLowerCase().split(/\s+/).filter(p => p.length >= 2 && !STOP_WORDS.has(p));
    const nameMatches = buyerParts.filter(p => lower.includes(p));
    let accountNameMatch = nameMatches.length >= Math.max(1, Math.ceil(buyerParts.length * 0.6));
    // Also check reviewer / marketplace profile name if provided
    if (!accountNameMatch && expectedReviewerName) {
      const reviewerParts = expectedReviewerName.toLowerCase().split(/\s+/).filter(p => p.length >= 2 && !STOP_WORDS.has(p));
      const reviewerMatches = reviewerParts.filter(p => lower.includes(p));
      accountNameMatch = reviewerMatches.length >= Math.max(1, Math.ceil(reviewerParts.length * 0.6));
    }

    // Product name matching: check if significant keywords from product name appear
    const productTokens = expectedProductName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
    const matchedTokens = productTokens.filter(t => lower.includes(t));
    const productNameMatch = matchedTokens.length >= Math.max(1, Math.ceil(productTokens.length * 0.4));

    // Graduated confidence scoring — partial matches contribute proportionally
    let confidenceScore: number = CONFIDENCE.RATING_BASE;
    if (accountNameMatch) {
      const nameRatio = buyerParts.length > 0 ? nameMatches.length / buyerParts.length : 0;
      confidenceScore += Math.round(CONFIDENCE.RATING_FIELD_WEIGHT * nameRatio);
    }
    if (productNameMatch) {
      const productRatio = productTokens.length > 0 ? matchedTokens.length / productTokens.length : 0;
      confidenceScore += Math.round(CONFIDENCE.RATING_FIELD_WEIGHT * productRatio);
    }

    // Try to detect the actual account name shown
    const nameLineRe = /(?:public\s*name|profile|account|by|reviewer|reviewed|written\s*by|posted\s*by)\s*[:\-]?\s*(.{2,40})/i;
    const nameMatch = ocrText.match(nameLineRe);
    const detectedAccountName = nameMatch?.[1]?.trim() || undefined;

    return {
      accountNameMatch, productNameMatch, confidenceScore,
      detectedAccountName,
      detectedProductName: matchedTokens.length > 0 ? matchedTokens.join(' ') : undefined,
      discrepancyNote: [
        !accountNameMatch ? `Buyer name "${expectedBuyerName}" not found in screenshot.` : '',
        !productNameMatch ? `Product name not matching in screenshot.` : '',
        accountNameMatch && productNameMatch ? 'Account name and product matched via OCR.' : '',
      ].filter(Boolean).join(' '),
    };
  } catch (err) {
    aiLog.error('OCR rating verification error', { error: err });
    return { accountNameMatch: false, productNameMatch: false, confidenceScore: 0,
      discrepancyNote: 'Rating verification unavailable. Please verify manually.' };
  }
}

export async function verifyRatingScreenshotWithAi(
  env: Env,
  payload: RatingVerificationPayload,
): Promise<RatingVerificationResult> {
  const _aiStart = Date.now();
  if (payload.imageBase64.length > env.AI_MAX_IMAGE_CHARS) {
    return { accountNameMatch: false, productNameMatch: false, confidenceScore: 0,
      discrepancyNote: 'Image too large for auto verification.' };
  }

  if (!isGeminiConfigured(env) || isGeminiCircuitOpen()) {
    return verifyRatingWithOcr(payload.imageBase64, payload.expectedBuyerName, payload.expectedProductName, payload.expectedReviewerName);
  }

  const apiKey = env.GEMINI_API_KEY!;
  const ai = new GoogleGenAI({ apiKey });
  const mimeType = detectImageMimeType(payload.imageBase64);

  try {
    let lastError: unknown = null;
    for (const model of GEMINI_MODEL_FALLBACKS) {
      try {
        const response = await withModelTimeout(ai.models.generateContent({
          model,
          contents: [
            { inlineData: { mimeType, data: payload.imageBase64.split(',')[1] || payload.imageBase64 } },
            { text: [
              `RATING SCREENSHOT VERIFICATION — GOD-LEVEL ACCURACY REQUIRED`,
              ``,
              `Verify this RATING/REVIEW screenshot:`,
              `  Expected Account Name (buyer): ${payload.expectedBuyerName}`,
              ...(payload.expectedReviewerName ? [`  Expected Marketplace Profile/Reviewer Name: ${payload.expectedReviewerName}`] : []),
              `  Expected Product Name: ${payload.expectedProductName}`,
              ``,
              `RULES:`,
              `1. Find the REVIEWER / ACCOUNT NAME shown in the screenshot. This is the person who wrote the review or gave the rating. It may appear as "public name", "profile name", or at the top of the review.`,
              `2. Compare the account name with "${payload.expectedBuyerName}"${payload.expectedReviewerName ? ` OR the marketplace profile name "${payload.expectedReviewerName}"` : ''} — allow for nickname variations, case differences, and abbreviated names. If EITHER name matches, consider it a match.`,
              `3. Find the PRODUCT NAME visible in the rating screenshot. Compare it to "${payload.expectedProductName}" — key words should match (brand, model, type). Exact match not required.`,
              `4. If the account name does not match ANY of the expected names or the product does not match, this is potential FRAUD (someone rating a different product or using a different account).`,
              `5. Set confidenceScore 0-100 based on how clearly visible and matching both fields are.`,
              `6. Always fill detectedAccountName and detectedProductName with what you actually see.`,
            ].join('\n') },
          ],
          config: {
            maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS_PROOF,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                accountNameMatch: { type: Type.BOOLEAN },
                productNameMatch: { type: Type.BOOLEAN },
                confidenceScore: { type: Type.INTEGER },
                detectedAccountName: { type: Type.STRING },
                detectedProductName: { type: Type.STRING },
                discrepancyNote: { type: Type.STRING },
              },
              required: ['accountNameMatch', 'productNameMatch', 'confidenceScore'],
            },
          },
        }));

        const parsed = safeJsonParse<RatingVerificationResult>(response.text);
        if (!parsed) throw new Error('Failed to parse AI rating verification response');
        parsed.confidenceScore = Math.max(0, Math.min(100, parsed.confidenceScore ?? 0));
        recordGeminiSuccess();
        logPerformance({
          operation: 'AI_VERIFY_RATING',
          durationMs: Date.now() - _aiStart,
          metadata: { method: 'gemini', confidenceScore: parsed.confidenceScore },
        });
        return parsed;
      } catch (innerError) { aiLog.warn('[Rating] Model fallback error', { error: innerError instanceof Error ? innerError.message : innerError }); lastError = innerError; continue; }
    }
    recordGeminiFailure();
    throw lastError ?? new Error('Gemini rating verification failed');
  } catch (error) {
    logErrorEvent({
      category: 'EXTERNAL_SERVICE',
      errorCode: 'AI_RATING_VERIFICATION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      severity: 'medium',
      metadata: { expectedBuyerName: payload.expectedBuyerName, method: 'gemini' },
    });
    aiLog.error('Gemini rating verification error', { error });
    return verifyRatingWithOcr(payload.imageBase64, payload.expectedBuyerName, payload.expectedProductName, payload.expectedReviewerName);
  }
}


// ──────────────────────────────────────────────────────────
// RETURN WINDOW / DELIVERY SCREENSHOT VERIFICATION
// Verifies: product name, order number, sold by, grand total, delivery status
// ──────────────────────────────────────────────────────────

export type ReturnWindowVerificationPayload = {
  imageBase64: string;
  expectedOrderId: string;
  expectedProductName: string;
  expectedAmount: number;
  expectedSoldBy?: string;
};

export type ReturnWindowVerificationResult = {
  orderIdMatch: boolean;
  productNameMatch: boolean;
  amountMatch: boolean;
  soldByMatch: boolean;
  returnWindowClosed: boolean;
  confidenceScore: number;
  detectedReturnWindow?: string;
  discrepancyNote?: string;
};

async function verifyReturnWindowWithOcr(
  imageBase64: string,
  expected: ReturnWindowVerificationPayload,
): Promise<ReturnWindowVerificationResult> {
  try {
    const rawData = imageBase64.includes(',') ? imageBase64.split(',')[1]! : imageBase64;
    const imgBuffer = Buffer.from(rawData, 'base64');
    let processedBuffer: Buffer;
    try { processedBuffer = await sharp(imgBuffer).greyscale().normalize().sharpen().toBuffer(); }
    catch { processedBuffer = imgBuffer; }

    let worker: any = await acquireOcrWorker();
    try {
      const { data }: any = await withOcrTimeout(worker.recognize(processedBuffer));
      await releaseOcrWorker(worker);
      worker = null;
      let ocrText = (data.text || '').trim();

      // High-contrast fallback for faded/dark screenshots OR garbage OCR text
      const _needsHcFallback2 = ocrText.length < 50
        || ((ocrText.match(/[a-zA-Z0-9]/g) || []).length / Math.max(ocrText.length, 1) < 0.4)
        || !/\d/.test(ocrText);
      if (_needsHcFallback2) {
        let hcWorker: any = null;
        try {
          const hcBuffer = await sharp(imgBuffer)
            .greyscale()
            .linear(1.6, -40)
            .sharpen({ sigma: 2 })
            .toBuffer();
          hcWorker = await acquireOcrWorker();
          const hcResult: any = await withOcrTimeout(hcWorker.recognize(hcBuffer));
          await releaseOcrWorker(hcWorker);
          hcWorker = null;
          const hcText = (hcResult.data.text || '').trim();
          if (hcText.length > ocrText.length) ocrText = hcText;
        } catch {
          if (hcWorker) try { await releaseOcrWorker(hcWorker, true); } catch { /* ignore */ }
        }
      }

      // Inverted fallback for dark-mode screenshots
      if (ocrText.length < 50 || ((ocrText.match(/[a-zA-Z0-9]/g) || []).length / Math.max(ocrText.length, 1) < 0.4)) {
        let invWorker: any = null;
        try {
          const invBuffer = await sharp(imgBuffer)
            .negate({ alpha: false })
            .greyscale()
            .normalize()
            .sharpen()
            .toBuffer();
          invWorker = await acquireOcrWorker();
          const invResult: any = await withOcrTimeout(invWorker.recognize(invBuffer));
          await releaseOcrWorker(invWorker);
          invWorker = null;
          const invText = (invResult.data.text || '').trim();
          if (invText.length > ocrText.length) ocrText = invText;
        } catch {
          if (invWorker) try { await releaseOcrWorker(invWorker, true); } catch { /* ignore */ }
        }
      }

    if (!ocrText || ocrText.length < 5) {
      return { orderIdMatch: false, productNameMatch: false, amountMatch: false, soldByMatch: false,
        returnWindowClosed: false, confidenceScore: 10,
        discrepancyNote: 'OCR could not read text from the delivery screenshot.' };
    }

    const lower = ocrText.toLowerCase();
    const orderIdNorm = expected.expectedOrderId.replace(/[\s\-]/g, '').toLowerCase();
    const ocrNorm = ocrText.replace(/[\s\-]/g, '').toLowerCase();
    const orderIdMatch = ocrNorm.includes(orderIdNorm);

    const PROOF_STOP_WORDS = new Set(['the','for','and','with','from','that','this','you','your','was','are','has','have','been','not','but','all','can','had','her','his','one','our','out','use','how','its','may','new','now','old','see','way','who','did','get','him','let','say','she','too','any','per','set','top','end','off','big','own','put','run','two','via','pro','free','pack','item','best','good','great','nice','mini','max','size','pair','home','made','full','high','low','day','box','buy','kit']);
    const productTokens = expected.expectedProductName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !PROOF_STOP_WORDS.has(t));
    const matchedProd = productTokens.filter(t => lower.includes(t));
    const productNameMatch = matchedProd.length >= Math.max(1, Math.ceil(productTokens.length * 0.4));

    const expectedAmt = expected.expectedAmount;
    const amountStr = String(expectedAmt);
    // Format with Indian commas for OCR matching (e.g. 1,499 or 12,499)
    const indianFormatted = expectedAmt >= 1000
      ? expectedAmt.toLocaleString('en-IN')
      : amountStr;

    let amountMatch = ocrText.includes(amountStr)
      || ocrText.includes(expectedAmt.toFixed(2))
      || ocrText.includes(indianFormatted);

    // Smart tolerance (OCR may misread digits)
    const rwAmountTolerance = Math.max(2, expectedAmt >= 1000 ? Math.ceil(expectedAmt * 0.005) : 2);
    if (!amountMatch) {
      for (let delta = -rwAmountTolerance; delta <= rwAmountTolerance; delta++) {
        if (delta === 0) continue;
        const nearby = expectedAmt + delta;
        if (nearby <= 0) continue;
        if (ocrText.includes(String(nearby)) || ocrText.includes(nearby.toFixed(2))) {
          amountMatch = true;
          break;
        }
      }
    }

    // Extract ₹/Rs/INR amounts from OCR text and compare numerically
    if (!amountMatch) {
      const amtRegex = /(?:₹|rs\.?|inr|r[s5$]\.?)\s*\.?\s*([0-9][0-9,\s]*(?:\.[0-9]{1,2})?)(?:\s*\/-)?/gi;
      for (const m of ocrText.matchAll(amtRegex)) {
        const val = Number(m[1].replace(/[,\s]/g, ''));
        if (Number.isFinite(val) && Math.abs(val - expectedAmt) <= rwAmountTolerance) {
          amountMatch = true;
          break;
        }
      }
    }

    // Bare-number fallback (₹ may be OCR-ed as 2/%)
    if (!amountMatch) {
      const bareNums = ocrText.match(/\b\d[\d,\s]*(?:\.\d{1,2})?\b/g) || [];
      for (const raw of bareNums) {
        const val = Number(raw.replace(/[,\s]/g, ''));
        if (Number.isFinite(val) && val > 10 && Math.abs(val - expectedAmt) <= rwAmountTolerance) {
          amountMatch = true;
          break;
        }
      }
    }

    const soldByMatch = expected.expectedSoldBy
      ? lower.includes(expected.expectedSoldBy.toLowerCase().trim())
      : true;

    // Check for explicit return window closure keywords (avoid treating mere delivery as closure)
    const returnWindowRe = /return\s*window\s*(closed|expired|ended|over|passed)|no\s*return|non.?returnable/i;
    const returnWindowClosed = returnWindowRe.test(ocrText);

    let confidenceScore: number = CONFIDENCE.RETURN_WINDOW_BASE;
    if (orderIdMatch) confidenceScore += CONFIDENCE.RETURN_WINDOW_ORDER_BONUS;
    // Graduated product confidence based on token match ratio
    if (productNameMatch && productTokens.length > 0) {
      const ratio = matchedProd.length / productTokens.length;
      confidenceScore += Math.round(CONFIDENCE.RETURN_WINDOW_PRODUCT_WEIGHT * ratio);
    }
    if (amountMatch) confidenceScore += CONFIDENCE.RETURN_WINDOW_AMOUNT_BONUS;
    if (soldByMatch) confidenceScore += CONFIDENCE.RETURN_WINDOW_SOLD_BONUS;
    if (returnWindowClosed) confidenceScore += CONFIDENCE.RETURN_WINDOW_CLOSED_BONUS;

    return {
      orderIdMatch, productNameMatch, amountMatch, soldByMatch, returnWindowClosed, confidenceScore,
      discrepancyNote: [
        !orderIdMatch ? `Order ID "${expected.expectedOrderId}" not found.` : '',
        !productNameMatch ? 'Product name mismatch.' : '',
        !amountMatch ? `Amount ₹${expected.expectedAmount} not found.` : '',
        !soldByMatch && expected.expectedSoldBy ? `Seller "${expected.expectedSoldBy}" not found.` : '',
        !returnWindowClosed ? 'Return window status not confirmed.' : '',
      ].filter(Boolean).join(' ') || 'OCR verification complete.',
    };
    } catch (workerErr) {
      if (worker) try { await releaseOcrWorker(worker, true); } catch { /* ignore */ }
      throw workerErr;
    }
  } catch (err) {
    aiLog.error('OCR return window verification error', { error: err });
    return { orderIdMatch: false, productNameMatch: false, amountMatch: false, soldByMatch: false,
      returnWindowClosed: false, confidenceScore: 0,
      discrepancyNote: 'Return window verification unavailable. Please verify manually.' };
  }
}

export async function verifyReturnWindowWithAi(
  env: Env,
  payload: ReturnWindowVerificationPayload,
): Promise<ReturnWindowVerificationResult> {
  const _aiStart = Date.now();
  if (payload.imageBase64.length > env.AI_MAX_IMAGE_CHARS) {
    return { orderIdMatch: false, productNameMatch: false, amountMatch: false, soldByMatch: false,
      returnWindowClosed: false, confidenceScore: 0,
      discrepancyNote: 'Image too large for auto verification.' };
  }

  if (!isGeminiConfigured(env) || isGeminiCircuitOpen()) {
    return verifyReturnWindowWithOcr(payload.imageBase64, payload);
  }

  const apiKey = env.GEMINI_API_KEY!;
  const ai = new GoogleGenAI({ apiKey });
  const mimeType = detectImageMimeType(payload.imageBase64);

  try {
    let lastError: unknown = null;
    for (const model of GEMINI_MODEL_FALLBACKS) {
      try {
        const response = await withModelTimeout(ai.models.generateContent({
          model,
          contents: [
            { inlineData: { mimeType, data: payload.imageBase64.split(',')[1] || payload.imageBase64 } },
            { text: [
              `RETURN WINDOW / DELIVERY SCREENSHOT VERIFICATION — GOD-LEVEL ACCURACY REQUIRED`,
              ``,
              `Verify this delivery/return window screenshot against the order:`,
              `  Expected Order ID: ${payload.expectedOrderId}`,
              `  Expected Product Name: ${payload.expectedProductName}`,
              `  Expected Grand Total: ₹${payload.expectedAmount}`,
              `  Expected Sold By: ${payload.expectedSoldBy || 'N/A'}`,
              ``,
              `RULES:`,
              `1. Find the ORDER ID in the screenshot and compare to "${payload.expectedOrderId}".`,
              `2. Find the PRODUCT NAME and compare key words to "${payload.expectedProductName}".`,
              `3. Find the GRAND TOTAL / AMOUNT and compare to ₹${payload.expectedAmount} (±₹1 tolerance).`,
              `4. Find "Sold by" / "Seller" and compare to "${payload.expectedSoldBy || 'N/A'}".`,
              `5. Check if the RETURN WINDOW is CLOSED/EXPIRED. Look for: "Return window closed", "No longer returnable", delivery date that is > 7 days ago, or text indicating the item cannot be returned.`,
              `6. Set confidenceScore 0-100 based on match quality.`,
              `7. Fill all detected fields with what you actually see in the image.`,
            ].join('\n') },
          ],
          config: {
            maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS_PROOF,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                orderIdMatch: { type: Type.BOOLEAN },
                productNameMatch: { type: Type.BOOLEAN },
                amountMatch: { type: Type.BOOLEAN },
                soldByMatch: { type: Type.BOOLEAN },
                returnWindowClosed: { type: Type.BOOLEAN },
                confidenceScore: { type: Type.INTEGER },
                detectedReturnWindow: { type: Type.STRING },
                discrepancyNote: { type: Type.STRING },
              },
              required: ['orderIdMatch', 'productNameMatch', 'amountMatch', 'soldByMatch', 'returnWindowClosed', 'confidenceScore'],
            },
          },
        }));

        const parsed = safeJsonParse<ReturnWindowVerificationResult>(response.text);
        if (!parsed) throw new Error('Failed to parse AI return window verification response');
        parsed.confidenceScore = Math.max(0, Math.min(100, parsed.confidenceScore ?? 0));
        recordGeminiSuccess();
        logPerformance({
          operation: 'AI_VERIFY_RETURN_WINDOW',
          durationMs: Date.now() - _aiStart,
          metadata: { method: 'gemini', confidenceScore: parsed.confidenceScore },
        });
        return parsed;
      } catch (innerError) { aiLog.warn('[ReturnWindow] Model fallback error', { error: innerError instanceof Error ? innerError.message : innerError }); lastError = innerError; continue; }
    }
    recordGeminiFailure();
    throw lastError ?? new Error('Gemini return window verification failed');
  } catch (error) {
    logErrorEvent({
      category: 'EXTERNAL_SERVICE',
      errorCode: 'AI_RETURN_WINDOW_VERIFICATION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      severity: 'medium',
      metadata: { method: 'gemini' },
    });
    aiLog.error('Gemini return window verification error', { error });
    return verifyReturnWindowWithOcr(payload.imageBase64, payload);
  }
}


export async function extractOrderDetailsWithAi(
  env: Env,
  payload: ExtractOrderPayload
): Promise<{
  orderId?: string | null;
  amount?: number | null;
  orderDate?: string | null;
  soldBy?: string | null;
  productName?: string | null;
  confidenceScore: number;
  notes?: string;
}> {
  const geminiAvailable = isGeminiConfigured(env);
  const ai = geminiAvailable ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY! }) : null;

  if (payload.imageBase64.length > env.AI_MAX_IMAGE_CHARS) {
    return {
      orderId: null,
      amount: null,
      confidenceScore: 0,
      notes: 'Image too large. Please upload a smaller screenshot.',
    };
  }

  // NOTE: Token estimation is NOT used as a gate here.
  // Tesseract.js is local and free — no token limit applies.
  // For Gemini, the API enforces its own token limits.
  // The AI_MAX_IMAGE_CHARS check above is the sole size gate.

  try {
    let _lastError: unknown = null;

    // ─── REGEX PATTERNS ─── //

    const ORDER_KEYWORD_RE = /order\s*(id|no\.?|number|#|:)/i;
    const EXCLUDED_LINE_RE = /\b(tracking\s*(id|no|number|#)|shipment\s*(id|no|number|#)|awb|invoice\s*(id|no|number|#)|transaction\s*(id|no|number|#)|utr|upi\s*(ref|id)|ref(erence)?\s*(id|no|number|#)|refund\s*ref(erence)?\s*(number|no|id|#))\b/i;
    const ORDER_LABEL_PATTERN = 'order\\s*(?:id|no\\.?|number|#)\\s*[:\\-#]?\\s*([A-Z0-9\\-_/]{4,40})';

    // ── Platform-specific order ID patterns ──
    const AMAZON_ORDER_PATTERN     = '\\b\\d{3}[\\-\\s]?\\d{7}[\\-\\s]?\\d{7}\\b';
    const FLIPKART_ORDER_PATTERN   = '\\b[Oo0][Dd]\\d{10,}\\b';
    const MYNTRA_ORDER_PATTERN     = '\\b(?:MYN|MNT|ORD|PP)[\\-\\s]?\\d{6,}\\b';
    const MEESHO_ORDER_PATTERN     = '\\b(?:MSH|MEESH[O0])[\\-\\s]?\\d{6,}\\b';
    const AJIO_ORDER_PATTERN       = '\\bFN[\\-\\s]?\\d{6,}\\b';
    const JIO_ORDER_PATTERN        = '\\b(?:JIO|OM)[\\-\\s]?\\d{8,}\\b';
    const NYKAA_ORDER_PATTERN      = '\\bNYK[\\-\\s]?\\d{6,}\\b';
    const TATA_ORDER_PATTERN       = '\\b(?:TCL|TATA)[\\-\\s]?\\d{6,}\\b';
    const SNAPDEAL_ORDER_PATTERN   = '\\b(?:SD)[\\-\\s]?\\d{8,}\\b';
    const BIGBASKET_ORDER_PATTERN  = '\\b(?:BB)[\\-\\s]?\\d{8,}\\b';
    const ONMG_ORDER_PATTERN       = '\\b(?:1MG)[\\-\\s]?\\d{6,}\\b';
    const CROMA_ORDER_PATTERN      = '\\b(?:CRM|CROMA)[\\-\\s]?\\d{6,}\\b';
    const PURPLLE_ORDER_PATTERN    = '\\b(?:PUR|PURP)[\\-\\s]?\\d{6,}\\b';
    const SHOPSY_ORDER_PATTERN     = '\\b(?:SHOPSY|SP)[\\-\\s]?\\d{6,}\\b';
    const BLINKIT_ORDER_PATTERN    = '\\b(?:BLK|BLINKIT)[\\-\\s]?\\d{6,}\\b';
    const ZEPTO_ORDER_PATTERN      = '\\b(?:ZPT|ZEPTO)[\\-\\s]?\\d{6,}\\b';
    const LENSKART_ORDER_PATTERN   = '\\b(?:LK|LENSKART)[\\-\\s]?\\d{6,}\\b';
    const PHARMEASY_ORDER_PATTERN  = '\\b(?:PE|PHARM|PHR)[\\-\\s]?\\d{6,}\\b';
    const SWIGGY_ORDER_PATTERN     = '\\b(?:SWG|SWIGGY)[\\-\\s]?\\d{6,}\\b';
    const AMAZON_SPACED_PATTERN    = '(?:\\d[\\s\\-\\.]{0,2}){17}';
    const GENERIC_ID_PATTERN       = '\\b[A-Z][A-Z0-9\\-]{7,}\\b';

    // ── Amount patterns (₹, Rs, INR, bare) ──
    // NOTE: Includes OCR-garbled variants: Tesseract commonly misreads l→1/!/i/|, o→0, a→@, t→+
    // e.g. "Total" → "Tota!", "Totai", "T0tal", "Tota1"; "Price" → "Pr1ce", "Prlce"; "Paid" → "Pa1d"
    const AMOUNT_LABEL_RE = /(grand\s*t[o0]t[a@][l1!i|]|am[o0]un[t+]\s*pa[i1!|][d0]|pa[i1!|][d0]\s*am[o0]un[t+]|you\s*pa[i1!|][d0]|[o0]rder\s*t[o0]t[a@][l1!i|]|f[i1!|]na[l1!|]\s*t[o0]t[a@][l1!i|]|t[o0]t[a@][l1!i|]\s*am[o0]un[t+]|net\s*am[o0]un[t+]|payab[l1!|]e|[i1!|]tem\s*t[o0]t[a@][l1!i|]|subt[o0]t[a@][l1!i|]|sub\s*t[o0]t[a@][l1!i|]|bag\s*t[o0]t[a@][l1!i|]|cart\s*va[l1!|]ue|dea[l1!|]\s*pr[i1!|]ce|[o0]ffer\s*pr[i1!|]ce|sa[l1!|]e\s*pr[i1!|]ce|f[i1!|]na[l1!|]\s*pr[i1!|]ce|pr[i1!|]ce|y[o0]ur\s*pr[i1!|]ce|est[i1!|]mated\s*t[o0]t[a@][l1!i|]|t[o0]t[a@][l1!i|]|am[o0]un[t+]\s*t[o0]\s*pay|pay\s*am[o0]un[t+]|b[i1!|][l1!|][l1!|]\s*t[o0]t[a@][l1!i|]|[o0]rder\s*va[l1!|]ue|net\s*pay|f[i1!|]na[l1!|]\s*pay|t[o0]t[a@][l1!i|]\s*refund|refund\s*t[o0]t[a@][l1!i|]|refund\s*am[o0]un[t+])/i;
    // Priority labels that indicate the FINAL price paid (not MRP)
    const FINAL_AMOUNT_LABEL_RE = /(grand\s*t[o0]t[a@][l1!i|]|am[o0]un[t+]\s*pa[i1!|][d0]|pa[i1!|][d0]\s*am[o0]un[t+]|you\s*pa[i1!|][d0]|[o0]rder\s*t[o0]t[a@][l1!i|]|f[i1!|]na[l1!|]\s*t[o0]t[a@][l1!i|]|t[o0]t[a@][l1!i|]\s*am[o0]un[t+]|net\s*am[o0]un[t+]|payab[l1!|]e|est[i1!|]mated\s*t[o0]t[a@][l1!i|]|am[o0]un[t+]\s*payab[l1!|]e|t[o0]t[a@][l1!i|]\s*payab[l1!|]e|b[i1!|][l1!|][l1!|]\s*am[o0]un[t+]|[i1!|]nv[o0][i1!|]ce\s*t[o0]t[a@][l1!i|]|check[o0]ut\s*t[o0]t[a@][l1!i|]|payment\s*t[o0]t[a@][l1!i|]|you\s*pay|t[o0]\s*pay|y[o0]ur\s*t[o0]t[a@][l1!i|]|f[i1!|]na[l1!|]\s*am[o0]un[t+]|due\s*am[o0]un[t+]|t[o0]t[a@][l1!i|]\s*due|t[o0]t[a@][l1!i|]\s*pa[i1!|][d0]|am[o0]un[t+]\s*due|t[o0]t[a@][l1!i|]\s*pr[i1!|]ce|f[i1!|]na[l1!|]\s*pr[i1!|]ce|[o0]rder\s*am[o0]un[t+]|purchase\s*t[o0]t[a@][l1!i|]|am[o0]un[t+]\s*t[o0]\s*pay|pay\s*am[o0]un[t+]|b[i1!|][l1!|][l1!|]\s*t[o0]t[a@][l1!i|]|[o0]rder\s*va[l1!|]ue|net\s*pay|f[i1!|]na[l1!|]\s*pay|pa[i1!|][d0]\s*v[i1!|]a|pa[i1!|][d0]\s*us[i1!|]ng|pa[i1!|][d0]\s*by|payment\s*[o0]f|deducted|charged|deb[i1!|]ted|t[o0]t[a@][l1!i|]\s*refund|refund\s*t[o0]t[a@][l1!i|]|refund\s*am[o0]un[t+])/i;
    // Labels to EXCLUDE — MRP/savings/discount/fee lines should NOT be treated as amounts
    const EXCLUDED_AMOUNT_LABEL_RE = /(m\.?r\.?p|mrp|maximum\s*retail|retail\s*price|original\s*price|was\s*₹|was\s*rs|savings?|discount|you\s*sav|coupon|cashback|refund|promo|crossed\s*out|list\s*price|listing\s*price|selling\s*price|special\s*price|compare\s*at|earlier\s*price|regular\s*price|marked?\s*price|cut\s*price|item\s*price|unit\s*price|per\s*unit|per\s*item|reward\s*points?|loyalty\s*points?|coins?\s*earned|super\s*coins?|delivery\s*charge|delivery\s*fee|shipping\s*fee|shipping\s*charge|convenience\s*fee|handling\s*fee|packaging\s*fee|packing\s*fee|gst|tax\s*amount|total\s*tax|cgst|sgst|igst|platform\s*fee|marketplace\s*fee|packing\s*charge|total\s*fees|total\s*charges|total\s*savings|eco\s*fee|tip|donation|round\s*off|protection\s*fee|insurance\s*fee|cash.*delivery\s*fee|cod\s*fee|pay\s*on\s*delivery\s*fee)/i;
    // Amount with optional ₹ prefix — captures "₹ 599", "₹599", "599.00" etc.
    // Extended with Tesseract OCR confusions for ₹: commonly read as { < ¥ ¢ # 7 t z etc.
    const AMOUNT_VALUE_PATTERN = '(?:₹|(?:rs|r[5s$iIzZ])\\.?|inr|[{<¥¢])?\\s*\\.?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';
    // Indian currency explicit prefix: ₹, Rs, Rs., INR, plus Tesseract misread variants
    // (R5, R$, Ri, RI, Rz, RZ, r5) and other common ₹ OCR confusions ({, <, ¥, ¢, #, t, z)
    const INR_VALUE_PATTERN = '(?:₹|(?:rs|r[5s$iIzZ])\\.?|inr|(?:rupees?)|[{<¥¢#])\\s*\\.?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)(?:\\s*\\/-)?';
    const BARE_AMOUNT_PATTERN = '\\b([0-9]{2,8}(?:\\.[0-9]{1,2})?)\\b';

    // ── Compiled regexes ──
    const ORDER_LABEL_RE             = new RegExp(ORDER_LABEL_PATTERN, 'i');
    const AMAZON_ORDER_RE            = new RegExp(AMAZON_ORDER_PATTERN, 'i');
    const AMAZON_ORDER_GLOBAL_RE     = new RegExp(AMAZON_ORDER_PATTERN, 'gi');
    const FLIPKART_ORDER_RE          = new RegExp(FLIPKART_ORDER_PATTERN, 'i');
    const FLIPKART_ORDER_GLOBAL_RE   = new RegExp(FLIPKART_ORDER_PATTERN, 'gi');
    const MYNTRA_ORDER_RE            = new RegExp(MYNTRA_ORDER_PATTERN, 'i');
    const MYNTRA_ORDER_GLOBAL_RE     = new RegExp(MYNTRA_ORDER_PATTERN, 'gi');
    const MEESHO_ORDER_RE            = new RegExp(MEESHO_ORDER_PATTERN, 'i');
    const MEESHO_ORDER_GLOBAL_RE     = new RegExp(MEESHO_ORDER_PATTERN, 'gi');
    const AJIO_ORDER_RE              = new RegExp(AJIO_ORDER_PATTERN, 'i');
    const AJIO_ORDER_GLOBAL_RE       = new RegExp(AJIO_ORDER_PATTERN, 'gi');
    const JIO_ORDER_RE               = new RegExp(JIO_ORDER_PATTERN, 'i');
    const NYKAA_ORDER_RE             = new RegExp(NYKAA_ORDER_PATTERN, 'i');
    const TATA_ORDER_RE              = new RegExp(TATA_ORDER_PATTERN, 'i');
    const SNAPDEAL_ORDER_RE          = new RegExp(SNAPDEAL_ORDER_PATTERN, 'i');
    const BIGBASKET_ORDER_RE         = new RegExp(BIGBASKET_ORDER_PATTERN, 'i');
    const ONMG_ORDER_RE              = new RegExp(ONMG_ORDER_PATTERN, 'i');
    const CROMA_ORDER_RE             = new RegExp(CROMA_ORDER_PATTERN, 'i');
    const PURPLLE_ORDER_RE           = new RegExp(PURPLLE_ORDER_PATTERN, 'i');
    const SHOPSY_ORDER_RE            = new RegExp(SHOPSY_ORDER_PATTERN, 'i');
    const BLINKIT_ORDER_RE           = new RegExp(BLINKIT_ORDER_PATTERN, 'i');
    const ZEPTO_ORDER_RE             = new RegExp(ZEPTO_ORDER_PATTERN, 'i');
    const LENSKART_ORDER_RE          = new RegExp(LENSKART_ORDER_PATTERN, 'i');
    const PHARMEASY_ORDER_RE         = new RegExp(PHARMEASY_ORDER_PATTERN, 'i');
    const SWIGGY_ORDER_RE            = new RegExp(SWIGGY_ORDER_PATTERN, 'i');
    const AMAZON_SPACED_GLOBAL_RE    = new RegExp(AMAZON_SPACED_PATTERN, 'g');
    const GENERIC_ID_RE              = new RegExp(GENERIC_ID_PATTERN, 'i');
    const AMOUNT_VALUE_GLOBAL_RE     = new RegExp(AMOUNT_VALUE_PATTERN, 'g');
    const INR_VALUE_GLOBAL_RE        = new RegExp(INR_VALUE_PATTERN, 'gi');
    const BARE_AMOUNT_GLOBAL_RE      = new RegExp(BARE_AMOUNT_PATTERN, 'g');

    const sanitizeOrderId = (value: unknown) => {
      if (typeof value !== 'string') return null;
      let raw = value.trim().replace(/[\s]+/g, '');
      if (!raw) return null;
      const upper = raw.toUpperCase();
      if (upper.startsWith('E2E-') || upper.startsWith('SYS') || upper.includes('MOBO') || upper.includes('BUZZMA')) {
        return null;
      }
      if (/^[a-f0-9]{24}$/i.test(raw)) return null; // legacy hex ID
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return null; // UUID
      // Normalize Flipkart OD prefix: OCR often produces "0OD..." or "00D..." instead of "OD..."
      if (/^[0o][Oo0][Dd]\d{10,}$/i.test(raw)) raw = 'OD' + raw.slice(3);
      else if (/^[0o][Dd]\d{10,}$/i.test(raw)) raw = 'OD' + raw.slice(2);
      if (raw.length < 4 || raw.length > 64) return null;
      // Must contain at least one digit to be a valid order ID
      if (!/\d/.test(raw)) return null;
      return raw;
    };

    const normalizeOcrText = (value: unknown) =>
      typeof value === 'string'
        ? value
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            // Fix common OCR ligature/encoding artifacts
            .replace(/ﬁ/g, 'fi')
            .replace(/ﬂ/g, 'fl')
            .replace(/\u00a0/g, ' ')  // non-breaking space
            .replace(/[\u2018\u2019\u201a\u201b]/g, "'")  // smart single quotes
            .replace(/[\u201c\u201d\u201e\u201f]/g, '"')  // smart double quotes
            .replace(/[\u2013\u2014]/g, '-')  // en-dash / em-dash → hyphen
            .replace(/\u2026/g, '...')  // ellipsis
            .replace(/\u20b9/g, '₹')     // Indian Rupee sign variant
            .replace(/\u00d7/g, 'x')     // multiplication sign → x
            .replace(/\u200b/g, '')       // zero-width space
            .replace(/\u200c/g, '')       // zero-width non-joiner
            .replace(/\u200d/g, '')       // zero-width joiner
            .replace(/\ufeff/g, '')       // BOM
            // ── Fix ₹ sign misread as a digit before amounts ──
            // Tesseract commonly reads ₹ as 2, 7, t, z, %, #, { placed before digits
            // Pattern: single char that is a known ₹ misread + space? + digits with commas
            // e.g. "2 599" → "₹ 599", "7,599" where 7 is the ₹ sign → "₹599"
            // We only do this after a price label (Total, Amount, etc.) context — handled at extraction time
            // Here we normalize obvious patterns: single ₹-lookalike char directly attached to amounts
            .replace(/(?<=\b(?:total|amount|paid|price|grand|payable|you\s*pay|bill)\s*:?\s*)[tTzZ%]\s*(?=\d{2,6}(?:[.,]\d{1,2})?\b)/gi, '₹')
            // Note: digit-as-₹ correction (e.g. "2599" where 2 is ₹) is handled by the
            // detectRupeeSignAsDigit post-processing check rather than text normalization,
            // because we can't distinguish a real leading digit from a misread ₹ at this stage.
        : '';

    const normalizeLine = (line: string) => line.trim();

    const hasOrderKeyword = (line: string) => ORDER_KEYWORD_RE.test(line);
    const hasExcludedKeyword = (line: string) => EXCLUDED_LINE_RE.test(line);

    const normalizeCandidate = (value: string) =>
      value.replace(/[\s:]/g, '').replace(/[\.,]$/, '').trim().toUpperCase();

    const scoreOrderId = (value: string, context: { hasKeyword: boolean; occursInText: boolean }) => {
      const upper = value.toUpperCase().replace(/\s/g, '');
      let score = 0;
      if (context.hasKeyword) score += 4;
      if (upper.includes('-')) score += 2;
      if (/\d/.test(upper) && /[A-Z]/.test(upper)) score += 2;
      if (/^\d{10,20}$/.test(upper)) score += 1;
      // Platform-specific bonus scoring
      if (new RegExp(`^${AMAZON_ORDER_PATTERN}$`).test(upper)) score += 10;
      if (/^OD\d{10,}$/.test(upper)) score += 8;
      if (new RegExp(`^${MYNTRA_ORDER_PATTERN}$`).test(upper)) score += 8;
      if (new RegExp(`^${MEESHO_ORDER_PATTERN}$`).test(upper)) score += 8;
      if (new RegExp(`^${AJIO_ORDER_PATTERN}$`).test(upper)) score += 8;
      if (new RegExp(`^${JIO_ORDER_PATTERN}$`).test(upper)) score += 8;
      if (new RegExp(`^${SNAPDEAL_ORDER_PATTERN}$`).test(upper)) score += 8;
      if (new RegExp(`^${BIGBASKET_ORDER_PATTERN}$`).test(upper)) score += 8;
      if (context.occursInText) score += 1;
      return score;
    };

    /** Map OCR-confused characters to digits (for Amazon 17-digit extraction). */
    const normalizeDigits = (value: string) =>
      value
        .replace(/[Oo]/g, '0')
        .replace(/[Il|]/g, '1')
        .replace(/S/g, '5')
        .replace(/B/g, '8')
        .replace(/Z/g, '2')
        .replace(/[—–]/g, '-')    // em-dash / en-dash → hyphen
        .replace(/\./g, '-');     // period sometimes confused with dash

    const coerceAmazonOrderId = (value: string) => {
      // Try direct match first (already well-formed)
      const directMatch = value.match(/(\d{3})-(\d{7})-(\d{7})/);
      if (directMatch) return directMatch[0];
      // Try with normalized digits
      const normalized = normalizeDigits(value);
      const digitsOnly = normalized.replace(/[^0-9]/g, '');
      if (digitsOnly.length === 17) {
        return `${digitsOnly.slice(0, 3)}-${digitsOnly.slice(3, 10)}-${digitsOnly.slice(10)}`;
      }
      // If 18-19 digits, try trimming leading/trailing zeros from OCR noise
      if (digitsOnly.length >= 18 && digitsOnly.length <= 20) {
        for (let start = 0; start <= digitsOnly.length - 17; start++) {
          const candidate = digitsOnly.slice(start, start + 17);
          const formatted = `${candidate.slice(0, 3)}-${candidate.slice(3, 10)}-${candidate.slice(10)}`;
          if (/^\d{3}-\d{7}-\d{7}$/.test(formatted)) return formatted;
        }
      }
      return null;
    };

    const parseAmountString = (raw: string | undefined | null) => {
      if (!raw) return null;
      // Indian format: 1,23,456.00 → remove commas. Standard: 123,456.00 → remove commas.
      let cleaned = raw.replace(/,/g, '');
      // Strip leading zero that OCR sometimes adds (e.g., "0599" → "599")
      cleaned = cleaned.replace(/^0+(?=\d)/, '');
      const value = Number(cleaned);
      if (!Number.isFinite(value) || value <= 0) return null;
      // Round to 2 decimals to avoid floating point noise
      return Math.round(value * 100) / 100;
    };

    /**
     * Detect if an extracted amount looks like it has a misread ₹ sign as its leading digit.
     * Common OCR misreads: ₹ → 2, 7, t, z, %, {, <, #
     * Heuristic: if the amount has a leading digit and the "true" amount (without leading digit)
     * also appears on an amount-labeled line in the OCR text, the leading digit was likely ₹.
     * Returns the corrected amount or null if no correction needed.
     */
    const detectRupeeSignAsDigit = (amount: number, ocrTextRef: string): number | null => {
      const amtStr = String(Math.round(amount));
      if (amtStr.length < 3) return null; // Too short to have a ₹ prefix digit
      // Check if removing the first digit yields a plausible amount visible in OCR text
      const withoutFirst = amtStr.slice(1);
      const withoutFirstVal = Number(withoutFirst);
      if (!withoutFirstVal || withoutFirstVal < 10) return null;
      // The ratio between original and corrected should be roughly 10x (leading digit = ₹ misread)
      const ratio = amount / withoutFirstVal;
      if (ratio < 5 || ratio > 25) return null;
      // Check if the corrected amount appears after a price label in OCR text
      const labelRe = /(?:total|amount|paid|payable|grand|you\s*pay|bill|price)\s*:?\s*(?:₹|rs\.?|inr)?\s*/gi;
      let match;
      while ((match = labelRe.exec(ocrTextRef)) !== null) {
        const afterLabel = ocrTextRef.slice(match.index + match[0].length, match.index + match[0].length + 20);
        // Check if the corrected amount (with commas) appears right after the label
        const withCommas = withoutFirstVal >= 1000
          ? withoutFirstVal.toLocaleString('en-IN')
          : String(withoutFirstVal);
        if (afterLabel.includes(String(withoutFirstVal)) || afterLabel.includes(withCommas)) {
          return withoutFirstVal;
        }
      }
      return null;
    };

    const extractAmounts = (text: string, detectedOrderId?: string | null) => {
      const lines = text.split('\n').map(normalizeLine).filter(Boolean);
      const finalAmounts: Array<{ value: number; weight: number }> = [];   // "grand total", "amount paid", etc.
      const labeledAmounts: Array<{ value: number; weight: number; index: number }> = [];  // "total", "price", "subtotal", etc.

      // Build a set of EXACT segments from the order ID so we can
      // filter out order-ID-derived numbers when they appear as bare amounts.
      // e.g. order ID "408-0258263-2409973" → exact segments ["408","0258263","2409973", full "40802582632409973"]
      // IMPORTANT: We do NOT generate all 4+ digit contiguous substrings because that
      // falsely rejects MANY valid prices. A 17-digit Amazon order ID would generate
      // 105+ substring patterns that overlap with common ₹1000-₹9999 prices.
      const orderIdExactSegments = new Set<string>();
      let orderIdFullDigits = '';
      if (detectedOrderId) {
        orderIdFullDigits = detectedOrderId.replace(/[^0-9]/g, '');
        // Add the full concatenated digits
        if (orderIdFullDigits.length >= 4) orderIdExactSegments.add(orderIdFullDigits);
        // Add each hyphen/space-separated segment (e.g. "404", "6759408", "9041956")
        for (const seg of detectedOrderId.split(/[\-\s]+/)) {
          const d = seg.replace(/[^0-9]/g, '');
          if (d.length >= 3) orderIdExactSegments.add(d);
        }
      }

      /** Check if a raw numeric string is actually a sub-segment of the order ID.
       *  Uses conservative matching to avoid rejecting valid prices:
       *  - 3-4 digit amounts: only reject if they EXACTLY match a hyphen-separated segment
       *  - 5+ digit amounts: reject if they appear as a contiguous substring of the full digit string
       *  - Any length: reject if they exactly match a segment or the full digit string
       */
      const isOrderIdFragment = (raw: string) => {
        if (!detectedOrderId || !orderIdFullDigits) return false;
        const cleaned = raw.replace(/,/g, '').replace(/\.\d{1,2}$/, '');
        if (!cleaned) return false;
        // Exact match against any hyphen-separated segment or full digit string
        if (orderIdExactSegments.has(cleaned)) return true;
        // For 5+ digit amounts, check if they appear as a contiguous substring of the full digit string
        // (4-digit prices like ₹1408, ₹4089 are too common to reject based on substring matching)
        if (cleaned.length >= 5 && orderIdFullDigits.includes(cleaned)) return true;
        return false;
      };

      /** Weight final-amount labels by specificity to prefer "Grand Total" over just "Total" */
      const getFinalLabelWeight = (line: string): number => {
        if (/grand\s*total/i.test(line)) return 10;
        if (/amount\s*paid|paid\s*amount|you\s*paid|you\s*pay/i.test(line)) return 9;
        if (/to\s*pay|amount\s*to\s*pay/i.test(line)) return 9;
        if (/total\s*paid|total\s*amount|net\s*amount|payable/i.test(line)) return 8;
        if (/order\s*total|final\s*total|bill\s*amount|invoice\s*total/i.test(line)) return 8;
        if (/total\s*price|final\s*price|order\s*amount|purchase\s*total/i.test(line)) return 7;
        if (/estimated\s*total|checkout\s*total|payment\s*total/i.test(line)) return 7;
        if (/deducted|charged|debited/i.test(line)) return 6;
        return 5;
      };

      /** Weight for non-final labeled amounts — prefer "subtotal"/"total" over bare "price" */
      const getGenericLabelWeight = (line: string): number => {
        if (/item\s*total|subtotal|sub\s*total|bag\s*total|cart\s*value/i.test(line)) return 4;
        if (/total/i.test(line) && !/total\s*(fee|charge|tax|saving|discount)/i.test(line)) return 3;
        if (/deal\s*price|offer\s*price|sale\s*price|your\s*price/i.test(line)) return 2;
        return 1;
      };

      /** Check if a raw numeric string is likely a pincode (6-digit Indian pincode) */
      const isLikelyPincode = (raw: string, value: number, lineCtx?: string): boolean => {
        const cleaned = raw.replace(/,/g, '').replace(/\.\d{1,2}$/, '');
        // Indian pincodes: 6 digits, first digit 1-9, value 100000-999999
        if (/^\d{6}$/.test(cleaned) && value >= 100000 && value <= 999999) {
          // Only flag as pincode if surrounding text has address/pincode context
          // OR if the number falls in a known Indian pincode range (1xxxxx-8xxxxx)
          if (lineCtx && isAddressOrContactLine(lineCtx)) return true;
          // Known Indian pincode first-digit: 1-8 (9xxxxx is very rare)
          const firstDigit = parseInt(cleaned[0], 10);
          if (firstDigit >= 1 && firstDigit <= 8 && lineCtx && /\b(pin|zip|code|city|state|district|area|sector|colony|nagar|road|street|lane|near|opp|behind|floor|flat|apartment|house|bldg|block|plot|ward|village|taluk|mandal|tehsil)\b/i.test(lineCtx)) return true;
          // If line contains a final label like "Total", "Amount", "Price" — NOT a pincode
          if (lineCtx && FINAL_AMOUNT_LABEL_RE.test(lineCtx)) return false;
          if (lineCtx && AMOUNT_LABEL_RE.test(lineCtx)) return false;
          // If the line has an INR prefix (₹, Rs) before this number — NOT a pincode
          if (lineCtx && /[₹]|\brs\.?\s/i.test(lineCtx)) return false;
          // ── AGGRESSIVE PINCODE REJECTION ──
          // If the value is exactly 6 digits with no decimal, first digit 1-8,
          // and the line does NOT have any price/payment keyword, treat as pincode.
          // This catches bare 6-digit numbers that OCR picks up from address sections.
          if (firstDigit >= 1 && firstDigit <= 8 && lineCtx) {
            const hasPriceContext = /\b(price|amount|total|paid|pay|charge|fee|cost|value|₹|rs|inr|rupee|bill|invoice|debit|credit)\b/i.test(lineCtx);
            if (!hasPriceContext) return true;
          }
          // Default: treat standalone 6-digit numbers as possible pincodes only without any price context
          return !lineCtx;
        }
        return false;
      };

      /** Check if a raw numeric string is likely a phone number */
      const isLikelyPhoneNumber = (raw: string, value: number): boolean => {
        const cleaned = raw.replace(/,/g, '').replace(/\.\d{1,2}$/, '');
        // Indian phone: 10 digits starting with 6-9
        if (/^[6-9]\d{9}$/.test(cleaned)) return true;
        // With country code
        if (/^91\d{10}$/.test(cleaned)) return true;
        // 0-prefixed Indian number (11 digits)
        if (/^0[6-9]\d{9}$/.test(cleaned)) return true;
        // 10 digit number in general
        if (/^\d{10}$/.test(cleaned) && value >= 1000000000) return true;
        return false;
      };

      /** Check if the line context suggests this is an address/contact, not a price */
      const isAddressOrContactLine = (line: string): boolean => {
        return /\b(pincode|pin\s*code|zip|postal|address|deliver\s*to|ship\s*to|phone|mobile|contact|tel|fax)\b/i.test(line)
          || /\b(maharashtra|karnataka|tamil\s*nadu|delhi|mumbai|bangalore|chennai|hyderabad|kolkata|pune|jaipur|lucknow|ahmedabad|india|mhasas|jalgaon|pachora|vakad|pimpri|chinchwad|hingne|budrukh|karve\s*nagar|ajmer|rajasthan|uttar\s*pradesh|madhya\s*pradesh|andhra\s*pradesh|telangana|kerala|gujarat|bihar|odisha|assam|west\s*bengal|chhattisgarh|jharkhand|uttarakhand|himachal|goa|chandigarh|noida|gurgaon|gurugram|faridabad|ghaziabad|indore|bhopal|nagpur|surat|vadodara|coimbatore|visakhapatnam|patna|ranchi|bhubaneswar|dehradun|thiruvananthapuram|kochi|mangalore|mysore|jodhpur|udaipur|agra|varanasi|allahabad|kanpur|meerut|ludhiana|amritsar|jammu|srinagar)\b/i.test(line)
          || /\b\d{6}\b.*\b(india|in)\b/i.test(line);
      };

      const processAmountOnLine = (match: RegExpMatchArray, isFinalLabel: boolean, line: string, lineIndex: number) => {
        const value = parseAmountString(match[1]);
        if (!value) return false;
        if (isOrderIdFragment(match[1])) return false;
        // Reject amounts that are clearly too small to be an order total (< ₹1)
        if (value < 1) return false;
        // Reject values that look like 6-digit pincodes (unless line explicitly says "total"/"amount")
        if (isLikelyPincode(match[1], value, line) && !isFinalLabel) return false;
        // Reject values that look like phone numbers
        if (isLikelyPhoneNumber(match[1], value)) return false;
        // Reject if the line is clearly about addresses/contacts (not prices)
        if (isAddressOrContactLine(line) && !isFinalLabel) return false;
        const weight = isFinalLabel ? getFinalLabelWeight(line) : getGenericLabelWeight(line);
        if (isFinalLabel) finalAmounts.push({ value, weight });
        else labeledAmounts.push({ value, weight, index: lineIndex });
        return true;
      };

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        // Skip MRP / savings / discount lines — unless the line ALSO has a final amount label
        // e.g. "Total after discount ₹500" should NOT be skipped
        if (EXCLUDED_AMOUNT_LABEL_RE.test(line) && !FINAL_AMOUNT_LABEL_RE.test(line)) continue;

        const isFinalLabel = FINAL_AMOUNT_LABEL_RE.test(line);
        const isAnyLabel = AMOUNT_LABEL_RE.test(line);
        if (!isAnyLabel) continue;

        let foundOnLine = false;

        // Try INR-prefixed patterns FIRST (more specific — ₹599 is better signal than bare 599)
        INR_VALUE_GLOBAL_RE.lastIndex = 0;
        const inrMatches = line.matchAll(INR_VALUE_GLOBAL_RE);
        const seenValues = new Set<number>();
        for (const match of inrMatches) {
          const value = parseAmountString(match[1]);
          if (value && !seenValues.has(value)) {
            seenValues.add(value);
            if (processAmountOnLine(match, isFinalLabel, line, i)) foundOnLine = true;
          }
        }

        // Then try generic amount pattern (may not have ₹ prefix)
        const matches = line.matchAll(AMOUNT_VALUE_GLOBAL_RE);
        for (const match of matches) {
          const value = parseAmountString(match[1]);
          if (value && !seenValues.has(value)) {
            seenValues.add(value);
            if (processAmountOnLine(match, isFinalLabel, line, i)) foundOnLine = true;
          }
        }

        // If no amount on this line, check the next 5 lines (label on one line, value below)
        // OCR sometimes splits labels and values across many lines
        if (!foundOnLine) {
          const lookaheadSeen = new Set<number>();
          for (let offset = 1; offset <= 5 && i + offset < lines.length; offset++) {
            const nextLine = lines[i + offset];
            // Stop if the next line has its own label
            if (AMOUNT_LABEL_RE.test(nextLine)) break;
            const nextMatches = nextLine.matchAll(AMOUNT_VALUE_GLOBAL_RE);
            for (const match of nextMatches) {
              const value = parseAmountString(match[1]);
              if (!value || lookaheadSeen.has(value)) continue;
              lookaheadSeen.add(value);
              if (isOrderIdFragment(match[1])) continue;
              if (isLikelyPincode(match[1], value, nextLine) && !isFinalLabel) continue;
              if (isLikelyPhoneNumber(match[1], value)) continue;
              const w = isFinalLabel ? getFinalLabelWeight(lines[i]) : getGenericLabelWeight(lines[i]);
              if (isFinalLabel) finalAmounts.push({ value, weight: w });
              else labeledAmounts.push({ value, weight: w, index: i });
            }
            INR_VALUE_GLOBAL_RE.lastIndex = 0;
            const nextInr = nextLine.matchAll(INR_VALUE_GLOBAL_RE);
            for (const match of nextInr) {
              const value = parseAmountString(match[1]);
              if (!value || lookaheadSeen.has(value)) continue;
              lookaheadSeen.add(value);
              if (isOrderIdFragment(match[1])) continue;
              if (isLikelyPincode(match[1], value, nextLine) && !isFinalLabel) continue;
              if (isLikelyPhoneNumber(match[1], value)) continue;
              const w = isFinalLabel ? getFinalLabelWeight(lines[i]) : getGenericLabelWeight(lines[i]);
              if (isFinalLabel) finalAmounts.push({ value, weight: w });
              else labeledAmounts.push({ value, weight: w, index: i });
            }
          }
        }
      }

      // Priority: "final" labels (amount paid, grand total) > general labels (total, price)
      // Sort by weight (specificity of label) descending, then prefer the LAST occurrence among same weight
      if (finalAmounts.length) {
        // Sort by weight desc; among equal weights, prefer the last occurrence (bottom of receipt)
        const sorted = [...finalAmounts].sort((a, b) => b.weight - a.weight);
        return sorted[0].value;
      }
      if (labeledAmounts.length) {
        // Among labeled amounts, prefer highest weight (subtotal > price), then last occurrence (bottom of receipt)
        const sorted = [...labeledAmounts].sort((a, b) => b.weight - a.weight || b.index - a.index);
        return sorted[0].value;
      }

      // ── REVERSE LOOKBEHIND: Check amounts on unlabeled lines that have a label ABOVE them ──
      // OCR may place the label and amount on different lines with blank/noise lines between.
      // Scan every line with an INR-prefixed amount and check if any of the previous 5 lines had a label.
      const reverseLookbehind: Array<{ value: number; weight: number }> = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (AMOUNT_LABEL_RE.test(line)) continue; // Already handled above
        if (EXCLUDED_AMOUNT_LABEL_RE.test(line)) continue;
        INR_VALUE_GLOBAL_RE.lastIndex = 0;
        const inrOnLine = Array.from(line.matchAll(INR_VALUE_GLOBAL_RE));
        if (!inrOnLine.length) continue;

        // Check if any of the previous 5 lines had a final/general amount label
        let bestLabelWeight = 0;
        for (let back = 1; back <= 5 && i - back >= 0; back++) {
          const prevLine = lines[i - back];
          if (FINAL_AMOUNT_LABEL_RE.test(prevLine)) {
            bestLabelWeight = Math.max(bestLabelWeight, getFinalLabelWeight(prevLine));
            break;
          }
          if (AMOUNT_LABEL_RE.test(prevLine) && !EXCLUDED_AMOUNT_LABEL_RE.test(prevLine)) {
            bestLabelWeight = Math.max(bestLabelWeight, getGenericLabelWeight(prevLine));
            break;
          }
        }
        if (!bestLabelWeight) continue;

        for (const match of inrOnLine) {
          const value = parseAmountString(match[1]);
          if (!value) continue;
          if (isOrderIdFragment(match[1])) continue;
          if (isLikelyPincode(match[1], value, line)) continue;
          if (isLikelyPhoneNumber(match[1], value)) continue;
          if (isAddressOrContactLine(line)) continue;
          reverseLookbehind.push({ value, weight: bestLabelWeight });
        }
      }
      if (reverseLookbehind.length) {
        const sorted = [...reverseLookbehind].sort((a, b) => b.weight - a.weight);
        return sorted[0].value;
      }

      // ── "Recommended for you" / "Similar products" zone detection ──
      // Find the character offset where a recommendation section starts so we
      // can SKIP all amounts after that offset in the INR/bare fallbacks.
      const RECO_SECTION_RE = /\b(recommended\s*for\s*you|people\s*also\s*(bought|viewed)|similar\s*products?|you\s*may\s*also|frequently\s*bought|inspired\s*by\s*your|customers?\s*(also|who)|keep\s*shopping|based\s*on\s*your)\b/i;
      const recoMatch = RECO_SECTION_RE.exec(text);
      const recoStartOffset = recoMatch ? (recoMatch.index ?? text.length) : text.length;

      // Also detect Amazon bottom nav bar zone: "Home  You  Wallet  Cart  Menu  Rufus"
      const NAV_BAR_RE = /\b(Home|You|Wallet|Cart|Menu|Rufus)\b.*\b(Home|You|Wallet|Cart|Menu|Rufus)\b/;
      const navMatch = NAV_BAR_RE.exec(text);
      const navStartOffset = navMatch ? (navMatch.index ?? text.length) : text.length;

      // Use the EARLIER of the two as the "noise zone" cutoff
      const noiseZoneStart = Math.min(recoStartOffset, navStartOffset);

      // Fallback: any INR-prefixed value in the entire text (BEFORE noise zone)
      const inrMatches = text.matchAll(INR_VALUE_GLOBAL_RE);
      const inrValues: number[] = [];
      for (const match of inrMatches) {
        const value = parseAmountString(match[1]);
        if (!value) continue;
        if (isOrderIdFragment(match[1])) continue;
        if (isLikelyPhoneNumber(match[1], value)) continue;
        // Skip amounts after the "Recommended for you" / nav bar zone
        if ((match.index ?? 0) >= noiseZoneStart) continue;
        // Skip if the value's surrounding line is address/contact context
        const lineIdx = text.lastIndexOf('\n', (match.index ?? 0));
        const lineEnd = text.indexOf('\n', (match.index ?? 0) + match[0].length);
        const surroundingLine = text.slice(Math.max(0, lineIdx), lineEnd > 0 ? lineEnd : undefined);
        if (isAddressOrContactLine(surroundingLine) && !FINAL_AMOUNT_LABEL_RE.test(surroundingLine)) continue;
        // Skip INR values on EXCLUDED lines (MRP, listing price, discount, fee lines)
        if (EXCLUDED_AMOUNT_LABEL_RE.test(surroundingLine) && !FINAL_AMOUNT_LABEL_RE.test(surroundingLine)) continue;
        // Skip values on "FREE Delivery" / rating / review count lines
        if (/free\s*delivery|\brating|\breviews?\b|\bstars?\b|\d+\s*count\b/i.test(surroundingLine)) continue;
        inrValues.push(value);
      }
      // For INR fallback: prefer the LAST value in the text (bottom of receipt is typically the total)
      // If there are multiple, pick the one nearest to the end (most likely the final total)
      if (inrValues.length) {
        // If only 1 value, return it. Otherwise, prefer the last occurrence (bottom of receipt).
        // Math.max was wrong here — MRP lines at the top are often the highest amount.
        return inrValues[inrValues.length - 1];
      }

      // Last resort: bare numbers that look like prices (₹10 – ₹9,99,999)
      const bareMatches = text.matchAll(BARE_AMOUNT_GLOBAL_RE);
      const bareValues: number[] = [];
      for (const match of bareMatches) {
        const value = parseAmountString(match[1]);
        if (!value) continue;
        if (value < 1 || value > 9_999_999) continue;
        if (isOrderIdFragment(match[1])) continue; // Skip order ID digit fragments
        // Skip amounts after the "Recommended for you" / nav bar zone
        if ((match.index ?? 0) >= noiseZoneStart) continue;
        // Skip values that look like dates, years, phone numbers, pin codes
        if (/^\d{4}$/.test(match[1]) && value >= 1900 && value <= 2100) continue;
        // Context-aware pincode check for bare numbers
        const bl = text.lastIndexOf('\n', (match.index ?? 0));
        const be = text.indexOf('\n', (match.index ?? 0) + match[0].length);
        const bareLine = text.slice(Math.max(0, bl), be > 0 ? be : undefined);
        if (isLikelyPincode(match[1], value, bareLine)) continue;
        if (/^\d{10}$/.test(match[1])) continue; // phone number
        if (/^\d{12}$/.test(match[1])) continue; // Aadhaar-like number
        // Unix timestamps (starts with 16/17, 10+ digits)
        if (/^1[67]\d{8,}$/.test(match[1])) continue;
        // Common non-price sequences: quantity-like patterns (1x, 2x)
        if (/^\d{1}$/.test(match[1])) continue;
        bareValues.push(value);
      }
      // For bare numbers: prefer the last value (nearest to bottom of receipt)
      if (bareValues.length) return bareValues[bareValues.length - 1];

      // ── STRUCTURAL BOTTOM-OF-TEXT FALLBACK ──
      // When ALL previous methods fail, scan only the bottom 30% of lines
      // for any INR-prefixed or bare number that could be a total.
      // E-commerce receipts almost always show totals near the bottom.
      const bottomStartLine = Math.max(0, lines.length - Math.ceil(lines.length * 0.35));
      const bottomLines = lines.slice(bottomStartLine);
      const bottomText = bottomLines.join('\n');
      const bottomInrMatches = bottomText.matchAll(INR_VALUE_GLOBAL_RE);
      const bottomValues: number[] = [];
      for (const match of bottomInrMatches) {
        const value = parseAmountString(match[1]);
        if (!value || value < 10) continue;
        if (isOrderIdFragment(match[1])) continue;
        if (isLikelyPhoneNumber(match[1], value)) continue;
        // Pincode check: locate the line context for this match
        const bInrLine = bottomText.slice(
          Math.max(0, bottomText.lastIndexOf('\n', match.index ?? 0)),
          (bottomText.indexOf('\n', (match.index ?? 0) + match[0].length) + 1) || undefined,
        );
        if (isLikelyPincode(match[1], value, bInrLine)) continue;
        bottomValues.push(value);
      }
      if (bottomValues.length) return bottomValues[bottomValues.length - 1];
      // Bare number scan on bottom lines
      const bottomBareMatches = bottomText.matchAll(BARE_AMOUNT_GLOBAL_RE);
      for (const match of bottomBareMatches) {
        const value = parseAmountString(match[1]);
        if (!value || value < 10 || value > 999999) continue;
        if (isOrderIdFragment(match[1])) continue;
        if (/^\d{10}$/.test(match[1])) continue;
        if (/^\d{1}$/.test(match[1])) continue;
        const bLine = bottomText.slice(
          Math.max(0, bottomText.lastIndexOf('\n', match.index ?? 0)),
          (bottomText.indexOf('\n', (match.index ?? 0) + match[0].length) + 1) || undefined,
        );
        if (isLikelyPincode(match[1], value, bLine)) continue;
        return value;
      }

      return null;
    };

    /** Extract order date from OCR text. */
    const extractOrderDate = (text: string): string | null => {
      const lines = text.split('\n').map(normalizeLine).filter(Boolean);

      // Look for lines containing date-related keywords
      const dateKeywordRe = /\b(order\s*(placed|date|confirmed)|placed\s*on|date|ordered\s*on|purchase\s*date|bought\s*on|order\s*created|placed\s*date|created\s*on|transaction\s*date|booking\s*date|purchased\s*on|confirmed\s*on|delivered\s*on|delivered\s*,|return\s*(initiated|,)|shipped\s*on|dispatched\s*on|refund\s*(initiated|,))\b/i;
      // Lines to SKIP for date extraction (not order dates)
      const dateExcludeRe = /\b(return\s*window|return\s*or\s*replace|return\s*policy|refund\s*ref|how\s*do\s*i|bank\s*account|bank\s*statement)\b/i;
      // Date patterns: "7 February 2026", "07-02-2026", "07/02/2026", "Feb 7, 2026", "2026-02-07", "18-Mar-2022"
      const datePatterns = [
        /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
        /(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/,
        /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/,
        /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i,
        /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i,
        // dd-MMM-yyyy: "18-Mar-2022", "01/Jan/2026"
        /(\d{1,2})\s*[-\/]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*[-\/,]?\s*(\d{4})/i,
        // "October 18, 2025" full month with comma
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*,\s*(\d{4})/i,
      ];

      // First try lines with date keywords
      for (const line of lines) {
        if (!dateKeywordRe.test(line)) continue;
        if (dateExcludeRe.test(line)) continue;
        for (const pattern of datePatterns) {
          const match = line.match(pattern);
          if (match) return match[0].trim();
        }
      }

      // Fallback: look for any date-like pattern in the entire text
      for (const pattern of datePatterns) {
        const match = text.match(pattern);
        if (match) return match[0].trim();
      }

      return null;
    };

    /** Extract "Sold by" merchant name from OCR text. */
    const extractSoldBy = (text: string): string | null => {
      const lines = text.split('\n').map(normalizeLine).filter(Boolean);

      const soldByRe = /\b(sold\s*by|seller\s*[:\-]|shipped\s*by|fulfilled\s*by|dispatched\s*by|supplied\s*by|brand\s*store|authorized\s*seller)\s*[:\-]?\s*/i;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(soldByRe);
        if (match) {
          // Extract the text after "Sold by:"
          const afterKeyword = line.slice(match.index! + match[0].length).trim();
          if (afterKeyword && afterKeyword.length >= 2 && afterKeyword.length <= 120) {
            // Clean up common OCR artifacts
            const cleaned = afterKeyword
              .replace(/[^A-Za-z0-9\s&.,\-'()]/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            if (cleaned.length >= 2) return cleaned;
          }
          // Check next line if this line only has the label
          const nextLine = lines[i + 1];
          if (nextLine && nextLine.length >= 2 && nextLine.length <= 120) {
            const cleaned = nextLine
              .replace(/[^A-Za-z0-9\s&.,\-'()]/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            if (cleaned.length >= 2) return cleaned;
          }
        }
      }

      return null;
    };

    // ── Platform detection from OCR text for context-aware extraction ──
    const detectPlatform = (text: string): string => {
      const lower = text.toLowerCase();
      // Direct domain / branding matches
      if (/amazon\.(in|com)|amzn|a]mazon/i.test(text)) return 'amazon';
      if (/flipkart|f1ipkart|fl[i1]pkart/i.test(text)) return 'flipkart';
      if (/myntra|myntr[a4]/i.test(text)) return 'myntra';
      if (/meesho|m[e3][e3]sh[o0]/i.test(text)) return 'meesho';
      if (/\bblinkit|blink\s*it|grofers/i.test(text)) return 'blinkit';
      if (/nykaa|nyk[a4][a4]/i.test(text)) return 'nykaa';
      if (/\bajio\b/i.test(text)) return 'ajio';
      if (/jiomart|jio\s*mart/i.test(text)) return 'jiomart';
      if (/tata\s*cliq|tatacliq/i.test(text)) return 'tatacliq';
      if (/snapdeal/i.test(text)) return 'snapdeal';
      if (/bigbasket|big\s*basket/i.test(text)) return 'bigbasket';
      if (/\bzepto\b/i.test(text)) return 'zepto';
      if (/\bcroma\b/i.test(text)) return 'croma';
      if (/lenskart/i.test(text)) return 'lenskart';
      if (/pharmeasy|pharm\s*easy/i.test(text)) return 'pharmeasy';
      if (/\bswiggy\b/i.test(text)) return 'swiggy';
      if (/\bpurplle\b/i.test(text)) return 'purplle';
      if (/\bshopsy\b/i.test(text)) return 'shopsy';
      // Order ID pattern detection
      if (/\b\d{3}-\d{7}-\d{7}\b/.test(text)) return 'amazon';
      if (/\bOD\d{10,}\b/i.test(text)) return 'flipkart';
      if (/\bMYN\d{6,}\b/i.test(text)) return 'myntra';
      if (/\bMSH\d{6,}\b|MEESHO\d+/i.test(text)) return 'meesho';
      if (/\bNYK\d{6,}\b/i.test(text)) return 'nykaa';
      if (/\bFN\d{6,}\b/i.test(text)) return 'ajio';
      if (/\bBLK\d{6,}\b|BLINKIT\d+/i.test(text)) return 'blinkit';
      if (lower.includes('prime') && lower.includes('order')) return 'amazon';
      return 'unknown';
    };

    /** Extract product name from OCR text. */
    const extractProductName = (text: string): string | null => {
      const lines = text.split('\n').map(normalizeLine).filter(Boolean);
      const platform = detectPlatform(text);

      // ── Patterns that DISQUALIFY a line from being a product name ──
      const excludePatterns = [
        /^(order|tracking|invoice|payment|ship|deliver|cancel|return|refund|subtotal|total|grand|amount|paid|you paid|item|qty|quantity)/i,
        /^\d+$/,
        /^[₹$€]\s*\d/,
        /^(rs|inr)\b/i,
        /^(sold|seller|fulfilled|dispatched)\s*by/i,
        /^(arriving|expected|estimated)\s*(on|by|date|delivery)/i,
        /^(your|my)\s*(account|order|address)/i,
        /^(ship\s*to|deliver\s*to|billing)/i,
        /^\d{1,2}\s*(january|february|march|april|may|june|july|august|september|october|november|december)/i,
        // ── URLs / domain names / navigation chrome ──
        /https?:\/\//i,
        /www\./i,
        /\.(com|in|co|org|net|io)[\/\s?#]/i,  // domain followed by path/space/query
        /amazon\.(in|com)\/|flipkart\.com|myntra\.com|meesho\.com|ajio\.com|nykaa\.com/i,
        /\breferrer|ref=|utm_|orderID=|order-details/i,
        // ── Browser / navigation chrome ──
        /^(home|search|sign\s*in|sign\s*out|log\s*in|log\s*out|my\s*cart|wish\s*list|help|contact)/i,
        /^(prime|fresh|mini|grocery|fashion|electronics|deals|category|departments|today)/i,
        // ── Pure numeric sequences (order IDs, dates, etc.) ──
        /^\d[\d\-\s]{10,}$/,
        // ── Delivery / shipment status lines — never product names ──
        /^(arriving|shipped|delivered|dispatched|out\s*for\s*(delivery|shipping)|in\s*transit|on\s*its?\s*way)/i,
        /^(order\s*(placed|confirmed|completed|cancelled)|packed|picked\s*up|return\s*(initiated|approved|refund))/i,
        /^(estimated|expected)\s*(delivery|arrival)/i,
        /^(rate\s*(this|your|product)|write\s*a?\s*review|share\s*(your|a)\s*(experience|feedback))/i,
        // ── Address / location lines ──
        /^\d{1,4}\s*,?\s*(street|road|lane|nagar|colony|sector|phase|plot|block|floor|flat|apt|apartment)/i,
        /\b(pincode|pin\s*code|zip)\s*[:\-]?\s*\d{5,6}\b/i,
        /\b(city|state|district|taluk|tehsil|mandal|village|town|ward|locality|area|landmark)\s*[:\-]/i,
        // ── Payment / transaction labels ──
        /^(payment\s*(method|mode|type|via)|paid\s*(via|using|by|with)|upi|credit\s*card|debit\s*card|net\s*banking|wallet|emi)/i,
        // ── Price breakdown / billing labels (should not be product names) ──
        /^(marketplace\s*fee|promotion\s*applied|item.?\s*subtotal|shipping|delivery\s*charge|convenience\s*fee|handling\s*fee|packaging|platform\s*fee|gst|cgst|sgst|igst|tax\b|total\s*fee|eco\s*fee|protection\s*fee|insurance\s*fee|tip\b|round\s*off)/i,
        /^(order\s*summary|price\s*details?|price\s*breakdown|billing\s*details?|payment\s*summary|invoice\s*details?)/i,
        /^(listing\s*price|selling\s*price|special\s*price|other\s*discount|total\s*fees|total\s*amount|grand\s*total|amount\s*paid|net\s*amount)/i,
        // ── COD / delivery fee lines (unanchored — catches OCR variants like "Cash/Pay on Delivery fee") ──
        /\b(delivery\s*fee|cod\s*(fee|charge)|pay\s*on\s*delivery\s*(fee|charge))\b/i,
        /\bcash.*delivery\s*fee/i,
        // ── OCR-mangled billing lines (Tesseract may garble first char: "[tem(s) subtotal") ──
        /\bsubtotal\s*[:\-]?\s*(rs|\u20b9|inr)/i,
        // ── Comma-separated category lists (not product names) ──
        /^[A-Z][a-z]+(\s*,\s*[A-Z][a-z]+){3,}/,  // "Tablets, Earbuds, Watch, Blue" pattern
        // ── Indian address patterns ──
        /\b(maharashtra|karnataka|tamil\s*nadu|delhi|mumbai|bangalore|chennai|hyderabad|kolkata|pune|jaipur|lucknow|ahmedabad|india|ajmer|rajasthan|uttar\s*pradesh|madhya\s*pradesh|andhra\s*pradesh|telangana|kerala|gujarat|bihar|odisha|assam|noida|gurgaon|gurugram|faridabad|ghaziabad|indore|bhopal|nagpur|surat|vadodara|coimbatore|patna|ranchi|dehradun|jodhpur|udaipur|agra|varanasi|kanpur|ludhiana|amritsar)\b/i,
        /\b\d{6}\b.*\b(india|in)\b/i,   // pincode followed by "India"
        // ── Order confirmation noise / UI chrome ──
        /^(thank\s*you|order\s*id|your\s*order|congratulations|order\s*confirmed|successfully)/i,
        /^(free\s*delivery|standard\s*delivery|express\s*delivery|same\s*day|next\s*day)/i,
        // ── Standalone status words ──
        /^(completed|pending|cancelled|processing|successful|approved|rejected|failed|accepted|verified|shipped|dispatched|confirmed|received)\s*$/i,
        // ── Flipkart/Amazon UI chrome ──
        /^(chat\s*with\s*us|see\s*all\s*updates?|download\s*invoice|rate\s*(your|the)\s*(experience|product)|how\s*do\s*i|return\s*window|payment\s*method|cash\s*on\s*delivery|paytm|upi\b|share\s*this)/i,
        /shared\s*this\s*order/i,
        /^(about|group\s*companies|consumer\s*policy|help|mail\s*us|registered\s*office)/i,
        /\bending\s*(in|with)\s*\d{3,4}\b/i,
        /^(meet\.google|stop\s*sharing|you,?\s*presenting)/i,
        // ── Lines containing 10-digit phone numbers (address/contact info) ──
        /\b[6-9]\d{9}\b/,
        // ── Lines that are "Ship to" / "Deliver to" / "Delivery details" headers ──
        /^(ship\s*to|deliver\s*to|delivery\s*details?|billing\s*address|shipping\s*address|contact\s*details?)/i,
        // ── Short proper-case person names (2-4 words, < 30 chars, no product keywords) ──
        // Matches: "Chetan Chaudhari", "Sagar Chaudhari", "Gaurav Chafle" etc.
        // ── App / store navigation ──
        /^(shop\s*(now|by|all)|view\s*(all|more|details)|see\s*(all|more)|browse|explore|discover)/i,
        /^(add\s*to\s*cart|buy\s*now|add\s*to\s*bag|go\s*to\s*cart|checkout|proceed|continue)/i,
        /^(similar\s*products?|you\s*may\s*also|frequently\s*bought|customers?\s*(also|who))/i,
        /^(bargain\s*recommend|recommended\s*for\s*you|people\s*also\s*(bought|viewed)|inspired\s*by\s*your)/i,
        // ── Flipkart/Amazon action buttons & UI chrome ──
        /^(edit\s*(order|item|address)|change\s*(date|address|slot)|cancel\s*(order|item|$)|track\s*(order|package|shipment)|cancel\s*items?)/i,
        /^(pay\s*(rs|\u20b9|inr)\s*\d|pay\s+\d)/i,
        /\border\s*can\s*be\s*tracked|tracking\s*link\b/i,
        /\bmanage\s*who\s*can\s*access/i,
        /\b(help|assist)\s*(our\s*)?delivery\s*agent/i,
        /\bshare\s*location/i,
        /\bdrop.*(item|package).*doorstep|to\s*drop\s*the\s*item/i,
        /\bhelp\s*india\s*make\s*good/i,
        /\bdid\s*you\s*find.*helpful/i,
        /^keep\s*shopping/i,
        /^(ask\s*product\s*question|write\s*a\s*product\s*review|ask\s*a\s*product)/i,
        /^(track\s*package|cancel\s*items?|write\s*a\s*product)/i,
        // ── Flipkart delivery timeline lines ──
        /^(delivery|shipped)\s*,?\s*(expected|tomorrow|today|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
        /^expected\s*by\s/i,
        /^you\s*can\s*cancel/i,
        // ── Flipkart breadcrumb navigation ──
        /^home\s*>\s*(my\s*account|my\s*orders)/i,
        // ── Platform domain names (standalone lines) ──
        /^(amazon|flipkart|meesho|myntra|nykaa|ajio|blinkit|jiomart|snapdeal|shopsy|croma|tatacliq|lenskart|pharmeasy|purplle|swiggy|zepto|bigbasket)\s*\.?\s*(in|com)?\s*$/i,
        // ── Seller prefix lines (should never be product name) ──
        /^seller\s*[:\-]/i,
        // ── Standalone offer count lines (Flipkart) ──
        /^\d+\s*offers?\s*$/i,
        // ── Rating / review noise ──
        /^(\d+\s*(star|rating|review)|★|☆|\d+(\.\d)?\s*\/\s*5)/i,
        // ── Quantity / item count lines ──
        /^(qty|quantity)\s*[:\-]?\s*\d+$/i,
        // ── Order ID-like patterns (should not be product names) ──
        /^\d{3}-\d{7}-\d{7}$/,
        /^OD\d{10,}$/i,
        /^MYN\d{6,}$/i,
        /^MSH\d{6,}$/i,
        /^FN\d{6,}$/i,
        // ── E-commerce domain / URL bar text that OCR might capture ──
        /^(amazon|flipkart|myntra|meesho|nykaa|purplle|ajio|snapdeal|jiomart|blinkit|bigbasket|zepto|swiggy|shopsy|tatacliq|croma|reliance)\s*\.?\s*(in|com|co\.in|app)\s*$/i,
        /^(www\.)?(amazon|flipkart|myntra|meesho|nykaa)\.(in|com)/i,
        // ── Amazon/Flipkart bottom navigation bar text ──
        /^(Home|You|Wallet|Cart|Menu|Rufus)\s*$/i,
        // ── "FREE Delivery" / delivery info lines ──
        /^free\s*delivery/i,
        /^(delivery|shipping)\s*by\s/i,
        // ── Star rating / review count lines that OCR can pick up ──
        /^\d[\d,]*\s*(ratings?|reviews?)\s*$/i,
        /^\d+(\.\d)?\s*out\s*of\s*5/i,
        // ── "Buy it again" / "View your item" / action buttons ──
        /^(buy\s*it\s*again|view\s*your\s*item|view\s*order|leave\s*(seller|delivery)\s*feedback)/i,
        // ── Recommendation section product cards (after "Recommended" header) ──
        // These may look like real products but belong to the suggestion section
        /^\d+%\s*off$/i,  // "5% off" discount badges on recommended cards
        /^M\.?R\.?P\.?\s*[:\-]?\s*₹/i,  // MRP lines in recommendation cards
        // ── Person names (2-3 proper-case words, < 35 chars, no product keywords) ──
        // Catches "Chetan Chaudhari", "Sagar Patil", "Gaurav Chafle", "Ashok Kumar Singh" etc.
        // These often appear in address/delivery sections and OCR picks them up.
      ];

      /** Check if a line looks like a person name (2-3 proper-case words, no product keywords) */
      const isLikelyPersonName = (line: string): boolean => {
        const trimmed = line.trim();
        if (trimmed.length > 40 || trimmed.length < 4) return false;
        const words = trimmed.split(/\s+/);
        if (words.length < 2 || words.length > 4) return false;
        // Each word should be proper case (first letter upper) or all-upper short (< 5 chars)
        const allProperCase = words.every(w =>
          (/^[A-Z][a-z]+$/.test(w)) || (/^[A-Z]{1,5}$/.test(w)) || (/^[A-Z][a-z]+'s?$/.test(w))
        );
        if (!allProperCase) return false;
        // Must NOT contain product keywords
        if (/\b(phone|laptop|tablet|watch|earbuds?|headphone|speaker|shirt|shoe|bag|cream|oil|powder|book|cable|charger|mouse|keyboard|camera|pack|set|kit|ml|gm|kg|combo|serum|lotion|perfume|brush|bottle|cover|case|stand|holder|adapter|usb|bluetooth|wireless|cotton|leather|steel|glass|plastic|wooden|bamboo|silicone)\b/i.test(trimmed)) return false;
        // Common Indian first names as extra signal (optional — catch even more)
        if (/\b(Chetan|Sagar|Gaurav|Ashok|Sumit|Abhilash|Rajesh|Suresh|Pramod|Anil|Vijay|Rahul|Amit|Deepak|Manoj|Ravi|Sunil|Vinod|Ajay|Sanjay|Priya|Pooja|Neha|Anita|Rekha|Sunita|Kavita|Meena|Geeta|Savita|Root|Admin|User|Guest|Customer|Buyer|Shopper)\b/i.test(trimmed)) return true;
        return allProperCase;
      };

      // ── Detect "Recommended for you" section position ──
      // Products listed AFTER this header should not be considered as the order's product.
      const recoSectionHeaderIdx = lines.findIndex(l =>
        /\b(recommended\s*for\s*you|people\s*also\s*(bought|viewed)|similar\s*products?|you\s*may\s*also|frequently\s*bought|inspired\s*by\s*your|customers?\s*(also|who)|keep\s*shopping|based\s*on\s*your)\b/i.test(l)
      );
      // Effective end-of-content: only scan lines BEFORE the recommendation section
      const productScanEndIdx = recoSectionHeaderIdx >= 0 ? recoSectionHeaderIdx : lines.length;

      // ── PHASE 1: Platform-specific product name extraction ──
      // Platform-specific patterns locate product names more precisely by understanding page layout.
      let platformCandidate: string | null = null;

      if (platform === 'amazon') {
        // Amazon: product name appears AFTER "Order placed/Arriving/Delivered" and BEFORE "Sold by"
        // Product names can span MULTIPLE LINES — we need to merge adjacent descriptive lines.
        for (let i = 0; i < productScanEndIdx; i++) {
          const line = lines[i];
          // Look for product title lines between key markers
          const isAfterOrderInfo = i > 0 && lines.slice(Math.max(0, i - 5), i).some(
            l => /order\s*(placed|number|#|\d{3}-\d{7})|arriving|delivered|shipped|package\s*was/i.test(l)
          );
          const isBeforeSoldBy = i < lines.length - 1 && lines.slice(i + 1, Math.min(lines.length, i + 8)).some(
            l => /sold\s*by|seller|fulfilled|quantity/i.test(l)
          );
          if (isAfterOrderInfo || isBeforeSoldBy) {
            const isProductLine = (ln: string, idx: number) =>
              ln.length >= 5 && ln.length <= 300
              && !excludePatterns.some(p => p.test(ln))
              && /[a-zA-Z]/.test(ln)
              && (ln.match(/[a-zA-Z]/g) || []).length / ln.length > 0.35
              && !/^(order|arriving|delivered|shipped|tracking|payment|sold|seller|fulfilled|return|refund|package\s*was|return\s*window)/i.test(ln)
              && !/^\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(ln)
              && !/^₹\s*\d/.test(ln)
              && !/^\d+\.\d{2}$/.test(ln)
              && !/^(buy\s*it\s*again|view\s*your\s*item|track\s*package|leave\s*(seller|delivery)\s*feedback|write\s*a\s*product\s*review)/i.test(ln)
              // Skip lines in "Ship to" / address zone (within 5 lines after a "Ship to" / "Delivery details" header)
              && !lines.slice(Math.max(0, idx - 5), idx).some(
                prev => /^(ship\s*to|deliver\s*to|delivery\s*details?|billing|shipping\s*address)/i.test(prev)
              );

            if (isProductLine(line, i)) {
              // Try to merge with subsequent lines that are continuation of the product name
              let merged = line.trim();
              for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
                const nextLine = lines[j];
                // Stop merging if we hit a price, seller, status, or quantity line
                if (/^₹|^rs\.?|sold\s*by|seller|quantity|qty|return\s*window|buy\s*it\s*again|view\s*your|leave\s*(seller|delivery)|write\s*a\s*product|track\s*package/i.test(nextLine)) break;
                if (/^\d+\.\d{2}$/.test(nextLine)) break; // standalone price like "599.00"
                if (excludePatterns.some(p => p.test(nextLine))) break;
                // Break on standalone color names (not part of product title)
                if (/^(black|white|blue|red|green|yellow|pink|purple|grey|gray|silver|gold|orange|brown|navy|maroon|beige|cream|jet\s*black|ivory|teal|coral|mint|lavender|rose|charcoal|graphite|midnight|champagne|bronze|copper|titanium|space\s*grey|space\s*gray|starlight|midnight\s*blue|pearl\s*white|matte\s*black)\s*$/i.test(nextLine)) break;
                // If line looks like a continuation (contains letters, no excluded patterns)
                if (nextLine.length >= 3 && /[a-zA-Z]/.test(nextLine) && (nextLine.match(/[a-zA-Z]/g) || []).length / nextLine.length > 0.3) {
                  merged += ' ' + nextLine.trim();
                } else {
                  break;
                }
              }
              platformCandidate = merged.replace(/\s{2,}/g, ' ').trim();
              break;
            }
          }
        }
      } else if (platform === 'flipkart' || platform === 'shopsy') {
        // Flipkart: product name is often a LONG descriptive line after order status.
        // It can span MULTIPLE LINES — merge adjacent descriptive continuation lines.
        const isFlipkartProductLine = (ln: string, idx: number) =>
          ln.length >= 8 && ln.length <= 300
          && !excludePatterns.some(p => p.test(ln))
          && /[a-zA-Z]/.test(ln)
          && (ln.match(/[a-zA-Z]/g) || []).length / ln.length > 0.35
          && !/^(order|delivered|shipped|tracking|payment|sold|seller|fulfilled|return|refund|exchange|rate\s*this|star)/i.test(ln)
          && !/^₹\s*\d/.test(ln)
          && !/^\d+\.\d{2}$/.test(ln)
          && !/^(size|color|qty|quantity)\s*[:\-]/i.test(ln)
          && !/^(explore\s*plus|my\s*account|my\s*orders?|help\s*centre|notification)/i.test(ln)
          // Skip lines in "Delivery details" / address zone
          && !lines.slice(Math.max(0, idx - 3), idx).some(
            prev => /^(delivery\s*details?|ship\s*to|deliver\s*to|billing|shipping\s*address|contact\s*details?)/i.test(prev)
          );

        for (let i = 0; i < productScanEndIdx; i++) {
          const line = lines[i];
          if (line.length < 10) continue;
          if (!isFlipkartProductLine(line, i)) continue;
          // After order ID or delivery status
          const prevLines = lines.slice(Math.max(0, i - 5), i).join(' ');
          if (/OD\d+|order\s*id|delivered|shipped|your\s*order|order\s*placed|arriving/i.test(prevLines)) {
            // Next lines should have price/seller info
            const nextAreaLines = lines.slice(i + 1, Math.min(lines.length, i + 6)).join(' ');
            if (/₹|rs\.?|sold\s*by|seller|size|color|qty/i.test(nextAreaLines)) {
              // Try to merge continuation lines (Flipkart product titles can be multi-line)
              let merged = line.trim();
              for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
                const nextLine = lines[j];
                // Stop merging at price, seller, size, color, qty lines
                if (/^₹|^rs\.?|sold\s*by|seller|^(size|color|qty|quantity)\s*[:\-]/i.test(nextLine)) break;
                if (/^\d+\.\d{2}$/.test(nextLine)) break;
                if (excludePatterns.some(p => p.test(nextLine))) break;
                // Break on standalone color names (not part of product title)
                if (/^(black|white|blue|red|green|yellow|pink|purple|grey|gray|silver|gold|orange|brown|navy|maroon|beige|cream|jet\s*black|ivory|teal|coral|mint|lavender|rose|charcoal|graphite|midnight|champagne|bronze|copper|titanium|space\s*grey|space\s*gray|starlight|midnight\s*blue|pearl\s*white|matte\s*black)\s*$/i.test(nextLine)) break;
                // Continuation: short-ish text with letters
                if (nextLine.length >= 3 && /[a-zA-Z]/.test(nextLine) && (nextLine.match(/[a-zA-Z]/g) || []).length / nextLine.length > 0.3) {
                  merged += ' ' + nextLine.trim();
                } else {
                  break;
                }
              }
              platformCandidate = merged.replace(/\s{2,}/g, ' ').trim();
              break;
            }
          }
        }
      } else if (platform === 'myntra') {
        // Myntra: Brand name on one line, then product type on the next
        for (let i = 0; i < productScanEndIdx; i++) {
          const line = lines[i];
          if (line.length < 4) continue;
          if (excludePatterns.some(p => p.test(line))) continue;
          // Look for a brand-style short line followed by a descriptive product line
          const nextLine = lines[i + 1];
          if (nextLine && !excludePatterns.some(p => p.test(nextLine))) {
            const combined = `${line} ${nextLine}`.trim();
            if (combined.length >= 12 && combined.length <= 200
              && /[a-zA-Z]/.test(combined)
              && !/^(order|payment|track|deliver|return)/i.test(combined)) {
              // Check if nearby lines have price info
              const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 4)).join(' ');
              if (/₹|rs\.?|mrp|price|size|qty/i.test(nearby)) {
                platformCandidate = combined.replace(/\s{2,}/g, ' ').trim();
                break;
              }
            }
          }
          // Single line product name
          if (line.length >= 15 && line.length <= 200) {
            const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ');
            if (/₹|rs\.?|size|qty|MYN/i.test(nearby) && /[a-zA-Z]/.test(line)) {
              const alphaRatio = (line.match(/[a-zA-Z]/g) || []).length / line.length;
              if (alphaRatio > 0.5) {
                platformCandidate = line.replace(/\s{2,}/g, ' ').trim();
                break;
              }
            }
          }
        }
      } else if (platform === 'meesho') {
        // Meesho: product name is usually a descriptive line near the price
        for (let i = 0; i < productScanEndIdx; i++) {
          const line = lines[i];
          if (line.length < 10) continue;
          if (excludePatterns.some(p => p.test(line))) continue;
          const alphaRatio = (line.match(/[a-zA-Z]/g) || []).length / line.length;
          if (alphaRatio < 0.4) continue;
          const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ');
          if (/₹|rs\.?|price|total|MEESHO|MSH/i.test(nearby)) {
            platformCandidate = line.replace(/\s{2,}/g, ' ').trim();
            break;
          }
        }
      } else if (platform === 'nykaa' || platform === 'purplle') {
        // Nykaa/Purplle: beauty product names, often with brand + product type + size
        for (let i = 0; i < productScanEndIdx; i++) {
          const line = lines[i];
          if (line.length < 10) continue;
          if (excludePatterns.some(p => p.test(line))) continue;
          // Beauty products often have ml/gm units
          if (/\b(ml|gm|g|serum|cream|lipstick|foundation|mascara|lotion|shampoo|conditioner|moisturizer|cleanser|toner|perfume|fragrance|sunscreen|face\s*wash|body\s*wash|hair\s*oil|eye\s*liner|nail\s*polish|lip\s*balm|face\s*mask|sheet\s*mask)\b/i.test(line)) {
            platformCandidate = line.replace(/\s{2,}/g, ' ').trim();
            break;
          }
          const nearest = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ');
          if (/₹|rs\.?|price|NYK|nykaa|purplle/i.test(nearest)) {
            const alphaRatio = (line.match(/[a-zA-Z]/g) || []).length / line.length;
            if (alphaRatio > 0.5 && line.length >= 12) {
              platformCandidate = line.replace(/\s{2,}/g, ' ').trim();
              break;
            }
          }
        }
      } else if (platform === 'blinkit' || platform === 'zepto' || platform === 'bigbasket' || platform === 'swiggy') {
        // Grocery/quick commerce: product names include brand + item + weight
        for (let i = 0; i < productScanEndIdx; i++) {
          const line = lines[i];
          if (line.length < 8) continue;
          if (excludePatterns.some(p => p.test(line))) continue;
          if (/\b(ml|gm|g|kg|ltr|l|pcs|pieces?|pack|units?)\b/i.test(line) && /[a-zA-Z]/.test(line)) {
            platformCandidate = line.replace(/\s{2,}/g, ' ').trim();
            break;
          }
          const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ');
          if (/₹|rs\.?|qty|quantity|items?/i.test(nearby)) {
            const alphaRatio = (line.match(/[a-zA-Z]/g) || []).length / line.length;
            if (alphaRatio > 0.4 && line.length >= 10) {
              platformCandidate = line.replace(/\s{2,}/g, ' ').trim();
              break;
            }
          }
        }
      }

      // ── PHASE 2: Generic scoring approach (fallback) ──
      const candidates: Array<{ name: string; score: number }> = [];

      // Add platform candidate with high bonus score if found
      if (platformCandidate && platformCandidate.length >= 5) {
        candidates.push({ name: platformCandidate, score: 15 }); // High priority for platform-detected names
      }

      for (let i = 0; i < productScanEndIdx; i++) {
        const line = lines[i];
        if (line.length < 6 || line.length > 250) continue;
        if (excludePatterns.some(p => p.test(line))) continue;
        // Additional URL check: if the line contains a protocol-less URL
        if (/[a-z0-9]\.[a-z]{2,4}\/[^\s]*/i.test(line) && !/\b(ml|gm|kg|ltr|oz)\b/i.test(line)) continue;
        // Skip lines that are just comma-separated short words (category lists)
        const commaParts = line.split(/\s*,\s*/);
        if (commaParts.length >= 3 && commaParts.every(p => p.trim().split(/\s+/).length <= 2)) continue;
        // Skip lines that look like addresses (contain house no + area/locality info)
        if (/\d{1,5}\s*[,\/]\s*[A-Za-z]+\s*(road|street|lane|nagar|colony|sector|market|plaza|tower|building|complex|layout|garden|enclave|residency|apartment|society|block|phase|extension)/i.test(line)) continue;
        // Skip lines in address / delivery details zone (within 5 lines after "Ship to" / "Delivery details")
        const nearbyPrevLines = lines.slice(Math.max(0, i - 5), i);
        const isInAddressZone = nearbyPrevLines.some(
          prev => /^(ship\s*to|deliver\s*to|delivery\s*details?|billing|shipping\s*address|contact\s*details?)/i.test(prev)
        );
        if (isInAddressZone) {
          // Only allow lines in address zone if they have strong product keywords
          const hasProductKeyword = /\b(phone|laptop|tablet|watch|earbuds?|headphone|speaker|shirt|shoe|bag|cream|oil|powder|book|cable|charger|earphone|keyboard|mouse|camera|sink|steel|kitchen|washing|microwave|fridge|AC)\b/i.test(line);
          if (!hasProductKeyword) continue;
        }

        let score = 0;
        // Longer descriptive lines score higher (likely product names)
        if (line.length >= 20 && line.length <= 150) score += 3;
        if (line.length >= 30) score += 1;
        // Contains common product keywords (expanded for Indian e-commerce)
        if (/\b(for|with|pack|set|kit|box|ml|gm|kg|ltr|pcs|combo|cream|oil|shampoo|serum|lotion|perfume|spray|wash|soap|gel|powder|tablet|capsule|supplement|phone|case|cover|charger|cable|earphone|headphone|speaker|watch|band|ring|necklace|bracelet|shirt|pant|dress|shoe|sandal|slipper|bag|wallet|saree|kurti|kurta|lehenga|dupatta|salwar|churidar|jeans|tshirt|t-shirt|hoodie|jacket|blazer|suit|sneaker|boot|flip.?flop|backpack|handbag|purse|sunglasses|laptop|tablet|mouse|keyboard|monitor|printer|router|trimmer|groomer|dryer|iron|mixer|juicer|blender|cooker|bottle|mug|tumbler|flask|container|jar|brush|comb|razor|lipstick|foundation|mascara|eyeliner|moisturizer|cleanser|toner|face\s*wash|body\s*wash|conditioner|hair\s*oil|vitamin|protein|whey|snack|tea|coffee|ghee|honey|spice|pickle|rice|atta|dal|flour|sugar|milk|diaper|toy|puzzle|game|book|novel|sticker|pen|pencil|notebook|organizer|stand|holder|mount|adapter|converter|hub|splitter|extension|powerbank|power\s*bank|earbuds?|ear\s*buds?|smartwatch|smart\s*watch|fitness\s*band|smart\s*band|TWS|neckband|neck\s*band|air\s*purifier|water\s*purifier|vacuum|cleaner|mattress|pillow|bedsheet|curtain|towel|rug|carpet|cushion|refrigerator|fridge|washing\s*machine|microwave|AC|air\s*conditioner|fan|heater|inverter|stabilizer|geyser|water\s*heater|led|bulb|light|lamp|torch|battery|cell|sd\s*card|memory\s*card|pendrive|pen\s*drive|hard\s*disk|ssd|hdd|camera|lens|tripod|selfie\s*stick|gimbal|drone|gopro|action\s*cam|projector|screen\s*guard|tempered\s*glass|protector|stroller|walker|cradle|bassinet|car\s*seat)\b/i.test(line)) score += 4;
        // Contains pipe or dash separators (common in e-commerce titles)
        if (/[|]/.test(line)) score += 2;
        // Contains parentheses with size/variant info like "(Pack of 2)" or "(100ml)"
        if (/\([^)]{2,20}\)/.test(line)) score += 2;
        // Mixed case (product titles tend to be mixed case)
        if (/[A-Z]/.test(line) && /[a-z]/.test(line)) score += 1;
        // Near price/amount lines
        if (i > 0 && /₹|rs\.?|inr|price/i.test(lines[i - 1] || '')) score += 1;
        if (i < lines.length - 1 && /₹|rs\.?|inr|price/i.test(lines[i + 1] || '')) score += 2;
        // Near "sold by" lines (product is usually ABOVE "sold by")
        if (i < lines.length - 1 && /sold\s*by/i.test(lines[i + 1] || '')) score += 3;
        if (i < lines.length - 2 && /sold\s*by/i.test(lines[i + 2] || '')) score += 2;
        if (i > 0 && /sold\s*by/i.test(lines[i - 1] || '')) score += 1;
        // Brand name patterns (e.g., "Avimee Herbal", "HQ9", "Samsung")
        if (/^[A-Z][a-z]+\s[A-Z]/.test(line)) score += 1;
        // Product quantity/size patterns like "250ml", "1kg", "Pack of 3"
        if (/\b\d+\s*(ml|gm|g|kg|ltr|l|oz|pcs|pieces?|units?|count|pack)\b/i.test(line)) score += 3;
        // Color/size variant info ("Blue", "Size: M", "Color: Black")
        if (/\b(size|color|colour|variant)\s*[:\-]/i.test(line)) score += 2;
        // Penalize lines that are mostly numbers/special chars (not product-like)
        const alphaRatio = (line.match(/[a-zA-Z]/g) || []).length / line.length;
        if (alphaRatio < 0.4) score -= 2;
        // Penalize very short lines (less likely to be full product names)
        if (line.length < 15) score -= 1;
        // Penalize lines that look like address fragments
        if (/\b(near|behind|opposite|next\s*to|beside|opp|adj)\b/i.test(line)) score -= 3;
        if (/\b\d{5,6}\b/.test(line) && !/\b\d+\s*(ml|gm|g|kg|ltr|pcs|mah|wh|gb|tb|mb)\b/i.test(line)) score -= 3; // pincode-like numbers (but not "10000mah")
        // Penalize lines that are ALL CAPS short text (nav elements / buttons)
        if (line === line.toUpperCase() && line.length < 25 && !/\d/.test(line)) score -= 2;
        // Bonus: line near "product" or "item" keywords on prev/same line
        if (/\b(product|item)\s*(name|title|details?|description)?\s*[:\-]?\s*$/i.test(lines[i - 1] || '')) score += 4;
        if (/\b(product|item)\s*(name|title)\s*[:\-]\s*/i.test(line)) score += 3;
        // ── PERSON NAME PENALTY ──
        // Lines that look like person names (2-3 proper-case words) are NOT product names
        if (isLikelyPersonName(line)) score -= 6;
        // ── Additional address-line penalty ──
        // Lines with "flat", "floor", "house", "bldg" etc. are address fragments
        if (/\b(flat\s*no|floor|house\s*no|bldg|building|tower|wing|society|apartment|residency|enclave|layout|garden)\b/i.test(line)) score -= 4;

        if (score >= 3) {
          // ── MULTI-LINE MERGE for generic candidates ──
          // If the current line scores well, check if adjacent lines can be merged
          // to form a more complete product name (handles OCR splitting long titles)
          let mergedName = line.trim();
          for (let j = i + 1; j < Math.min(productScanEndIdx, i + 4); j++) {
            const nextLine = lines[j];
            if (!nextLine || nextLine.length < 3) break;
            // Stop merging at price, seller, quantity, status, or excluded-pattern lines
            if (/^₹|^rs\.?|sold\s*by|seller|^(size|color|qty|quantity)\s*[:\-]/i.test(nextLine)) break;
            if (/^\d+\.\d{2}$/.test(nextLine)) break;
            if (excludePatterns.some(p => p.test(nextLine))) break;
            if (isLikelyPersonName(nextLine)) break;
            // Don't merge standalone color names
            if (/^(black|white|blue|red|green|yellow|pink|purple|grey|gray|silver|gold|orange|brown|navy|maroon|beige|cream)\s*$/i.test(nextLine)) break;
            // Continuation: text with letters, reasonable length
            if (/[a-zA-Z]/.test(nextLine) && (nextLine.match(/[a-zA-Z]/g) || []).length / nextLine.length > 0.3) {
              mergedName += ' ' + nextLine.trim();
            } else {
              break;
            }
          }
          candidates.push({ name: mergedName.replace(/\s{2,}/g, ' ').trim(), score });
        }
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.score - a.score);
      // If top candidate looks like a generic category list, skip it
      const top = candidates[0].name;
      if (/^[A-Z][a-z]+(,\s*[A-Z][a-z]+)+$/.test(top)) return candidates[1]?.name || null;
      // If top candidate looks like a person name, skip it
      if (isLikelyPersonName(top)) return candidates[1]?.name || null;
      return top;
    };

    /** Fix common OCR letter/digit confusion for platform prefixes. */
    const fixOcrPrefixes = (line: string) =>
      line
        // Flipkart: 0D / 0d → OD (zero mistaken for O, any case)
        .replace(/\b0[Dd](\d{10,})\b/g, 'OD$1')
        // Myntra: 0RD → ORD
        .replace(/\b0RD(\d{6,})\b/gi, 'ORD$1')
        // Meesho: MEESH0 → MEESHO
        .replace(/\bMEESH0/gi, 'MEESHO')
        // Snapdeal: S0 → SD (if followed by digits)
        .replace(/\bS0(\d{8,})\b/g, 'SD$1')
        // BigBasket: 88 → BB (OCR reads B as 8)
        .replace(/\b88(\d{8,})\b/g, 'BB$1')
        // Nykaa: NYK already fine
        // Tata: TCL already fine
        ;

    const extractOrderId = (text: string) => {
      const lines = text.split('\n').map(normalizeLine).filter(Boolean);
      const candidates: Array<{ value: string; score: number }> = [];

      const pushCandidate = (value: string, hasKeyword: boolean) => {
        const sanitized = sanitizeOrderId(value);
        if (!sanitized) return;
        const occursInText = text.toLowerCase().includes(sanitized.toLowerCase());
        const score = scoreOrderId(sanitized, { hasKeyword, occursInText });
        candidates.push({ value: sanitized, score });
      };

      // Detect platform once to gate Amazon extraction
      const orderIdPlatform = detectPlatform(text);
      const orderIdSkipAmazon = orderIdPlatform !== null && orderIdPlatform !== 'amazon';

      for (let i = 0; i < lines.length; i += 1) {
        const line = fixOcrPrefixes(lines[i]);
        if (hasExcludedKeyword(line)) continue;
        const hasKeyword = hasOrderKeyword(line);

        // Detect if this line contains a Flipkart OD-prefix pattern to avoid
        // extracting Amazon-style IDs from the same digit sequence
        const hasFlipkartOD = FLIPKART_ORDER_RE.test(line);
        const skipLineAmazon = hasFlipkartOD || orderIdSkipAmazon;

        if (hasKeyword) {
          const labeled = line.match(ORDER_LABEL_RE);
          if (labeled?.[1]) {
            // Don't coerce to Amazon format if line has Flipkart OD or non-Amazon platform detected
            if (!skipLineAmazon) {
              const coerced = coerceAmazonOrderId(labeled[1]);
              pushCandidate(coerced ?? labeled[1], true);
            } else {
              pushCandidate(labeled[1], true);
            }
          }

          if (!skipLineAmazon) {
            const spaced = line.match(new RegExp(AMAZON_SPACED_PATTERN));
            if (spaced?.[0]) {
              const coerced = coerceAmazonOrderId(spaced[0]);
              if (coerced) pushCandidate(coerced, true);
            }
          }

          const nextLine = lines[i + 1];
          if (nextLine) {
            const nextHasFlipkartOD = FLIPKART_ORDER_RE.test(fixOcrPrefixes(nextLine));
            if (!nextHasFlipkartOD && !orderIdSkipAmazon) {
              const amazonNext = nextLine.match(AMAZON_ORDER_RE);
              if (amazonNext?.[0]) {
                const coerced = coerceAmazonOrderId(amazonNext[0]);
                pushCandidate(coerced ?? amazonNext[0], true);
              }
              const spacedNext = nextLine.match(new RegExp(AMAZON_SPACED_PATTERN));
              if (spacedNext?.[0]) {
                const coerced = coerceAmazonOrderId(spacedNext[0]);
                if (coerced) pushCandidate(coerced, true);
              }
            }
            const genericNext = nextLine.match(GENERIC_ID_RE);
            if (genericNext?.[0]) pushCandidate(genericNext[0], true);
          }
        }

        // Only match Amazon pattern if line doesn't have Flipkart OD or non-Amazon platform detected
        if (!skipLineAmazon) {
          const amazon = line.match(AMAZON_ORDER_RE);
          if (amazon?.[0]) {
            const coerced = coerceAmazonOrderId(amazon[0]);
            pushCandidate(coerced ?? amazon[0], hasKeyword);
          }
        }

        // All platform-specific patterns (applied to each line)
        const platformRegexes: Array<[RegExp, boolean]> = [
          [FLIPKART_ORDER_RE, false],
          [MYNTRA_ORDER_RE, false],
          [MEESHO_ORDER_RE, false],
          [AJIO_ORDER_RE, false],
          [JIO_ORDER_RE, false],
          [NYKAA_ORDER_RE, false],
          [TATA_ORDER_RE, false],
          [SNAPDEAL_ORDER_RE, false],
          [BIGBASKET_ORDER_RE, false],
          [ONMG_ORDER_RE, false],
          [CROMA_ORDER_RE, false],
          [PURPLLE_ORDER_RE, false],
          [SHOPSY_ORDER_RE, false],
          [BLINKIT_ORDER_RE, false],
          [ZEPTO_ORDER_RE, false],
          [LENSKART_ORDER_RE, false],
          [PHARMEASY_ORDER_RE, false],
          [SWIGGY_ORDER_RE, false],
        ];
        for (const [re] of platformRegexes) {
          const m = line.match(re);
          if (m?.[0]) {
            // Normalize Flipkart prefix to uppercase OD
            let val = m[0];
            // OCR sometimes prepends garbage chars before OD: "0OD..." → "OD..."
            if (/^[0o][Oo0][Dd]/i.test(val)) val = 'OD' + val.slice(3);
            else if (/^[0o][Dd]/i.test(val)) val = 'OD' + val.slice(2);
            pushCandidate(val, hasKeyword);
          }
        }

        if (hasKeyword) {
          const generic = line.match(GENERIC_ID_RE);
          if (generic?.[0]) pushCandidate(generic[0], true);
        }
      }

      // ── Global scan (full text) with OCR prefix fixes ──
      const fixedText = fixOcrPrefixes(text);
      // Check if text contains Flipkart OD patterns — if so, skip Amazon global scan
      // to avoid extracting Amazon-style IDs from OD digit sequences
      const textHasFlipkartOD = FLIPKART_ORDER_GLOBAL_RE.test(fixedText);
      FLIPKART_ORDER_GLOBAL_RE.lastIndex = 0; // Reset after test
      // Also detect platform from text content — if the text mentions "flipkart", "myntra" etc.,
      // and doesn't mention "amazon", we should not force-create Amazon-style IDs from digit sequences
      const detectedPlatformFromText = detectPlatform(text);
      const isNonAmazonPlatform = detectedPlatformFromText && detectedPlatformFromText !== 'amazon';
      const skipAmazonExtraction = textHasFlipkartOD || isNonAmazonPlatform;
      const globalPlatformRegexes: RegExp[] = [
        ...(skipAmazonExtraction ? [] : [AMAZON_ORDER_GLOBAL_RE]),
        FLIPKART_ORDER_GLOBAL_RE,
        MYNTRA_ORDER_GLOBAL_RE,
        MEESHO_ORDER_GLOBAL_RE,
        AJIO_ORDER_GLOBAL_RE,
      ];
      for (const re of globalPlatformRegexes) {
        re.lastIndex = 0; // Reset global regex state
        for (const m of fixedText.matchAll(re)) {
          let val = m[0];
          if (/^[0o][Dd]/i.test(val)) val = 'OD' + val.slice(2);
          pushCandidate(val, false);
        }
      }

      // Only do Amazon spaced/digit extraction if no non-Amazon platform detected
      if (!skipAmazonExtraction) {
        const spacedAmazon = Array.from(text.matchAll(AMAZON_SPACED_GLOBAL_RE)).map((m) => m[0]);
        for (const chunk of spacedAmazon) {
          const coerced = coerceAmazonOrderId(chunk);
          if (coerced) pushCandidate(coerced, false);
        }

        const globalDigits = normalizeDigits(text).match(/\d{17}/g) || [];
        for (const digits of globalDigits) {
          if (digits.length === 17) {
            pushCandidate(`${digits.slice(0, 3)}-${digits.slice(3, 10)}-${digits.slice(10)}`, false);
          }
        }
      }

      const unique = Array.from(new Map(candidates.map((c) => [normalizeCandidate(c.value), c])).values());
      const sorted = unique.sort((a, b) => b.score - a.score || b.value.length - a.value.length);
      return sorted[0]?.value || null;
    };

    const strictOcrPrompt = [
      'You are a strict OCR engine with GOD-LEVEL accuracy.',
      'Return ONLY the exact visible text from the image.',
      'Do NOT summarize, infer, fix spelling, or add/remove words.',
      'Preserve line breaks and spacing.',
      '',
      'MULTI-DEVICE HANDLING:',
      '- This screenshot may come from ANY device: mobile phone, desktop browser, tablet, or laptop.',
      '- For DESKTOP/LAPTOP screenshots: the order info may be in the center or right side of a wide layout. Read ALL columns.',
      '- For TABLET screenshots: layout may be a mix of mobile and desktop. Read ALL visible text.',
      '- For MOBILE screenshots: layout is vertical. Read top-to-bottom.',
      '- Handle both light mode and dark mode UIs.',
      '- Handle both English and Hindi text (Indian e-commerce includes bilingual content).',
      '',
      'CRITICAL FIELDS TO CAPTURE WITH HIGHEST PRIORITY:',
      '- Order ID / Order Number (e.g., Amazon: 404-xxx-xxx, Flipkart: OD..., Myntra: MYN...)',
      '- Grand Total / Amount Paid / You Paid / Final Total (the actual amount customer paid)',
      '  IMPORTANT: Look for the ₹ symbol followed by a number. Also look for "Rs", "Rs.", "INR" followed by a number.',
      '  Common formats: ₹599, ₹ 599, Rs. 599, Rs 599.00, ₹1,499, ₹12,499.00',
      '  The amount is usually near labels like "Grand Total", "Amount Paid", "You Paid", "Order Total", "Total", "Payable".',
      '- Product Name / Item Title (full name as shown, NOT a URL or web address)',
      '- Sold By / Seller name',
      '- Order Date',
      '',
      'AMOUNT EXTRACTION RULES:',
      '- Read the ₹ sign carefully — OCR often misreads it as "2", "%", "t", or misses it entirely.',
      '- Indian number format uses commas differently: 1,23,456 (not 123,456). Preserve exactly as shown.',
      '- If you see a strikethrough/crossed-out price AND a current price, BOTH must be captured. The crossed-out is MRP, the other is the amount paid.',
      '- Common OCR confusion: ₹ → 2, Rs → R5, ₹ → t, . → ,',
      '',
      'Read every word visible in the image. Do not skip any text, even if partially obscured.',
    ].join('\n');

    const parseDataUrl = (dataUrl: string) => {
      if (!dataUrl.includes(',')) {
        return { mimeType: 'image/jpeg', data: dataUrl };
      }
      const [meta, data] = dataUrl.split(',', 2);
      const match = meta.match(/data:([^;]+);base64/i);
      return { mimeType: match?.[1] || 'image/jpeg', data: data || dataUrl };
    };

    const getImageBuffer = (base64: string) => {
      const parsed = parseDataUrl(base64);
      return Buffer.from(parsed.data, 'base64');
    };

    /**
     * Check if a buffer starts with known image magic bytes.
     * Prevents Sharp from crashing on garbage / corrupt / too-small data.
     */
    const isRecognizedImageBuffer = (buf: Buffer): boolean => {
      if (buf.length < 4) return false;
      // JPEG: FF D8 FF
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
      // PNG: 89 50 4E 47
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
      // WebP: RIFF....WEBP
      if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
      // GIF: GIF87a / GIF89a
      if (buf.toString('ascii', 0, 3) === 'GIF') return true;
      // BMP: BM
      if (buf[0] === 0x42 && buf[1] === 0x4D) return true;
      // TIFF: II (little-endian) or MM (big-endian)
      if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4D && buf[1] === 0x4D)) return true;
      // AVIF / HEIF: ....ftyp
      if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return true;
      return false;
    };

    const preprocessForOcr = async (
      base64: string,
      crop?: { top?: number; left?: number; height?: number; width?: number },
      mode: 'default' | 'highContrast' | 'inverted' = 'default',
    ) => {
      // Wrap in a timeout to prevent hangs on maliciously-crafted images
      const PREPROCESS_TIMEOUT = 15_000; // 15 seconds max per image
      try {
        let preprocessTimer: ReturnType<typeof setTimeout>;
        const result = await Promise.race([
          (async () => {
        const rawBuf = getImageBuffer(base64);
        if (!isRecognizedImageBuffer(rawBuf)) {
          return base64; // Not a valid image — skip Sharp processing
        }
        const input = sharp(rawBuf);
        const metadata = await input.metadata();
        const imgWidth = metadata.width ?? 0;
        const imgHeight = metadata.height ?? 0;

        // Guard against decompression bombs: reject images with extreme dimensions.
        // A 10000×10000 JPEG is ~300MB in RAM when decoded. Limit to 8000×8000 (≈192MB).
        const MAX_DIMENSION = 8000;
        if (imgWidth > MAX_DIMENSION || imgHeight > MAX_DIMENSION) {
          aiLog.warn(`Image too large for OCR: ${imgWidth}×${imgHeight}px (max ${MAX_DIMENSION}×${MAX_DIMENSION})`);
          return base64; // Skip preprocessing — let OCR handle raw data
        }

        let pipeline = input;
        if (crop && imgWidth > 0 && imgHeight > 0) {
          const left = Math.max(0, Math.floor(imgWidth * (crop.left ?? 0)));
          const top = Math.max(0, Math.floor(imgHeight * (crop.top ?? 0)));
          const cw = Math.max(1, Math.min(imgWidth - left, Math.floor(imgWidth * (crop.width ?? 1))));
          const ch = Math.max(1, Math.min(imgHeight - top, Math.floor(imgHeight * (crop.height ?? 1))));
          pipeline = pipeline.extract({ left, top, width: cw, height: ch });
        }

        // Upscale to help OCR with small fonts; keeps original size if already smaller to avoid
        // double-preprocessing artifacts when runTesseractOcr applies its own resize+enhance.
        pipeline = pipeline.resize({ width: 3000, withoutEnlargement: true });

        if (mode === 'inverted') {
          // Dark mode screenshots: invert BEFORE greyscale so dark backgrounds become white
          pipeline = pipeline.negate({ alpha: false });
        }

        pipeline = pipeline.grayscale().normalize();

        if (mode === 'highContrast') {
          // High-contrast: boost contrast aggressively for faded / low-contrast screenshots
          pipeline = pipeline.linear(1.6, -40).sharpen({ sigma: 2 });
        } else {
          pipeline = pipeline.sharpen();
        }

        const processed = await pipeline
          .jpeg({ quality: 92 })
          .toBuffer();

        return `data:image/jpeg;base64,${processed.toString('base64')}`;
          })(),
          new Promise<string>((_, reject) => {
            preprocessTimer = setTimeout(() => reject(new Error('Preprocessing timeout')), PREPROCESS_TIMEOUT);
          }),
        ]).finally(() => clearTimeout(preprocessTimer));
        return result;
      } catch (err) {
        aiLog.warn('OCR preprocessing failed, using original image', { error: err });
        return base64;
      }
    };

    const extractTextOnly = async (model: string, imageBase64: string) => {
      const parsed = parseDataUrl(imageBase64);
      const response = await withModelTimeout(ai!.models.generateContent({
        model,
        contents: [
          {
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.data,
            },
          },
          { text: strictOcrPrompt },
        ],
        config: {
          temperature: 0,
          maxOutputTokens: Math.min(env.AI_MAX_OUTPUT_TOKENS_EXTRACT, 8192),
          responseMimeType: 'text/plain',
        },
      }));
      return normalizeOcrText(response.text || '');
    };

    const runDeterministicExtraction = (text: string) => {
      const orderId = extractOrderId(text);
      // Pass the detected order ID to extractAmounts so it can filter out
      // numbers that are actually sub-segments of the order ID
      const amount = extractAmounts(text, orderId);
      const orderDate = extractOrderDate(text);
      const soldBy = extractSoldBy(text);
      const productName = extractProductName(text);
      const notes: string[] = [];
      if (orderId) notes.push('Deterministic order ID extracted.');
      if (amount) notes.push('Deterministic amount extracted.');
      if (orderDate) notes.push('Order date extracted.');
      if (soldBy) notes.push('Seller info extracted.');
      if (productName) notes.push('Product name extracted.');
      return { orderId, amount, orderDate, soldBy, productName, notes };
    };

    /** Tesseract.js fallback: local OCR that works without any external API. */
    const TESSERACT_TIMEOUT_MS = 20_000; // 20 seconds max for all Tesseract attempts (reduced from 45s to stay within Render's 30s request limit)
    const runTesseractOcr = async (imageBase64: string, preProcessed = false): Promise<string> => {
      let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
      const deadline = Date.now() + TESSERACT_TIMEOUT_MS;
      try {
        const buf = getImageBuffer(imageBase64);
        if (!isRecognizedImageBuffer(buf)) {
          return ''; // Not a valid image — skip Tesseract entirely
        }

        // When input is already preprocessed by preprocessForOcr (grayscale,
        // normalized, sharpened), skip re-enhancement to avoid double-processing
        // artifacts that degrade OCR quality.
        const enhanced = preProcessed
          ? await sharp(buf).resize({ width: 2400, withoutEnlargement: true }).jpeg({ quality: 95 }).toBuffer()
          : await sharp(buf)
              .resize({ width: 2400, withoutEnlargement: false })
              .grayscale()
              .normalize()
              .sharpen({ sigma: 1.5 })
              .linear(1.2, -20) // Increase contrast
              .jpeg({ quality: 95 })
              .toBuffer();

        worker = await acquireOcrWorker();
        // Try default PSM first (automatic), then PSM 6 (uniform block of text)
        const { data } = await worker.recognize(enhanced);
        let text = normalizeOcrText(data.text || '');

        // If default PSM yielded poor results, try PSM 6 (assumes a uniform block of text)
        if (Date.now() < deadline && (!text || text.length < 20)) {
          await worker.setParameters({ tessedit_pageseg_mode: '6' as any });
          const { data: data6 } = await worker.recognize(enhanced);
          const text6 = normalizeOcrText(data6.text || '');
          if (text6.length > text.length) text = text6;
        }

        // Binary threshold: convert to pure black & white — dramatically helps
        // with colored backgrounds, gradients, shadows in real screenshots.
        // This is the #1 Tesseract improvement for e-commerce screenshot OCR.
        if (Date.now() < deadline) {
          const binaryImg = await sharp(buf)
            .resize({ width: 2400, withoutEnlargement: false })
            .grayscale()
            .threshold(140) // Otsu-like binarization: anything < 140 → black, rest → white
            .jpeg({ quality: 95 })
            .toBuffer();
          await worker.setParameters({ tessedit_pageseg_mode: '3' as any });
          const { data: dataBin } = await worker.recognize(binaryImg);
          const textBin = normalizeOcrText(dataBin.text || '');
          if (textBin.length > text.length) text = textBin;
        }

        // If still poor and within budget, try a high-contrast version
        if (Date.now() < deadline && (!text || text.length < 30)) {
          const highContrast = await sharp(buf)
            .resize({ width: 2400, withoutEnlargement: false })
            .grayscale()
            .normalize()
            .linear(1.5, -40) // Aggressive contrast
            .sharpen({ sigma: 1.8 })
            .jpeg({ quality: 95 })
            .toBuffer();
          await worker.setParameters({ tessedit_pageseg_mode: '3' as any });
          const { data: dataHc } = await worker.recognize(highContrast);
          const textHc = normalizeOcrText(dataHc.text || '');
          if (textHc.length > text.length) text = textHc;
        }

        // Try PSM 4 (column text) for screenshots with side-by-side layouts
        if (Date.now() < deadline && (!text || text.length < 40)) {
          const columnEnhanced = await sharp(buf)
            .resize({ width: 2400, withoutEnlargement: false })
            .grayscale()
            .normalize()
            .sharpen({ sigma: 1.5 })
            .linear(1.4, -30)
            .jpeg({ quality: 95 })
            .toBuffer();
          await worker.setParameters({ tessedit_pageseg_mode: '4' as any });
          const { data: data4 } = await worker.recognize(columnEnhanced);
          const text4 = normalizeOcrText(data4.text || '');
          if (text4.length > text.length) text = text4;
        }

        // Binary threshold with inverted colors — helps dark-mode screenshots
        if (Date.now() < deadline && (!text || text.length < 40)) {
          const invertedBin = await sharp(buf)
            .resize({ width: 2400, withoutEnlargement: false })
            .negate({ alpha: false })
            .grayscale()
            .threshold(140)
            .jpeg({ quality: 95 })
            .toBuffer();
          await worker.setParameters({ tessedit_pageseg_mode: '3' as any });
          const { data: dataInvBin } = await worker.recognize(invertedBin);
          const textInvBin = normalizeOcrText(dataInvBin.text || '');
          if (textInvBin.length > text.length) text = textInvBin;
        }

        // PSM 11 (sparse text) — good for screenshots with text scattered across the page
        if (Date.now() < deadline && (!text || text.length < 30)) {
          await worker.setParameters({ tessedit_pageseg_mode: '11' as any });
          const { data: data11 } = await worker.recognize(enhanced);
          const text11 = normalizeOcrText(data11.text || '');
          if (text11.length > text.length) text = text11;
        }

        if (Date.now() >= deadline) {
          aiLog.warn('Tesseract OCR hit timeout — returning best result so far.');
        }

        return text;
      } catch (err) {
        aiLog.warn('Tesseract OCR failed', { error: err });
        // Worker errored — terminate instead of returning to pool
        if (worker) try { await releaseOcrWorker(worker as any, true); } catch { /* ignore */ }
        worker = null as any;
        return '';
      } finally {
        // Return the worker to the pool (healthy path only; error path already handled above).
        if (worker) try { await releaseOcrWorker(worker as any); } catch { /* ignore cleanup errors */ }
      }
    };

    const refineWithAi = async (
      model: string,
      ocrText: string,
      deterministic: { orderId: string | null; amount: number | null; orderDate: string | null; soldBy: string | null; productName: string | null }
    ) => {
      if (!ai) return null;
      const response = await withModelTimeout(ai.models.generateContent({
        model,
        contents: [
          {
            text: [
              'TASK: EXTRACT E-COMMERCE ORDER DETAILS FROM OCR TEXT.',
              'PRIORITY: ABSOLUTE ACCURACY REQUIRED.',
              '',
              '1. EXTRACT the Order ID exactly as it appears:',
              '   - Amazon: EXACTLY 3-7-7 digit format with dashes: "404-6759408-9041956". Found near "Order number" or "Order #".',
              '   - Flipkart: Starts with "OD" + 14-20 digits, NO dashes: "OD224446047669586000". Found near "Order #" at bottom.',
              '   - Myntra: "MYN-" or "ORD-" or "PP-" prefix + digits.',
              '   - Meesho: "MSH-" prefix + digits or purely numeric 10-15 digit IDs.',
              '   - Blinkit: "BLK-" prefix + digits or numeric.',
              '   - AJIO: "FN-" prefix + digits.',
              '   - Nykaa: "NYK-" prefix + digits.',
              '   - JioMart: "JIO" or "OM" prefix + digits.',
              '   - Snapdeal: "SD" prefix + digits.',
              '   - Swiggy/Zepto/BigBasket: Numeric order IDs.',
              '   - IGNORE: Tracking IDs, Shipment numbers, AWB, Invoice numbers, Transaction IDs, UTR, UPI Ref.',
              '',
              '2. EXTRACT the GRAND TOTAL / FINAL AMOUNT PAID:',
              '   - Look for labels: "Grand Total", "Amount Paid", "You Paid", "Order Total", "Total Amount", "Total amount", "Payable", "Net Amount", "Amount Due", "To Pay".',
              '   - AMAZON: Use ONLY "Grand Total" from Order Summary. IGNORE "Item(s) Subtotal", "Shipping", "Marketplace Fee", "Promotion Applied". Example: Grand Total ₹604.00 → 604.',
              '   - FLIPKART: Use ONLY "Total amount" from Price details. IGNORE "Listing price" (MRP), "Special price", "Selling price", "Total fees", "Delivery charges". Example: Total amount ₹1,408 → 1408.',
              '   - AJIO: "Order Total" or "Amount Payable".',
              '   - Do NOT return Listing price, MRP, Selling price, Special price, Subtotal, delivery charges, shipping fees, or marketplace fees as the amount.',
              '   - If you see "Selling price ₹9,999" and "Total amount ₹10,048" (with fees), use 10048 (the total).',
              '   - If you see "Listing price ₹2,299" and "Total amount ₹1,408", use 1408 (ignore listing price entirely).',
              '   - CRITICAL: The amount MUST NOT be digits from the Order ID. If Order ID is 404-6759408-9041956, then 404, 6759408, 9041956, 67594, 904195 are NOT the amount.',
              '   - CRITICAL: The amount MUST NOT be a 6-digit Indian pincode (like 411027, 411052, 431203, 560034, 201301).',
              '   - CRITICAL: The amount MUST NOT be a 10-digit phone number (like 7768014471, 9876543210).',
              '   - CRITICAL: The amount MUST NOT be a date (like 20260213, 18032022).',
              '   - Typical range: ₹1 to ₹500000. If you find a value outside this range, it is probably wrong.',
              '   - Amount format: ₹1,408 → 1408, ₹41,990.00 → 41990, ₹6,003 → 6003. Return as plain number (no comma, no ₹).',
              '',
              '3. EXTRACT the Order Date (when the order was placed).',
              '   - Amazon: "Order placed 13 February 2026" at the top.',
              '   - Flipkart: "Order Confirmed, Mar 18, 2022" in the timeline.',
              '',
              '4. EXTRACT "Sold by" / Seller name.',
              '   - Amazon: "Sold by: Cocoblu Retail" or "Sold by: Avimee_Herbal".',
              '   - Flipkart: "Seller: Flashstar Commerce" or "Seller: KSABOOK".',
              '   - Return ONLY the merchant/company name, strip all button text ("Ask Product Question", "Visit Store", "Leave seller feedback", etc.).',
              '',
              '5. EXTRACT the Product Name / Item title:',
              '   - This is the descriptive title of the physical item ordered.',
              '   - Amazon: Blue clickable link text below delivery status, above "Sold by". If it spans multiple lines, concatenate ALL lines.',
              '   - Flipkart: Main heading at the top of the order page.',
              '   - Examples of CORRECT product names:',
              '     "Lymio Cargo for Men || Cotton Cargo Pant || Drawstring Waist Pant (Available Also Plus Size) (Cargo-148-Grey-L)"',
              '     "Avimee Herbal Keshpallav Hair Oil for Hair Growth | For Both Men & Women | Helps to reduce Hair Fall | With Rosemary, Castor, Amla, Coconut and Bhringraj Oil | Mineral Oil Free | 100 ml"',
              '     "Infinix Hot 11 (Silver Wave, 64 GB)"',
              '     "Arihant Pathfinder Nda/na English Version"',
              '   - NEVER return these as product name: navigation text ("Deliver to", "Hello,", "Returns & Orders"), delivery status ("Delivered 16 February"), URLs, addresses (city/state/pincode), buttons ("Track package", "Write a review", "Buy it again"), price labels.',
              '   - If DETERMINISTIC_PRODUCT_NAME contains "Deliver to", "Hello,", "Returns", addresses, or is < 5 chars, override it.',
              '',
              '6. IGNORE ambiguous single/double digit numbers, system UUIDs, internal codes.',
              '7. If DETERMINISTIC values look correct, confirm them. If they look wrong, provide the correct values from OCR text.',
              '8. VERIFY: suggestedAmount must NOT be a substring of suggestedOrderId digits.',
              '9. VERIFY: suggestedAmount must NOT be a 6-digit pincode or 10-digit phone number.',
              '10. If you see multiple amounts, PREFER "Grand Total" > "Amount Paid" > "Total amount" > "Total" > "Payable" over unlabeled amounts.',
              '11. CRITICAL: The ₹ (rupee) symbol is NOT a digit. If OCR text shows "₹599", the amount is 599, NOT 8599 or 7599. Never include OCR misreads of ₹ as part of the number.',
              '12. CRITICAL: Product name must NEVER be a person\'s name (e.g., "Chetan Chaudhari", "Sagar Patil"). Person names are from the delivery address section, NOT the product.',
              '13. CRITICAL: If the product name spans MULTIPLE LINES in the screenshot, concatenate ALL lines into one continuous string. Do NOT return just the last line.',
              '14. CRITICAL: Address text (city names, state names, pincodes, "India", road/street names) must NEVER appear as product name.',
              `OCR_TEXT (Start):\n${ocrText}\n(End OCR_TEXT)`,
              `DETERMINISTIC_ORDER_ID: ${deterministic.orderId ?? 'null'}`,
              `DETERMINISTIC_AMOUNT: ${deterministic.amount ?? 'null'}`,
              `DETERMINISTIC_ORDER_DATE: ${deterministic.orderDate ?? 'null'}`,
              `DETERMINISTIC_SOLD_BY: ${deterministic.soldBy ?? 'null'}`,
              `DETERMINISTIC_PRODUCT_NAME: ${deterministic.productName ?? 'null'}`,
              'Return JSON with suggestedOrderId, suggestedAmount, suggestedOrderDate, suggestedSoldBy, suggestedProductName, confidenceScore (0-100), and notes.',
            ].join('\n'),
          },
        ],
        config: {
          temperature: 0,
          maxOutputTokens: Math.min(env.AI_MAX_OUTPUT_TOKENS_EXTRACT, 1024),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              suggestedOrderId: { type: Type.STRING },
              suggestedAmount: { type: Type.NUMBER },
              suggestedOrderDate: { type: Type.STRING },
              suggestedSoldBy: { type: Type.STRING },
              suggestedProductName: { type: Type.STRING },
              confidenceScore: { type: Type.INTEGER },
              notes: { type: Type.STRING },
            },
            required: ['confidenceScore'],
          },
        },
      }));

      return safeJsonParse<any>(response.text) ?? null;
    };

    /** Direct image-to-structured-data extraction (bypasses OCR text entirely). */
    const extractDirectFromImage = async (model: string, imageBase64: string) => {
      if (!ai) return null;
      const imgMimeType = detectImageMimeType(imageBase64);
      const response = await withModelTimeout(ai.models.generateContent({
        model,
        contents: [
          { inlineData: { mimeType: imgMimeType, data: imageBase64.split(',')[1] || imageBase64 } },
          { text: [
            'TASK: EXTRACT E-COMMERCE ORDER DETAILS FROM THIS SCREENSHOT.',
            'PRIORITY: ABSOLUTE ACCURACY REQUIRED. Every field must be 100% correct.',
            'This screenshot may be from ANY device: mobile phone (narrow vertical), desktop browser (wide horizontal), tablet, laptop.',
            '',
            'IMPORTANT CONTEXT:',
            '- This is an Indian e-commerce order screenshot from platforms like Amazon.in, Flipkart, Myntra, Meesho, Blinkit, Nykaa, AJIO, JioMart, Swiggy Instamart, Zepto, BigBasket, Snapdeal, Tata CLiQ, Croma, Lenskart, PharmEasy, Purplle, Shopsy, etc.',
            '- The screenshot is an ORDER DETAILS page showing a purchased product.',
            '- Currency is Indian Rupees (₹ / Rs / INR).',
            '- DO NOT confuse website header/navigation text with order data.',
            '- The Amazon header shows "Deliver to [Name]", "Hello, [Name]", "Returns & Orders" — these are NOT product data.',
            '- The Flipkart header shows "Explore Plus", account name, cart icon — these are NOT product data.',
            '',
            'EXTRACT THESE 5 FIELDS:',
            '',
            '1. ORDER ID — The unique order identifier:',
            '   PLATFORM-SPECIFIC FORMATS (match EXACTLY):',
            '   - Amazon: EXACTLY 3 digits, dash, 7 digits, dash, 7 digits. Example: "404-6759408-9041956" or "403-6379089-0697917". Found near "Order number" or "Order #" label.',
            '   - Flipkart: Starts with "OD" followed by 14-20 digits with NO dashes. Example: "OD224446047669586000" or "OD222370487245261000". Found near "Order #" at bottom of page.',
            '   - Myntra: Starts with "MYN" or "ORD" or "PP" prefix + digits. Example: "MYN-123456789".',
            '   - Meesho: Starts with "MSH" prefix + digits. Can also be purely numeric 10-15 digit IDs.',
            '   - Blinkit: Starts with "BLK" prefix + digits, or purely numeric.',
            '   - AJIO: Starts with "FN" prefix + digits.',
            '   - Nykaa: Starts with "NYK" prefix + digits.',
            '   - JioMart: Starts with "JIO" or "OM" prefix + digits.',
            '   - Snapdeal: Starts with "SD" prefix + digits.',
            '   - BigBasket: Starts with "BB" prefix + digits.',
            '   - Swiggy: Numeric order IDs.',
            '   - Zepto: Numeric order IDs.',
            '   - CRITICAL: IGNORE Tracking IDs, Shipment numbers, AWB numbers, Invoice numbers, Transaction IDs, UTR numbers, UPI Ref IDs.',
            '',
            '2. AMOUNT (Grand Total / Final Amount Actually Paid by Customer):',
            '   - This is the MOST IMPORTANT field to get right.',
            '   - AMAZON SPECIFIC: Look in the "Order Summary" box on the RIGHT side. Find "Grand Total: ₹XXX.XX". This is the final amount. If you see Promotion Applied as negative, the Grand Total already includes that discount. IGNORE "Item(s) Subtotal", "Shipping", "Marketplace Fee", and "Total" (which is pre-promotion). Use ONLY "Grand Total".',
            '   - FLIPKART SPECIFIC: Look in the "Price details" section on the RIGHT side. Find "Total amount" at the BOTTOM — that is the final paid amount. IGNORE "Listing price" (original MRP, often struck through), "Special price" (discounted unit price), "Selling price", and "Total fees" (fee breakdown). Use ONLY "Total amount".',
            '   - MEESHO: Look for "Total Amount" or "You Paid".',
            '   - BLINKIT/ZEPTO/SWIGGY: Look for "Bill Total" or "Grand Total" or "Amount Paid".',
            '   - MYNTRA: Look for "Total" at the bottom of the price breakdown.',
            '   - NYKAA: Look for "Amount Payable" or "Total".',
            '   - AJIO: Look for "Order Total" or "Amount Payable".',
            '   - The amount MUST be a monetary value, NOT digits from the Order ID.',
            '   - CRITICAL VALIDATION: If the Order ID is e.g. "404-6759408-9041956", numbers like 404, 6759408, 9041956, 67594, 90419 etc. are NOT the amount — they are parts of the Order ID.',
            '   - Typical range: ₹1 to ₹5,00,000 for individual orders.',
            '   - DO NOT return "Listing price", "MRP", "Selling price", "Special price", or "Subtotal" — ALWAYS prefer "Grand Total", "Total amount", "Amount Paid", "You Paid", or "Payable".',
            '   - DO NOT return 6-digit pincodes (like 411027, 411052, 560034) as amounts.',
            '   - DO NOT return 10-digit phone numbers (like 7768014471) as amounts.',
            '   - DO NOT return dates formatted as numbers as amounts.',
            '   - DO NOT return delivery charges, shipping fees, marketplace fees, platform fees as the amount.',
            '   - Return the amount as a plain number WITHOUT the ₹ symbol. Example: for ₹10,048 return 10048. For ₹604.00 return 604. For ₹1,408 return 1408.',
            '',
            '3. ORDER DATE — When the order was placed:',
            '   - Amazon: Near "Order placed [date]" at the top. Example: "Order placed 13 February 2026".',
            '   - Flipkart: Near "Order Confirmed, [date]" in the green timeline. Example: "Order Confirmed, Mar 18, 2022".',
            '   - Return the full date string as displayed (e.g., "13 February 2026", "Mar 18, 2022", "6 February 2026").',
            '   - If only "Delivered" date is visible and no order placed date, use the delivered date.',
            '',
            '4. SOLD BY / SELLER NAME:',
            '   - Amazon: Labeled "Sold by: [Seller Name]" near the product. Example: "Sold by: Cocoblu Retail", "Sold by: Avimee_Herbal".',
            '   - Flipkart: Labeled "Seller: [Name]" below the product name. Example: "Seller: Flashstar Commerce", "Seller: KSABOOK".',
            '   - Return ONLY the seller/merchant company name — no extra text.',
            '   - DO NOT include: "(Ask Product Question)", "(Visit Store)", "Leave seller feedback", "Leave delivery feedback", "Track package", "Write a product review", "Buy it again", "View your item", "Return or replace items".',
            '',
            '5. PRODUCT NAME — The full product title/name:',
            '   - This is the main item that was ordered — the descriptive product title.',
            '   - AMAZON: It appears as a BLUE clickable link in the order details, usually below delivery status ("Delivered 16 February") and above "Sold by". It is the main heading describing what was bought. If the title spans MULTIPLE LINES, include ALL lines as one continuous name.',
            '     Example: "Lymio Cargo for Men || Cotton Cargo Pant || Drawstring Waist Pant (Available Also Plus Size) (Cargo-148-Grey-L)"',
            '     Example: "Avimee Herbal Keshpallav Hair Oil for Hair Growth | For Both Men & Women | Helps to reduce Hair Fall | With Rosemary, Castor, Amla, Coconut and Bhringraj Oil | Mineral Oil Free | 100 ml"',
            '   - FLIPKART: It appears at the VERY TOP of the order details page, as the main product heading. Multi-word descriptive title.',
            '     Example: "Infinix Hot 11 (Silver Wave, 64 GB)"',
            '     Example: "Arihant Pathfinder Nda/na English Version"',
            '   - MYNTRA: Brand name line + product type line should be combined.',
            '   - MEESHO: Product title near the product image.',
            '   - BLINKIT/ZEPTO/BIGBASKET: Product name with weight/quantity (e.g., "Amul Butter 500g").',
            '   - NYKAA/PURPLLE: Beauty product with brand + product + size (e.g., "Maybelline Fit Me Foundation 115 Ivory 30ml").',
            '   - If the product name spans MULTIPLE LINES on screen, concatenate ALL lines into one string.',
            '   - CRITICAL: NEVER return these as product name:',
            '     * Navigation/header text: "Deliver to [Name]", "Hello, [Name]", "Returns & Orders", "Account & Lists", "Sign In", "Explore Plus", "Search for products"',
            '     * Delivery status lines: "Arriving tomorrow", "Delivered 16 February", "Shipped", "Out for delivery", "Package was handed to resident"',
            '     * URLs or web addresses',
            '     * Addresses: city names, pincodes, "MAHARASHTRA", "Hingne Budrukh, Karve Nagar", "PUNE", "India"',
            '     * Category breadcrumbs: "Electronics > Mobiles"',
            '     * Action buttons: "Track package", "Cancel items", "Write a review", "Buy it again", "View your item"',
            '     * Order labels: "Order #OD...", "Order placed..."',
            '     * Price labels: "₹599", "Grand Total", "Listing price", "Selling price"',
            '',
            'VALIDATION RULES:',
            '- Amount must be a plausible price (₹1 to ₹500000), NOT a pincode (6 digits like 411052), NOT a phone number (10 digits), NOT order ID digits.',
            '- Product name must describe a physical item, NOT navigation chrome or addresses.',
            '- Product name must NEVER be a person\'s name (e.g., "Chetan Chaudhari", "Sagar Patil", "Ashok Kumar"). Person names come from the delivery address section.',
            '- If the product name spans MULTIPLE LINES, concatenate ALL lines into one string. Do NOT return only the last line.',
            '- The ₹ (rupee) symbol is NOT a digit. If you see "₹599", amount is 599 — never add the ₹ symbol as a digit like "8599".',
            '- Address text (city names, state names, pincodes, street names, "India") must NEVER be the product name.',
            '- Order ID must follow the exact platform format described above.',
            '',
            'Return JSON with: orderId (string), amount (number), orderDate (string), soldBy (string), productName (string), confidenceScore (0-100 integer).',
            'If a field is not found, return empty string for strings and 0 for amount.',
          ].join('\n') },
        ],
        config: {
          temperature: 0,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              orderId: { type: Type.STRING },
              amount: { type: Type.NUMBER },
              orderDate: { type: Type.STRING },
              soldBy: { type: Type.STRING },
              productName: { type: Type.STRING },
              confidenceScore: { type: Type.INTEGER },
            },
            required: ['confidenceScore'],
          },
        },
      }));
      return safeJsonParse<any>(response.text) ?? null;
    };

    const runOcrPass = async (imageBase64: string, label: string) => {
      // Try Gemini OCR first (if available and circuit breaker is closed)
      if (ai && !isGeminiCircuitOpen()) {
        let text = '';
        for (const model of GEMINI_MODEL_FALLBACKS) {
          try {
            // eslint-disable-next-line no-await-in-loop
            text = await extractTextOnly(model, imageBase64);
            if (text) {
              aiLog.info('Order extract OCR pass', { label, model, length: text.length });
              recordGeminiSuccess();
              return text;
            }
          } catch (innerError) {
            aiLog.warn('[OCR] Model fallback error', { error: innerError instanceof Error ? innerError.message : innerError });
            _lastError = innerError;
            continue;
          }
        }
        // All Gemini models failed for this OCR pass — record failure for circuit breaker
        recordGeminiFailure();
      }
      // Fallback: Tesseract.js local OCR (works without Gemini API key)
      // Pass preProcessed=true for variants that already went through preprocessForOcr
      // (everything except 'original') to avoid double-enhancement artifacts.
      const isPreProcessed = label !== 'original';
      const tesseractText = await runTesseractOcr(imageBase64, isPreProcessed);
      if (tesseractText) {
        aiLog.info('Order extract OCR pass (Tesseract)', { label, length: tesseractText.length });
      }
      return tesseractText;
    };

    // ── Build OCR variants: phone (vertical) + desktop (horizontal) + tablet crops ──
    // Detect if image is landscape (desktop/laptop), portrait (phone), or tablet-like
    let isLandscape = false;
    let isTablet = false;
    try {
      const orientBuf = getImageBuffer(payload.imageBase64);
      if (isRecognizedImageBuffer(orientBuf)) {
        const meta = await sharp(orientBuf).metadata();
        const w = meta.width ?? 0;
        const h = meta.height ?? 0;
        const ratio = w / Math.max(h, 1);
        isLandscape = ratio > 1;
        // Tablet: aspect ratio between 0.65 and 1.55 (covers both portrait and landscape tablet)
        isTablet = ratio > 0.65 && ratio < 1.55;
      }
    } catch { /* ignore — default to portrait */ }

    const allOcrVariants: Array<{ label: string; image: string }> = [];

    // Parallelize independence preprocessing calls for all base variants
    const [enhancedImg, highContrastImg, invertedImg] = await Promise.all([
      preprocessForOcr(payload.imageBase64),
      preprocessForOcr(payload.imageBase64, undefined, 'highContrast'),
      preprocessForOcr(payload.imageBase64, undefined, 'inverted'),
    ]);

    allOcrVariants.push(
      { label: 'original', image: payload.imageBase64 },
      { label: 'enhanced', image: enhancedImg },
      { label: 'high-contrast', image: highContrastImg },
      { label: 'inverted', image: invertedImg },
    );

    if (isTablet && !isLandscape) {
      // Tablet portrait (3:4 ish) — wider than phone but taller than desktop
      const tabVariants = await Promise.all([
        preprocessForOcr(payload.imageBase64, { left: 0.15, width: 0.7, top: 0.05, height: 0.5 }),
        preprocessForOcr(payload.imageBase64, { top: 0, height: 0.45 }),
        preprocessForOcr(payload.imageBase64, { top: 0.2, height: 0.5 }),
        preprocessForOcr(payload.imageBase64, { top: 0.45, height: 0.55 }),
        preprocessForOcr(payload.imageBase64, { left: 0.1, width: 0.8, top: 0.15, height: 0.45 }, 'highContrast'),
        preprocessForOcr(payload.imageBase64, { left: 0.35, width: 0.6, top: 0.05, height: 0.6 }),
      ]);
      allOcrVariants.push(
        { label: 'tab-center-70', image: tabVariants[0] },
        { label: 'tab-top-45', image: tabVariants[1] },
        { label: 'tab-middle-50', image: tabVariants[2] },
        { label: 'tab-bottom-50', image: tabVariants[3] },
        { label: 'tab-hc-center', image: tabVariants[4] },
        { label: 'tab-right-60', image: tabVariants[5] },
      );
    } else if (isTablet && isLandscape) {
      // Tablet landscape (4:3 ish) — shorter/wider than desktop monitor
      const tabLandVariants = await Promise.all([
        preprocessForOcr(payload.imageBase64, { left: 0.2, width: 0.6, top: 0.1, height: 0.7 }),
        preprocessForOcr(payload.imageBase64, { left: 0.4, width: 0.55, top: 0.05, height: 0.65 }),
        preprocessForOcr(payload.imageBase64, { left: 0.05, width: 0.5, top: 0.1, height: 0.6 }),
        preprocessForOcr(payload.imageBase64, { left: 0.15, width: 0.7, top: 0.2, height: 0.5 }, 'highContrast'),
      ]);
      allOcrVariants.push(
        { label: 'tab-land-center', image: tabLandVariants[0] },
        { label: 'tab-land-right', image: tabLandVariants[1] },
        { label: 'tab-land-left', image: tabLandVariants[2] },
        { label: 'tab-land-hc-mid', image: tabLandVariants[3] },
      );
    } else if (isLandscape) {
      // Desktop/laptop: order info is often in the center or right portion
      // Amazon desktop: order details occupy the center-right area
      const desktopVariants = await Promise.all([
        preprocessForOcr(payload.imageBase64, { left: 0.2, width: 0.6 }),
        preprocessForOcr(payload.imageBase64, { left: 0.5, width: 0.5 }),
        preprocessForOcr(payload.imageBase64, { left: 0, width: 0.5 }),
        preprocessForOcr(payload.imageBase64, { left: 0.15, width: 0.7, top: 0, height: 0.55 }),
        preprocessForOcr(payload.imageBase64, { left: 0.15, width: 0.7, top: 0.4, height: 0.6 }),
        preprocessForOcr(payload.imageBase64, { left: 0.25, width: 0.55, top: 0.05, height: 0.45 }),
        preprocessForOcr(payload.imageBase64, { left: 0.1, width: 0.8, top: 0.15, height: 0.35 }),
        preprocessForOcr(payload.imageBase64, { left: 0.4, width: 0.55, top: 0.1, height: 0.5 }, 'highContrast'),
      ]);
      allOcrVariants.push(
        { label: 'center-60', image: desktopVariants[0] },
        { label: 'right-50', image: desktopVariants[1] },
        { label: 'left-50', image: desktopVariants[2] },
        { label: 'center-top-half', image: desktopVariants[3] },
        { label: 'center-bottom-half', image: desktopVariants[4] },
        { label: 'order-details-block', image: desktopVariants[5] },
        { label: 'wide-center-strip', image: desktopVariants[6] },
        { label: 'hc-center-right', image: desktopVariants[7] },
      );
    } else {
      // Phone/portrait: order info is vertically distributed
      const phoneVariants = await Promise.all([
        preprocessForOcr(payload.imageBase64, { top: 0, height: 0.55 }),
        preprocessForOcr(payload.imageBase64, { top: 0, height: 0.35 }),
        preprocessForOcr(payload.imageBase64, { top: 0.2, height: 0.5 }),
        preprocessForOcr(payload.imageBase64, { top: 0.45, height: 0.55 }),
        preprocessForOcr(payload.imageBase64, { top: 0.1, height: 0.4 }),
        preprocessForOcr(payload.imageBase64, { top: 0.3, height: 0.4 }, 'highContrast'),
        preprocessForOcr(payload.imageBase64, { top: 0.55, height: 0.45 }, 'highContrast'),
      ]);
      allOcrVariants.push(
        { label: 'top-55', image: phoneVariants[0] },
        { label: 'top-35', image: phoneVariants[1] },
        { label: 'middle-50', image: phoneVariants[2] },
        { label: 'bottom-50', image: phoneVariants[3] },
        { label: 'product-area', image: phoneVariants[4] },
        { label: 'hc-middle', image: phoneVariants[5] },
        { label: 'hc-bottom', image: phoneVariants[6] },
      );
    }

    // When using Tesseract (no Gemini), use more variants for better coverage
    // Include all device-specific crops (phone: 7, base: 4 = 11 total; desktop/tablet: up to 12+)
    // Limit to 6 for Tesseract-only to stay within request timeout budgets (Render 30s limit)
    const ocrVariants = ai ? allOcrVariants : allOcrVariants.slice(0, 6);

    // ── GLOBAL EXTRACTION DEADLINE ──
    // Render free tier has a 30-second request timeout. We need to return PARTIAL results
    // before hitting that limit, rather than getting a 502 Gateway Timeout with NO results.
    // Budget: ~3s preprocessing already spent + 25s for OCR+AI = 28s total.
    // The client sends a warm-up ping first, so the server should already be awake.
    const EXTRACTION_DEADLINE = Date.now() + 25_000; // 25 seconds from now for OCR + AI work
    const isTimeUp = () => Date.now() >= EXTRACTION_DEADLINE;

    let ocrText = '';
    let ocrLabel = 'none';
    let deterministic: { orderId: string | null; amount: number | null; orderDate: string | null; soldBy: string | null; productName: string | null; notes: string[] } = {
      orderId: null,
      amount: null,
      orderDate: null,
      soldBy: null,
      productName: null,
      notes: [],
    };
    let bestScore = 0;
    // Accumulate results across OCR passes — one crop may find the ID, another the amount
    let accumulatedOrderId: string | null = null;
    let accumulatedOrderIdScore = 0;
    let accumulatedAmount: number | null = null;
    let accumulatedOrderDate: string | null = null;
    let accumulatedSoldBy: string | null = null;
    let accumulatedProductName: string | null = null;
    const allOcrTexts: string[] = [];

    if (env.AI_DEBUG_OCR) {
      const parsed = parseDataUrl(payload.imageBase64);
      aiLog.info('Order extract input', {
        mimeType: parsed.mimeType,
        imageChars: payload.imageBase64.length,
      });
    }

    // ── FAST PATH: Gemini direct vision extraction ──
    // When Gemini is available, try direct image-to-structured-data extraction FIRST.
    // This is a SINGLE API call that extracts all 5 fields from the raw image.
    // It avoids the expensive multi-variant OCR loop entirely for successful cases.
    // This is the #1 latency optimization — takes ~2-5s vs 20-60s for multi-crop OCR.
    let fastPathSuccess = false;
    if (ai && !isGeminiCircuitOpen()) {
      for (const model of GEMINI_MODEL_FALLBACKS.slice(0, 2)) {
        try {
          const directResult = await extractDirectFromImage(model, payload.imageBase64);
          if (!directResult) continue;
          const directOrderId = sanitizeOrderId(directResult.orderId);
          let directAmount = typeof directResult.amount === 'number' && Number.isFinite(directResult.amount) && directResult.amount > 0
            ? directResult.amount : null;
          const directConfidence = typeof directResult.confidenceScore === 'number'
            ? Math.max(0, Math.min(100, directResult.confidenceScore)) : 0;

          // ── FAST PATH AMOUNT VALIDATION ──
          // Even Gemini can return wrong numbers (pincodes, phone digits, order ID fragments).
          // Apply the same sanity checks here that the OCR path uses.
          if (directAmount && directOrderId) {
            const fpOrderDigits = directOrderId.replace(/[^0-9]/g, '');
            const fpAmtStr = String(Math.round(directAmount));
            // Reject if amount exactly matches an order ID segment
            const fpSegments = new Set<string>();
            if (fpOrderDigits.length >= 4) fpSegments.add(fpOrderDigits);
            for (const seg of directOrderId.split(/[\-\s]+/)) {
              const d = seg.replace(/[^0-9]/g, '');
              if (d.length >= 3) fpSegments.add(d);
            }
            if (fpSegments.has(fpAmtStr)) {
              aiLog.warn('Fast path amount matches order ID segment — rejected', { amount: directAmount, orderId: directOrderId });
              directAmount = null;
            }
            // 5+ digit substring of order ID
            else if (fpAmtStr.length >= 5 && fpOrderDigits.length >= 8 && fpOrderDigits.includes(fpAmtStr)) {
              aiLog.warn('Fast path amount is substring of order ID — rejected', { amount: directAmount });
              directAmount = null;
            }
          }
          if (directAmount) {
            const fpAmtStr = String(Math.round(directAmount));
            // Reject 6-digit pincodes (100000-999999, first digit 1-8)
            if (/^\d{6}$/.test(fpAmtStr) && directAmount >= 100000 && directAmount <= 999999) {
              const fd = parseInt(fpAmtStr[0], 10);
              if (fd >= 1 && fd <= 8 && directConfidence < 90) {
                aiLog.warn('Fast path amount looks like pincode — rejected', { amount: directAmount });
                directAmount = null;
              }
            }
            // Reject 10-digit phone numbers
            if (/^[6-9]\d{9}$/.test(fpAmtStr)) {
              aiLog.warn('Fast path amount is phone number — rejected', { amount: directAmount });
              directAmount = null;
            }
            // Reject unreasonably large (>500000)
            if (directAmount && directAmount > 500000) {
              aiLog.warn('Fast path amount > 500000 — rejected', { amount: directAmount });
              directAmount = null;
            }
          }

          // Accept fast path result if we got at least orderId AND amount with decent confidence
          if (directOrderId && directAmount && directConfidence >= 60) {
            accumulatedOrderId = directOrderId;
            accumulatedAmount = directAmount;
            accumulatedOrderDate = directResult.orderDate || null;
            // Clean sold-by from vision
            if (directResult.soldBy) {
              accumulatedSoldBy = directResult.soldBy
                .replace(/\s*\(\s*(Ask\s*Product\s*Question|Visit\s*(the\s*)?Store)[^)]*\)/gi, '')
                .replace(/\s*Ask\s*Product\s*Question\s*/gi, '')
                .replace(/\s*Visit\s*(the\s*)?Store\s*/gi, '')
                .replace(/\s{2,}/g, ' ').trim() || null;
            }
            if (directResult.productName && directResult.productName.length >= 5
              && !/https?:\/\/|Deliver\s*to|Hello[,\s]|Returns?\s/i.test(directResult.productName)) {
              accumulatedProductName = directResult.productName;
            }
            deterministic = {
              orderId: directOrderId,
              amount: directAmount,
              orderDate: accumulatedOrderDate,
              soldBy: accumulatedSoldBy,
              productName: accumulatedProductName,
              notes: ['Fast path: extracted via Gemini Vision direct.'],
            };
            bestScore = 2;
            ocrText = '[Gemini Vision direct extraction — no OCR text]';
            ocrLabel = 'gemini-vision-fast';
            fastPathSuccess = true;
            recordGeminiSuccess();
            aiLog.info('Order extract FAST PATH success', {
              model, orderId: directOrderId, amount: directAmount,
              confidence: directConfidence, productName: accumulatedProductName,
            });
            break;
          }
          // Partial result — save it but continue to OCR loop for more
          if (directOrderId) {
            accumulatedOrderId = directOrderId;
            accumulatedOrderIdScore = 15; // Vision-sourced, high trust
          }
          if (directAmount) accumulatedAmount = directAmount;
          if (directResult.orderDate) accumulatedOrderDate = directResult.orderDate;
          if (directResult.soldBy) {
            accumulatedSoldBy = directResult.soldBy
              .replace(/\s*\(\s*(Ask\s*Product\s*Question|Visit\s*(the\s*)?Store)[^)]*\)/gi, '')
              .replace(/\s{2,}/g, ' ').trim() || null;
          }
          if (directResult.productName && directResult.productName.length >= 5
            && !/https?:\/\/|Deliver\s*to|Hello[,\s]|Returns?\s/i.test(directResult.productName)) {
            accumulatedProductName = directResult.productName;
          }
          recordGeminiSuccess();
          aiLog.info('Order extract fast path partial', { model, orderId: directOrderId, amount: directAmount });
          break;
        } catch (err) {
          aiLog.warn('[Extract] Fast path model error', { model, error: err instanceof Error ? err.message : err });
          _lastError = err;
          continue;
        }
      }
    }

    // ── OCR VARIANT LOOP: Only needed when fast path didn't get both orderId + amount ──
    if (!fastPathSuccess) {
    for (const variant of ocrVariants) {
      // ── Global deadline check: stop processing more variants if time is running out ──
      if (isTimeUp()) {
        aiLog.warn('Global extraction deadline reached — stopping OCR variant loop.', {
          processedVariants: allOcrTexts.length,
          totalVariants: ocrVariants.length,
          hasOrderId: Boolean(accumulatedOrderId),
          hasAmount: Boolean(accumulatedAmount),
        });
        break;
      }
      const candidateText = await runOcrPass(variant.image, variant.label);
      if (!candidateText) continue;
      allOcrTexts.push(candidateText);
      const candidateDeterministic = runDeterministicExtraction(candidateText);

      // Accumulate best-scored order ID across all passes (not just first-found)
      if (candidateDeterministic.orderId) {
        const candidateIdScore = scoreOrderId(candidateDeterministic.orderId, { hasKeyword: true, occursInText: true });
        if (!accumulatedOrderId || candidateIdScore > accumulatedOrderIdScore) {
          accumulatedOrderId = candidateDeterministic.orderId;
          accumulatedOrderIdScore = candidateIdScore;
        }
      }
      // Accumulate best amount: prefer amounts from final-label lines over first-found
      if (candidateDeterministic.amount) {
        if (!accumulatedAmount) {
          accumulatedAmount = candidateDeterministic.amount;
        } else if (
          // Prefer the amount that's more likely correct:
          // If both are similar (within 10%), keep the first. Otherwise keep the one closer to typical range.
          Math.abs(candidateDeterministic.amount - accumulatedAmount) / accumulatedAmount > 0.1
        ) {
          // Keep the one that's in typical e-commerce range (₹50-₹50000)
          const currInRange = accumulatedAmount >= 50 && accumulatedAmount <= 50000;
          const newInRange = candidateDeterministic.amount >= 50 && candidateDeterministic.amount <= 50000;
          if (newInRange && !currInRange) {
            accumulatedAmount = candidateDeterministic.amount;
          }
        }
      }
      if (candidateDeterministic.orderDate && !accumulatedOrderDate) {
        accumulatedOrderDate = candidateDeterministic.orderDate;
      }
      if (candidateDeterministic.soldBy && !accumulatedSoldBy) {
        accumulatedSoldBy = candidateDeterministic.soldBy;
      }
      if (candidateDeterministic.productName) {
        // Score-based selection: prefer product names that look more like real product titles
        const scoreProductName = (name: string): number => {
          let s = 0;
          // Length bonus: descriptive product titles are typically 15-150 chars
          if (name.length >= 15 && name.length <= 150) s += 3;
          if (name.length >= 30) s += 2;
          // Product keyword bonus (comprehensive Indian e-commerce categories)
          if (/\b(phone|laptop|tablet|watch|earbuds?|headphone|speaker|shirt|shoe|bag|cream|oil|gel|powder|serum|shampoo|charger|cable|cover|case|book|pack|ml|gm|kg|ltr|pcs|combo|set|kit|box|saree|kurti|kurta|jeans|dress|sneaker|wallet|backpack|perfume|lotion|conditioner|lipstick|foundation|mascara|cleanser|toner|sunscreen|moisturizer|vitamin|protein|snack|tea|coffee|trimmer|dryer|iron|mixer|blender|cooker|bottle|flask|brush|razor|diaper|toy|game|puzzle|novel|pen|pencil|notebook|organizer|stand|holder|mount|adapter|powerbank|neckband|TWS|smartwatch|air\s*purifier|water\s*purifier|vacuum|mattress|pillow|bedsheet|curtain|towel|rug|carpet|cushion|fridge|microwave|fan|heater|led|bulb|camera|lens|tripod|projector|screen\s*guard|tempered\s*glass|stroller)\b/i.test(name)) s += 4;
          // Size/unit patterns: "250ml", "1kg", "(Pack of 2)"
          if (/\b\d+\s*(ml|gm|g|kg|ltr|l|oz|pcs|mah|wh|gb|tb|mb|pieces?|count|pack)\b/i.test(name)) s += 3;
          // Brand + product pattern: "Samsung Galaxy M12", "Avimee Herbal Hair Oil"
          if (/^[A-Z][a-z]+\s[A-Z]/.test(name)) s += 2;
          // Pipe separators common in e-commerce titles
          if (/[|]/.test(name)) s += 1;
          // Parenthetical info: "(Blue, 64GB)", "(Pack of 2)"
          if (/\([^)]{2,30}\)/.test(name)) s += 2;
          // Mixed-case text (product titles are mixed-case)
          if (/[A-Z]/.test(name) && /[a-z]/.test(name)) s += 1;
          // Penalize short names
          if (name.length < 10) s -= 2;
          // Penalize names that are just platform names + generic words
          if (/^(amazon|flipkart|myntra|meesho|ajio|nykaa|blinkit|zepto)\b/i.test(name) && name.split(/\s+/).length <= 2) s -= 5;
          return s;
        };
        if (!accumulatedProductName) {
          accumulatedProductName = candidateDeterministic.productName;
        } else {
          const newScore = scoreProductName(candidateDeterministic.productName);
          const oldScore = scoreProductName(accumulatedProductName);
          if (newScore > oldScore) {
            accumulatedProductName = candidateDeterministic.productName;
          }
        }
      }

      const score = (candidateDeterministic.orderId ? 1 : 0) + (candidateDeterministic.amount ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        ocrText = candidateText;
        ocrLabel = variant.label;
        deterministic = candidateDeterministic;
      }
      // Early exit if we have both from the same pass — only for Gemini (reliable OCR)
      // For Tesseract-only, continue scanning more variants for better quality results
      if (ai && score === 2) break;
      if (ai && accumulatedOrderId && accumulatedAmount) break;
      // Tesseract-only: still break if we found both AND have good text length
      if (!ai && accumulatedOrderId && accumulatedAmount && (ocrText?.length ?? 0) > 200) break;
      // Deadline-based early exit: if we have at least one field and time is running low, stop
      if (isTimeUp() && (accumulatedOrderId || accumulatedAmount)) break;
    }
    } // end if (!fastPathSuccess)

    // If individual passes found different pieces, merge them
    if (!deterministic.orderId && accumulatedOrderId) {
      deterministic.orderId = accumulatedOrderId;
      deterministic.notes.push('Order ID from alternate crop.');
    }
    if (!deterministic.amount && accumulatedAmount) {
      deterministic.amount = accumulatedAmount;
      deterministic.notes.push('Amount from alternate crop.');
    }
    if (!deterministic.orderDate && accumulatedOrderDate) {
      deterministic.orderDate = accumulatedOrderDate;
      deterministic.notes.push('Order date from alternate crop.');
    }
    if (!deterministic.soldBy && accumulatedSoldBy) {
      deterministic.soldBy = accumulatedSoldBy;
      deterministic.notes.push('Seller info from alternate crop.');
    }
    if (!deterministic.productName && accumulatedProductName) {
      deterministic.productName = accumulatedProductName;
      deterministic.notes.push('Product name from alternate crop.');
    }

    // Last resort: concatenate all OCR text and run deterministic extraction on the combined text
    if (!deterministic.orderId || !deterministic.amount) {
      const combinedText = allOcrTexts.join('\n');
      if (combinedText.length > (ocrText?.length ?? 0)) {
        const combined = runDeterministicExtraction(combinedText);
        if (!deterministic.orderId && combined.orderId) {
          deterministic.orderId = combined.orderId;
          deterministic.notes.push('Order ID from combined OCR text.');
        }
        if (!deterministic.amount && combined.amount) {
          deterministic.amount = combined.amount;
          deterministic.notes.push('Amount from combined OCR text.');
        }
        if (!deterministic.orderDate && combined.orderDate) {
          deterministic.orderDate = combined.orderDate;
          deterministic.notes.push('Order date from combined OCR text.');
        }
        if (!deterministic.soldBy && combined.soldBy) {
          deterministic.soldBy = combined.soldBy;
          deterministic.notes.push('Seller info from combined OCR text.');
        }
        if (!deterministic.productName && combined.productName) {
          deterministic.productName = combined.productName;
          deterministic.notes.push('Product name from combined OCR text.');
        }
        if (!ocrText) {
          ocrText = combinedText;
          ocrLabel = 'combined';
        }
      }
    }

    if (!ocrText) {
      aiLog.warn('Order extract OCR failed: empty OCR output.');
      return {
        orderId: null,
        amount: null,
        confidenceScore: 15,
        notes: 'OCR failed to read text. Please upload a clearer screenshot.',
      };
    }

    if (env.AI_DEBUG_OCR) {
      aiLog.info('Order extract OCR', {
        label: ocrLabel,
        length: ocrText.length,
        preview: ocrText.slice(0, 600),
      });
    }

    // deterministic already computed from the best OCR pass above
    const deterministicConfidence = deterministic.orderId && deterministic.amount ? 78 :
      deterministic.orderId || deterministic.amount ? 72 : 0;

    aiLog.info('Order extract deterministic', {
      orderId: deterministic.orderId,
      amount: deterministic.amount,
      confidence: deterministicConfidence,
    });

    let finalOrderId = deterministic.orderId;
    let finalAmount = deterministic.amount;
    let confidenceScore = deterministicConfidence;
    const notes: string[] = [...deterministic.notes];

    let finalOrderDate = deterministic.orderDate;
    let finalSoldBy = deterministic.soldBy;
    let finalProductName = deterministic.productName;
    let aiUsed = false;

    // ALWAYS run AI when available and circuit breaker is closed — for validation, gap-filling, and cross-checking
    if (ai && !isGeminiCircuitOpen() && !isTimeUp()) {
      // Step 1: Text-based refinement (cheap — sends OCR text only)
      for (const model of GEMINI_MODEL_FALLBACKS.slice(0, 3)) {
        if (isTimeUp()) break;
        try {
          // eslint-disable-next-line no-await-in-loop
          const aiResult = await refineWithAi(model, ocrText, deterministic);
          if (!aiResult) continue;

          const aiSuggestedOrderId = sanitizeOrderId(aiResult.suggestedOrderId);
          const aiSuggestedAmount =
            typeof aiResult.suggestedAmount === 'number' && Number.isFinite(aiResult.suggestedAmount)
              ? aiResult.suggestedAmount
              : null;
          const aiConfidence =
            typeof aiResult.confidenceScore === 'number' && Number.isFinite(aiResult.confidenceScore)
              ? Math.max(0, Math.min(100, Math.round(aiResult.confidenceScore)))
              : 0;

          // Relaxed validation: accept AI suggestions if visible in OCR text OR confidence >= 75
          const ocrNorm = ocrText.replace(/[\s\-]/g, '').toLowerCase();
          const orderIdVisible = aiSuggestedOrderId
            ? ocrText.toLowerCase().includes(aiSuggestedOrderId.toLowerCase()) ||
              ocrNorm.includes(aiSuggestedOrderId.replace(/[\s\-]/g, '').toLowerCase())
            : false;
          const amountVisible = aiSuggestedAmount
            ? ocrText.includes(String(aiSuggestedAmount)) ||
              ocrText.includes(aiSuggestedAmount.toFixed(2))
            : false;

          // Fill missing fields from AI
          // Guard: reject AI amount if it's a substring of Order ID digits
          const refOrderId = aiSuggestedOrderId || finalOrderId || deterministic.orderId;
          const isAmountFromOrderId = aiSuggestedAmount && refOrderId
            ? (() => {
                const digits = refOrderId.replace(/[^0-9]/g, '');
                const amtStr = String(Math.round(aiSuggestedAmount));
                return digits.length >= 8 && amtStr.length >= 3 && digits.includes(amtStr);
              })()
            : false;

          // Guard: reject AI product name if it looks like a URL or navigation garbage
          const isProductNameUrl = aiResult.suggestedProductName
            && /https?:\/\/|www\.|\.com\/|\.in\/|orderID=|order-details|ref=/i.test(aiResult.suggestedProductName);
          const isProductNameNavGarbage = aiResult.suggestedProductName
            && /^\s*(Deliver\s*to|Hello[,\s]|Returns?\s|Account|Sign\s*in|Cart|Buy\s*Again)/i.test(aiResult.suggestedProductName);

          if (!finalOrderId && aiSuggestedOrderId && (orderIdVisible || aiConfidence >= 75)) {
            finalOrderId = aiSuggestedOrderId;
            notes.push(orderIdVisible ? 'AI order ID confirmed in OCR text.' : 'AI extracted order ID (high confidence).');
          }
          if (!finalAmount && aiSuggestedAmount && !isAmountFromOrderId && (amountVisible || aiConfidence >= 75)) {
            finalAmount = aiSuggestedAmount;
            notes.push(amountVisible ? 'AI amount confirmed in OCR text.' : 'AI extracted amount (high confidence).');
          }

          // AI can correct deterministic if it disagrees AND AI value IS in OCR but deterministic is NOT
          if (finalOrderId && aiSuggestedOrderId && finalOrderId !== aiSuggestedOrderId && orderIdVisible && aiConfidence >= 80) {
            const detInText = ocrNorm.includes(finalOrderId.replace(/[\s\-]/g, '').toLowerCase());
            if (!detInText) {
              finalOrderId = aiSuggestedOrderId;
              notes.push('AI corrected order ID (deterministic not in OCR text).');
            }
          }

          // AI can correct a wrong deterministic amount (e.g., ₹ misread as digit 7)
          if (finalAmount && aiSuggestedAmount && !isAmountFromOrderId && finalAmount !== aiSuggestedAmount && aiConfidence >= 75) {
            const aiAmtStr = String(aiSuggestedAmount);
            const detAmtStr = String(finalAmount);
            // Case 1: Deterministic is ~10x AI value (₹ sign misread as leading digit)
            const ratio = finalAmount / aiSuggestedAmount;
            const isRupeeSignMisread = ratio >= 5 && ratio <= 20 && amountVisible;
            // Case 2: Deterministic value is a pincode (6-digit, starts 1-8)
            const detIsPincode = /^\d{6}$/.test(detAmtStr) && finalAmount >= 100000 && finalAmount <= 999999 && parseInt(detAmtStr[0]) >= 1 && parseInt(detAmtStr[0]) <= 8;
            // Case 3: Deterministic value is a phone number (10 digits starting 6-9)
            const detIsPhone = /^[6-9]\d{9}$/.test(detAmtStr) && finalAmount >= 6000000000;
            // Case 4: AI amount is visible in OCR text but deterministic is inflated
            const aiAmtInOcr = ocrNorm.includes(aiAmtStr) || ocrNorm.includes(aiAmtStr.replace('.', ''));
            if ((isRupeeSignMisread && aiAmtInOcr) || detIsPincode || detIsPhone) {
              finalAmount = aiSuggestedAmount;
              notes.push(`AI corrected amount: ₹${detAmtStr} → ₹${aiAmtStr} (${isRupeeSignMisread ? '₹ sign misread' : detIsPincode ? 'was pincode' : 'was phone'}).`);
            }
          }

          // Fill metadata from AI: orderDate, soldBy, productName
          if (!finalOrderDate && aiResult.suggestedOrderDate) {
            finalOrderDate = aiResult.suggestedOrderDate;
            notes.push('Order date from AI.');
          }
          if (aiResult.suggestedSoldBy) {
            // Clean up soldBy from AI
            const cleanedAiSoldBy = aiResult.suggestedSoldBy
              .replace(/\s*\(\s*(Ask\s*Product\s*Question|Visit\s*(the\s*)?Store|See\s*All|View\s*More|Follow|Contact|Report|Share)[^)]*\)/gi, '')
              .replace(/\s*Ask\s*Product\s*Question\s*/gi, '')
              .replace(/\s*Visit\s*(the\s*)?Store\s*/gi, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            if (!finalSoldBy && cleanedAiSoldBy.length >= 2) {
              finalSoldBy = cleanedAiSoldBy;
              notes.push('Seller from AI.');
            } else if (finalSoldBy && cleanedAiSoldBy.length >= 2 && aiConfidence >= 75) {
              // AI can correct OCR-garbled seller names
              const currentHasGarbage = /\b(Ask\s*Product|Visit\s*Store|Leave\s*seller|Track\s*package|Cancel\s*items|Write\s*a\s*review|Return\s*or\s*replace)\b/i.test(finalSoldBy);
              if (currentHasGarbage) {
                finalSoldBy = cleanedAiSoldBy;
                notes.push('AI corrected seller name (removed button text).');
              }
            }
          }
          if (!finalProductName && aiResult.suggestedProductName && !isProductNameUrl && !isProductNameNavGarbage) {
            finalProductName = aiResult.suggestedProductName;
            notes.push('Product name from AI.');
          }
          // AI can correct poor deterministic product name (expanded garbage detection)
          if (finalProductName && aiResult.suggestedProductName && !isProductNameUrl && !isProductNameNavGarbage && aiConfidence >= 70) {
            const currentIsGarbage = /\b(Deliver\s*to|Hello[,\s]|Returns?\s*(&|\d)|Account|Sign\s*in|Buy\s*Again|Explore\s*Plus|Search|Categories|Home|My\s*Orders?|Cart|Wishlist|Profile|Notifications?|Offers?)\b/i.test(finalProductName);
            // Also detect: name is just a color/size/quantity, too short (< 10 chars with low alpha), or looks like UI chrome
            const isTooShort = finalProductName.replace(/[^a-zA-Z]/g, '').length < 8;
            const isColorOrSize = /^(\s*(black|white|blue|red|green|pink|grey|gray|silver|gold|beige|brown|navy|purple|orange|yellow|maroon|\d+\s*(gb|tb|mb|ml|l|kg|g|mm|cm|m|xl|xxl|xxxl|s|xs))\s*[,\/]?\s*){1,3}$/i.test(finalProductName);
            const aiNameLonger = aiResult.suggestedProductName.length >= finalProductName.length * 1.5;
            if ((currentIsGarbage || isColorOrSize || (isTooShort && aiNameLonger)) && aiResult.suggestedProductName.length >= 10) {
              finalProductName = aiResult.suggestedProductName;
              notes.push('AI corrected product name (deterministic was low quality).');
            }
          }

          // Update confidence
          if (finalOrderId && finalAmount && deterministic.orderId && deterministic.amount) {
            confidenceScore = 92;
            notes.push('AI validated deterministic extraction.');
          } else if (finalOrderId && finalAmount) {
            confidenceScore = Math.max(confidenceScore, 80);
          } else if (finalOrderId || finalAmount) {
            confidenceScore = Math.max(confidenceScore, deterministicConfidence || 60);
          }

          if (aiResult.notes) notes.push(aiResult.notes);
          aiUsed = true;
          aiLog.info('Order extract AI refine', {
            suggestedOrderId: aiSuggestedOrderId,
            suggestedAmount: aiSuggestedAmount,
            confidence: aiConfidence,
          });
          break;
        } catch (innerError) {
          aiLog.warn('[Extract] Step 1 model fallback error', { error: innerError instanceof Error ? innerError.message : innerError });
          _lastError = innerError;
          continue;
        }
      }

      // Step 2: Direct image extraction — runs when ANY field is missing (not just ID/amount)
      // Gemini Vision understands screenshot layout far better than OCR text parsing
      // Skip if fast path already did direct vision extraction successfully
      if (!fastPathSuccess && !isTimeUp() && (!finalOrderId || !finalAmount || !finalProductName || !finalSoldBy || !finalOrderDate)) {
        for (const model of GEMINI_MODEL_FALLBACKS.slice(0, 2)) {
          if (isTimeUp()) break;
          try {
            // eslint-disable-next-line no-await-in-loop
            const directResult = await extractDirectFromImage(model, payload.imageBase64);
            if (!directResult) continue;

            const directOrderId = sanitizeOrderId(directResult.orderId);
            const directAmount =
              typeof directResult.amount === 'number' && Number.isFinite(directResult.amount)
                ? directResult.amount
                : null;
            const directConfidence =
              typeof directResult.confidenceScore === 'number'
                ? Math.max(0, Math.min(100, directResult.confidenceScore))
                : 0;

            if (!finalOrderId && directOrderId && directConfidence >= 60) {
              finalOrderId = directOrderId;
              notes.push('Order ID from direct image AI.');
            }

            // Guard: reject direct AI amount if it's a substring of order ID digits
            const directRefId = directOrderId || finalOrderId;
            const directAmountIsOrderIdFragment = directAmount && directRefId
              ? (() => {
                  const d = directRefId.replace(/[^0-9]/g, '');
                  const a = String(Math.round(directAmount));
                  return d.length >= 8 && a.length >= 3 && d.includes(a);
                })()
              : false;

            if (!finalAmount && directAmount && directAmount >= 10 && directConfidence >= 60 && !directAmountIsOrderIdFragment) {
              finalAmount = directAmount;
              notes.push('Amount from direct image AI.');
            }
            if (!finalOrderDate && directResult.orderDate) finalOrderDate = directResult.orderDate;
            // For soldBy from vision: trust it even if OCR found something (vision is more accurate)
            if (directResult.soldBy) {
              const cleanedSoldBy = directResult.soldBy
                .replace(/\s*\(\s*(Ask\s*Product\s*Question|Visit\s*(the\s*)?Store|See\s*All|View\s*More|Follow|Contact|Report|Share)[^)]*\)/gi, '')
                .replace(/\s*Ask\s*Product\s*Question\s*/gi, '')
                .replace(/\s*Visit\s*(the\s*)?Store\s*/gi, '')
                .replace(/\s*Write\s*a\s*product\s*review\s*/gi, '')
                .replace(/\s*Leave\s*(seller|delivery)\s*feedback\s*/gi, '')
                .replace(/\s*Return\s*or\s*replace\s*items?\s*/gi, '')
                .replace(/\s*Track\s*package\s*/gi, '')
                .replace(/\s*Buy\s*it\s*again\s*/gi, '')
                .replace(/\s*View\s*your\s*item\s*/gi, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
              if (cleanedSoldBy.length >= 2) {
                if (!finalSoldBy) {
                  finalSoldBy = cleanedSoldBy;
                } else if (directConfidence >= 70) {
                  finalSoldBy = cleanedSoldBy;
                  notes.push('Seller updated from direct image AI (higher accuracy).');
                }
              }
            }
            // Guard: reject direct AI product name if it looks like a URL or navigation text
            const directProductIsUrl = directResult.productName
              && /https?:\/\/|www\.|\.com\/|\.in\/|orderID=|order-details|ref=/i.test(directResult.productName);
            // Check for navigation chrome ANYWHERE in the string (not just start)
            // Screenshots show: ". Deliver to Sumit ) i . Hello, Ashok Retuns 0" or "5 Deliver to ABHILASH N Hello, ROOT Returns 0"
            const directProductIsNavCrap = directResult.productName && (() => {
              const pn = directResult.productName!;
              const navPatterns = [
                /Deliver\s*to\s/i, /Hello[,\s]/i, /Returns?\s*(&|\b0\b|\bOrder)/i,
                /Account\s*&/i, /Sign\s*in/i, /\bCart\b/i, /Buy\s*Again/i,
                /Explore\s*Plus/i, /My\s*Account/i, /Your\s*Orders?/i,
                /\bRetuns?\b/i,  // OCR misspelling of "Returns"
              ];
              const navHits = navPatterns.filter(p => p.test(pn)).length;
              if (navHits >= 2) return true;
              // Also catch leading garbage + nav pattern
              if (/^[\s\d.,;:!?)>•·\-]*\s*(Deliver\s*to|Hello[,\s]|Returns?\s|Account|Sign\s*in|Cart|Buy\s*Again)/i.test(pn)) return true;
              return false;
            })();
            if (directResult.productName && !directProductIsUrl && !directProductIsNavCrap) {
              // Strip known navigation chrome fragments from the product name before evaluating
              const cleanedProductName = directResult.productName
                .replace(/\b(Deliver\s*to\s+\w+[^.]*)/gi, '')
                .replace(/\b(Hello[,\s]+\w+[^.]*)/gi, '')
                .replace(/\b(Returns?\s*(&\s*Orders?|\b\d))/gi, '')
                .replace(/\b(Retuns?\s*\d)/gi, '')
                .replace(/\b(Sign\s*in|Account\s*&\s*Lists?|Your\s*Orders?|Buy\s*Again|Explore\s*Plus)/gi, '')
                .replace(/^[\s\-:•·|>).,;!?]+/, '')
                .replace(/[\s\-:•·|).,;!?]+$/, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
              if (cleanedProductName.length >= 5) {
                if (!finalProductName) {
                  finalProductName = cleanedProductName;
                } else if (directConfidence >= 70) {
                  // Vision result: prefer if longer, or if current name is short/low-quality
                  const currentAlpha = (finalProductName || '').replace(/[^a-zA-Z]/g, '').length;
                  const visionAlpha = cleanedProductName.replace(/[^a-zA-Z]/g, '').length;
                  if (cleanedProductName.length > (finalProductName?.length ?? 0) || (currentAlpha < 10 && visionAlpha >= 10)) {
                    finalProductName = cleanedProductName;
                    notes.push('Product name updated from direct image AI (higher accuracy).');
                  }
                }
              }
            }

            if (finalOrderId || finalAmount || directResult.productName || directResult.soldBy) {
              confidenceScore = Math.max(confidenceScore, directConfidence);
              aiUsed = true;
              aiLog.info('Order extract direct AI', {
                orderId: directOrderId,
                amount: directAmount,
                productName: directResult.productName,
                soldBy: directResult.soldBy,
                confidence: directConfidence,
              });
            }
            break;
          } catch (innerError) {
            aiLog.warn('[Extract] Step 2 model fallback error', { error: innerError instanceof Error ? innerError.message : innerError });
            _lastError = innerError;
            continue;
          }
        }
      }
    }

    if (!finalOrderId && !finalAmount) {
      confidenceScore = CONFIDENCE.FALLBACK_NONE;
      notes.push('Unable to extract order details.');
    } else if (!confidenceScore) {
      confidenceScore = 55;
    }

    // ─── POST-PROCESSING SANITY CHECKS ─── //

    // 1. If the amount EXACTLY matches a hyphen-separated segment of the order ID, reject it.
    //    For 5+ digit amounts, also reject if it's a contiguous substring of the full digit string.
    //    But do NOT reject 3-4 digit amounts merely because they appear somewhere in a 17-digit order ID
    //    — that would falsely reject common ₹1000-₹9999 prices.
    if (finalAmount && finalOrderId) {
      const orderDigits = finalOrderId.replace(/[^0-9]/g, '');
      const amountStr = String(Math.round(finalAmount));
      // Build exact segments (same logic as extractAmounts)
      const postSegments = new Set<string>();
      if (orderDigits.length >= 4) postSegments.add(orderDigits);
      for (const seg of finalOrderId.split(/[\-\s]+/)) {
        const d = seg.replace(/[^0-9]/g, '');
        if (d.length >= 3) postSegments.add(d);
      }
      // Exact segment match — always reject
      if (postSegments.has(amountStr)) {
        notes.push(`Amount ₹${finalAmount} exactly matches an Order ID segment — rejected.`);
        finalAmount = null;
        confidenceScore = Math.max(30, confidenceScore - 20);
      }
      // 5+ digit amounts that appear as substring of full order ID digits — reject
      else if (amountStr.length >= 5 && orderDigits.length >= 8 && orderDigits.includes(amountStr)) {
        notes.push(`Amount ₹${finalAmount} appears to be digits from Order ID — rejected.`);
        finalAmount = null;
        confidenceScore = Math.max(30, confidenceScore - 20);
      }
      // 3-digit amounts at the START of order ID (e.g. "408" from "408-xxx") — reject
      else if (amountStr.length === 3 && orderDigits.startsWith(amountStr)) {
        notes.push(`Amount ₹${finalAmount} matches start of Order ID — rejected.`);
        finalAmount = null;
        confidenceScore = Math.max(30, confidenceScore - 20);
      }
    }

    // 2. If the product name looks like a URL, clear it
    if (finalProductName && /https?:\/\/|www\.|\.com\/|\.in\/|orderID=|order-details|ref=|utm_/i.test(finalProductName)) {
      notes.push('Product name looked like a URL — rejected.');
      finalProductName = null;
    }

    // 3. If the product name is too short or pure non-alpha, clear it
    if (finalProductName) {
      const alphaOnly = finalProductName.replace(/[^a-zA-Z]/g, '');
      if (alphaOnly.length < 3) {
        finalProductName = null;
      }
    }

    // 4. If amount is unreasonably large (order ID-sized numbers), flag or reject
    // Raised threshold to ₹5,00,000 to accommodate premium electronics, jewelry, appliances.
    // Amounts above this are almost certainly OCR misreads of order ID fragments.
    if (finalAmount && finalAmount > 500000) {
      notes.push(`Amount ₹${finalAmount} seems unreasonably large — rejected.`);
      finalAmount = null;
      confidenceScore = Math.max(30, confidenceScore - 15);
    } else if (finalAmount && finalAmount > 200000) {
      notes.push(`Amount ₹${finalAmount} is high — flagged for manual review.`);
      confidenceScore = Math.max(50, confidenceScore - 10);
    }

    // 5. Reject product name if it's a delivery status line
    if (finalProductName && /^(arriving|shipped|delivered|dispatched|out\s*for|in\s*transit|order\s*(placed|confirmed|completed)|packed|picked\s*up)/i.test(finalProductName)) {
      notes.push('Product name was a delivery status — rejected.');
      finalProductName = null;
    }

    // 5b. Reject product name if it's a standalone status word
    if (finalProductName && /^(completed|pending|cancelled|processing|successful|approved|rejected|failed|accepted|verified)\s*$/i.test(finalProductName.trim())) {
      notes.push('Product name was a standalone status word — rejected.');
      finalProductName = null;
    }

    // 5c. Reject product name if it contains "shared this order" (Flipkart share feature)
    if (finalProductName && /shared\s*this\s*order/i.test(finalProductName)) {
      notes.push('Product name was a share notification — rejected.');
      finalProductName = null;
    }

    // 5d. Reject product name if it's UI chrome (chat, download, rate, etc.)
    if (finalProductName && /^(chat\s*with\s*us|see\s*all\s*updates?|download\s*invoice|rate\s*(your|the)\s*(experience|product)|how\s*do\s*i|return\s*window|payment\s*method|cash\s*on\s*delivery|stop\s*sharing)/i.test(finalProductName)) {
      notes.push('Product name was UI chrome — rejected.');
      finalProductName = null;
    }

    // 5e. Reject product name if it looks like a person name (2-4 proper-case words, < 40 chars)
    if (finalProductName) {
      const trimmedPN = finalProductName.trim();
      const pnWords = trimmedPN.split(/\s+/);
      if (pnWords.length >= 2 && pnWords.length <= 4 && trimmedPN.length < 40) {
        const allProperCase = pnWords.every(w =>
          /^[A-Z][a-z]+$/.test(w) || /^[A-Z]{1,5}$/.test(w) || /^[A-Z][a-z]+'s?$/.test(w)
        );
        if (allProperCase && !/\b(phone|laptop|tablet|watch|earbuds?|headphone|speaker|shirt|shoe|bag|cream|oil|powder|book|cable|charger|mouse|keyboard|camera|pack|set|kit|ml|gm|kg|combo|serum|lotion|perfume|brush|bottle|cover|case|stand|holder|adapter|usb|bluetooth|wireless|cotton|leather|steel|glass|trimmer|mixer|blender|cooker)\b/i.test(trimmedPN)) {
          notes.push('Product name looked like a person name — rejected.');
          finalProductName = null;
        }
      }
    }

    // 6. Reject product name if it's just generic text / navigation chrome
    if (finalProductName && /^(sign\s*in|log\s*in|sign\s*out|my\s*account|home|search|help|contact|cart|wish\s*list)/i.test(finalProductName)) {
      notes.push('Product name was navigation text — rejected.');
      finalProductName = null;
    }

    // 6b. Reject product name if it's a comma-separated category list (e.g., "Tablets, Earbuds, Watch, Blue")
    if (finalProductName) {
      const commaParts = finalProductName.split(/\s*,\s*/);
      if (commaParts.length >= 3 && commaParts.every(p => p.trim().split(/\s+/).length <= 2)) {
        notes.push('Product name was a category list — rejected.');
        finalProductName = null;
      }
    }

    // 6c. Reject product name if it's an address
    if (finalProductName && /\b(pincode|pin\s*code|zip)\s*[:\-]?\s*\d{5,6}\b/i.test(finalProductName)) {
      notes.push('Product name contained address/pincode — rejected.');
      finalProductName = null;
    }
    if (finalProductName && /\b(maharashtra|karnataka|tamil\s*nadu|delhi|mumbai|bangalore|chennai|hyderabad|kolkata|pune|jaipur|lucknow|ahmedabad|india)\b/i.test(finalProductName)) {
      const hasProductKeyword = /\b(phone|laptop|tablet|watch|earbuds?|headphone|speaker|shirt|shoe|bag|cream|oil|powder|book)\b/i.test(finalProductName);
      if (!hasProductKeyword) {
        notes.push('Product name looked like an address — rejected.');
        finalProductName = null;
      }
    }

    // 6d. Reject product name if it's just a platform/store name
    if (finalProductName && /^(amazon|flipkart|myntra|meesho|ajio|nykaa|tata\s*cliq|jiomart|snapdeal|bigbasket|blinkit|zepto|swiggy|croma|lenskart|pharmeasy|shopsy|purplle|1mg)\s*$/i.test(finalProductName.trim())) {
      notes.push('Product name was just a platform name — rejected.');
      finalProductName = null;
    }

    // 6e. Reject product name if it's a phone number pattern (10+ digits with optional separators)
    if (finalProductName && /^\+?\d[\d\s\-]{8,}\d$/.test(finalProductName.replace(/[()]/g, ''))) {
      notes.push('Product name looked like a phone number — rejected.');
      finalProductName = null;
    }

    // 6f. Reject product name if it looks like a tracking/AWB number
    if (finalProductName && /^(AWB|tracking|shipment|invoice|txn|utr|ref)\s*[:\-#]?\s*[A-Z0-9]{6,}/i.test(finalProductName)) {
      notes.push('Product name was a tracking/reference number — rejected.');
      finalProductName = null;
    }

    // 6g. Reject product name if it's just "Qty: N" or "Quantity: N"
    if (finalProductName && /^(qty|quantity)\s*[:\-]?\s*\d+$/i.test(finalProductName)) {
      notes.push('Product name was a quantity label — rejected.');
      finalProductName = null;
    }

    // 6h. Reject product name if it's a thank you/confirmation message
    if (finalProductName && /^(thank\s*you|order\s*(confirmed|placed|successful)|congrat|yay|hooray)/i.test(finalProductName)) {
      notes.push('Product name was a confirmation message — rejected.');
      finalProductName = null;
    }

    // 6i. Clean up product name: remove leading/trailing special chars, trim whitespace
    if (finalProductName) {
      finalProductName = finalProductName
        .replace(/^[\s\-:•·|>]+/, '')  // Remove leading dashes, colons, bullets
        .replace(/[\s\-:•·|]+$/, '')    // Remove trailing dashes, colons, bullets
        .replace(/\s{2,}/g, ' ')         // Collapse multiple spaces
        .trim();
      if (finalProductName.length < 3) {
        finalProductName = null;
      }
    }

    // 6j. Reject product name if it contains navigation chrome from Amazon/Flipkart header
    if (finalProductName) {
      const pn = finalProductName;
      const navPatterns = [
        /Deliver\s*to\s/i, /Hello[,\s]/i, /Returns?\s*(&|\b0\b|\bOrder)/i,
        /My\s*Account/i, /Sign\s*In/i, /Your\s*Orders?/i,
        /Explore\s*Plus/i, /Buy\s*Again/i, /\bRetuns?\b/i,
        /Account\s*&\s*Lists?/i, /\bCart\b.*\b\d/i,
      ];
      const navHits = navPatterns.filter(p => p.test(pn)).length;
      const hasProductKeyword = /\b(phone|laptop|tablet|watch|earbuds?|headphone|shirt|shoe|bag|cream|oil|gel|powder|serum|shampoo|charger|cable|cover|case|book|pack|ml|gm|kg|pcs|combo|set|kit|perfume|lotion|lipstick|foundation|vitamin|trimmer|bottle|brush|backpack|rucksack|sleeve|stand|mouse|keyboard|speaker|adapter|usb|hdmi|bluetooth|wireless|wired|cotton|polyester|denim|leather)\b/i.test(pn);
      if (navHits >= 2 && !hasProductKeyword) {
        notes.push('Product name contained multiple navigation chrome keywords — rejected.');
        finalProductName = null;
      } else if (navHits >= 1 && !hasProductKeyword) {
        // Single nav keyword: check if the product name is mostly garbage (low alpha ratio)
        const alphaChars = pn.replace(/[^a-zA-Z]/g, '').length;
        const alphaRatio = alphaChars / Math.max(pn.length, 1);
        if (alphaRatio < 0.6 || pn.length < 10) {
          notes.push('Product name contained navigation chrome with low quality text — rejected.');
          finalProductName = null;
        }
      }
    }

    // 6k. Reject product name if it looks like "Deliver to X" or "Hello, X" (even with leading garbage chars)
    if (finalProductName && /^[\s\d.,;:!?)>•·\-]*\s*(Deliver\s*to\s|Hello[,\s])/i.test(finalProductName)) {
      notes.push('Product name was address/greeting header — rejected.');
      finalProductName = null;
    }

    // 6l. Reject product name that is concatenated navigation fragments (e.g. "5 Deliver to ABHILASH N Hello, ROOT Returns 0")
    if (finalProductName) {
      const upper = finalProductName.toUpperCase();
      const hasDeliverTo = /DELIVER\s*TO/i.test(upper);
      const hasHello = /HELLO/i.test(upper);
      const hasReturns = /RETURN/i.test(upper);
      if (hasDeliverTo && (hasHello || hasReturns)) {
        notes.push('Product name was concatenated navigation fragments — rejected.');
        finalProductName = null;
      }
    }

    // 9. Clean up soldBy: strip common Amazon/Flipkart button text that OCR captured
    if (finalSoldBy) {
      finalSoldBy = finalSoldBy
        .replace(/\s*\(\s*(Ask\s*Product\s*Question|Visit\s*(the\s*)?Store|See\s*All|View\s*More|Follow|Contact|Report|Share)[^)]*\)/gi, '')
        .replace(/\s*Ask\s*Product\s*Question\s*/gi, '')
        .replace(/\s*Visit\s*(the\s*)?Store\s*/gi, '')
        .replace(/\s*Write\s*a\s*product\s*review\s*/gi, '')
        .replace(/\s*Leave\s*seller\s*feedback\s*/gi, '')
        .replace(/\s*Leave\s*delivery\s*feedback\s*/gi, '')
        .replace(/\s*Return\s*or\s*replace\s*items?\s*/gi, '')
        .replace(/\s*Track\s*package\s*/gi, '')
        .replace(/\s*Cancel\s*items?\s*/gi, '')
        .replace(/\s*Buy\s*it\s*again\s*/gi, '')
        .replace(/\s*View\s*your\s*item\s*/gi, '')
        .replace(/\s*Add\s*to\s*(Cart|Wish\s*List)\s*/gi, '')
        .replace(/\s*Share\s*this\s*product\s*/gi, '')
        .replace(/\s*Report\s*incorrect\s*product\s*info\w*\s*/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (finalSoldBy.length < 2) {
        finalSoldBy = null;
      }
    }

    // 6m. Reject amount if it matches common Indian pincode ranges (6-digit, 100000-999999)
    // Only reject if the amount is an exact integer matching a pincode pattern
    if (finalAmount && finalAmount >= 100000 && finalAmount <= 999999 && finalAmount === Math.round(finalAmount)) {
      // Check if this value appears in the OCR text near address/delivery context
      const amtStr = String(Math.round(finalAmount));
      const allText = (ocrText || '').toLowerCase();
      // If the exact number appears near address keywords, it's a pincode not an amount
      const pincodeCtxPattern = new RegExp(`(deliver|address|pin|zip|city|state|locality|area|sector|colony|nagar|plot|flat|floor|road|street|lane|near|opp|behind|dist|tehsil|taluk|mandal|ward|india|maharashtra|karnataka|tamil|delhi|mumbai|bangalore|pune|hyderabad|chennai|kolkata|jaipur|lucknow|ahmedabad|thane|navi\\s*mumbai|gurgaon|noida|ghaziabad|faridabad|chandigarh|bhopal|indore|nagpur|visakhapatnam|patna|vadodara|surat|rajkot|coimbatore|kochi|thiruvananthapuram).{0,80}${amtStr}|${amtStr}.{0,80}(deliver|address|pin|zip|city|state|locality|area|india|maharashtra|karnataka|tamil|delhi|mumbai|bangalore|pune)`, 'i');
      if (pincodeCtxPattern.test(allText)) {
        notes.push(`Amount ₹${finalAmount} appears near address context — likely a pincode, rejected.`);
        finalAmount = null;
        confidenceScore = Math.max(30, confidenceScore - 20);
      }
      // Also reject if no explicit "total"/"amount"/"paid" keyword near the number
      if (finalAmount) {
        const amtNearTotalPattern = new RegExp(`(total|amount|paid|payable|grand|you\\s*paid|order\\s*total|price).{0,30}${amtStr}|${amtStr}.{0,30}(total|amount|paid|payable|grand)`, 'i');
        if (!amtNearTotalPattern.test(allText) && /\b\d{6}\b/.test(allText)) {
          // There are 6-digit numbers in text and the amount isn't near any total keyword — suspicious
          // Check more aggressively: common Indian pincodes start with 1-8, and ranges like 110001-855117
          const firstDigit = parseInt(amtStr[0]);
          if (firstDigit >= 1 && firstDigit <= 8) {
            notes.push(`Amount ₹${finalAmount} is 6-digit (possible pincode) with no "total"/"paid" context — flagged.`);
            confidenceScore = Math.max(40, confidenceScore - 15);
          }
        }
      }
    }

    // 6n. Reject amount if it matches a 10-digit Indian phone number
    if (finalAmount && finalAmount >= 6000000000 && finalAmount <= 9999999999 && finalAmount === Math.round(finalAmount)) {
      notes.push(`Amount ₹${finalAmount} looks like a phone number (10-digit starting 6-9) — rejected.`);
      finalAmount = null;
      confidenceScore = Math.max(25, confidenceScore - 20);
    }

    // 7. If amount looks like a date (e.g. 20250206 = 2,02,50,206), reject
    if (finalAmount && finalAmount >= 10000000) {
      const amtStr = String(Math.round(finalAmount));
      if (/^20[2-3]\d[01]\d[0-3]\d$/.test(amtStr)) {
        notes.push(`Amount ₹${finalAmount} looks like a date — rejected.`);
        finalAmount = null;
        confidenceScore = Math.max(25, confidenceScore - 20);
      }
    }

    // 8. Cross-validate: if amount is exactly 0 after rounding, clear it
    if (finalAmount !== null && finalAmount <= 0) {
      finalAmount = null;
    }

    // 8b. Reject suspiciously low amounts (₹1-₹9) — usually convenience fees or COD charges
    if (finalAmount !== null && finalAmount > 0 && finalAmount < 10) {
      notes.push(`Amount ₹${finalAmount} is suspiciously low (< ₹10) — rejected.`);
      finalAmount = null;
      confidenceScore = Math.max(30, confidenceScore - 15);
    }

    // 8c. Deterministic ₹-as-digit correction (conservative, OCR-only mode)
    // Only apply when: (1) no AI was used, (2) the original amount does NOT appear near any
    // price label in OCR text, AND (3) the corrected amount DOES appear near a label.
    // This avoids false positives where "₹6,695" is a real price and gets wrongly corrected to 695.
    if (finalAmount && ocrText && !aiUsed) {
      const amtStr = String(Math.round(finalAmount));
      // Check if the ORIGINAL amount is visible near a price label — if so, it's correct
      const originalNearLabel = new RegExp(
        `(?:total|amount|paid|payable|grand|you\\s*pay|bill|price)\\s*:?\\s*(?:₹|rs\\.?|inr)?\\s*${amtStr.replace(/(\d)/g, '$1[,.]?')}`,
        'i'
      ).test(ocrText);
      if (!originalNearLabel) {
        const corrected = detectRupeeSignAsDigit(finalAmount, ocrText);
        if (corrected !== null) {
          notes.push(`Deterministic ₹-as-digit correction: ₹${finalAmount} → ₹${corrected} (leading digit was misread ₹ sign).`);
          finalAmount = corrected;
          confidenceScore = Math.max(confidenceScore, 70);
        }
      }
    }

    // 9. Normalize order date to a consistent format (DD Month YYYY)
    if (finalOrderDate) {
      try {
        const d = new Date(finalOrderDate);
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2015 && d.getFullYear() <= 2030) {
          const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
          finalOrderDate = `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
        } else {
          // Try manual dd/mm/yyyy parse
          const ddmmyyyy = finalOrderDate.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
          if (ddmmyyyy) {
            const day = parseInt(ddmmyyyy[1]);
            const mon = parseInt(ddmmyyyy[2]);
            const yr = parseInt(ddmmyyyy[3]);
            if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12 && yr >= 2015 && yr <= 2030) {
              const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
              finalOrderDate = `${String(day).padStart(2, '0')} ${months[mon - 1]} ${yr}`;
            }
          }
        }
      } catch { /* keep original */ }
    }

    aiLog.info('Order extract final', {
      orderId: finalOrderId,
      amount: finalAmount,
      orderDate: finalOrderDate,
      soldBy: finalSoldBy,
      productName: finalProductName,
      confidence: confidenceScore,
      aiUsed,
    });

    return {
      orderId: finalOrderId,
      amount: finalAmount,
      orderDate: finalOrderDate,
      soldBy: finalSoldBy,
      productName: finalProductName,
      confidenceScore,
      notes: notes.join(' '),
    };
  } catch (error) {
    aiLog.error('Order extraction error', { error });
    logErrorEvent({ error: error instanceof Error ? error : new Error(String(error)), message: 'AI order extraction failed', category: 'EXTERNAL_SERVICE', severity: 'medium', metadata: { handler: 'extractOrderDetailsWithAi' } });
    return {
      orderId: null,
      amount: null,
      orderDate: null,
      soldBy: null,
      productName: null,
      confidenceScore: 0,
      notes: `Extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
