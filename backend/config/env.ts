import { z } from 'zod';
import crypto from 'node:crypto';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  // Express body parser limits.
  // Use values supported by the `bytes` package syntax (e.g. '1mb', '500kb').
  // 12mb accommodates base64-encoded proof images (~10MB raw → ~13.3MB base64).
  REQUEST_BODY_LIMIT: z.string().trim().min(1).default('12mb'),

  // PostgreSQL — primary and only database via Prisma.
  // Required in production. Optional in dev/test where mocks or env files supply it.
  DATABASE_URL: z.string().min(1).optional(),

  // Server tuning
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(5000).default(30_000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).default(30_000),

  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_REFRESH_SECRET: z.string().optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),

  CORS_ORIGINS: z.string().default(''),

  GEMINI_API_KEY: z.string().optional(),

  // Google Sheets export (service account key JSON, base64-encoded)
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),

  // Google OAuth (for user-level Sheets export to their own Drive)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  // AI safety + cost controls
  // z.coerce.boolean() treats 'false' as truthy — use a manual transform
  AI_ENABLED: z.string().default('true').transform(v => v !== 'false' && v !== '0' && v !== ''),
  AI_CHAT_RPM_AUTH: z.coerce.number().int().positive().default(30),
  AI_CHAT_RPM_ANON: z.coerce.number().int().positive().default(6),
  AI_PROOF_RPM_AUTH: z.coerce.number().int().positive().default(10),
  AI_PROOF_RPM_ANON: z.coerce.number().int().positive().default(2),
  AI_EXTRACT_RPM_AUTH: z.coerce.number().int().positive().default(10),
  AI_EXTRACT_RPM_ANON: z.coerce.number().int().positive().default(2),
  AI_DAILY_LIMIT_AUTH: z.coerce.number().int().positive().default(200),
  AI_DAILY_LIMIT_ANON: z.coerce.number().int().positive().default(40),
  AI_MAX_OUTPUT_TOKENS_CHAT: z.coerce.number().int().positive().default(512),
  AI_MAX_OUTPUT_TOKENS_PROOF: z.coerce.number().int().positive().default(256),
  AI_MAX_OUTPUT_TOKENS_EXTRACT: z.coerce.number().int().positive().default(4096),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(4000),
  AI_MAX_IMAGE_CHARS: z.coerce.number().int().positive().default(20_000_000),
  AI_MAX_ESTIMATED_TOKENS: z.coerce.number().int().positive().default(20000),
  AI_MAX_HISTORY_MESSAGES: z.coerce.number().int().positive().default(6),
  AI_HISTORY_SUMMARY_CHARS: z.coerce.number().int().positive().default(400),
  AI_MIN_SECONDS_BETWEEN_CALLS: z.coerce.number().int().nonnegative().default(3),
  AI_DEBUG_OCR: z.string().default('false').transform(v => v !== 'false' && v !== '0' && v !== ''),
  AI_OCR_POOL_SIZE: z.coerce.number().int().min(1).max(8).default(2),
  AI_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(3),
  AI_CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(300_000),

  // Minimum AI confidence score (0-100) required for proof verification to pass.
  // Scores below this threshold will reject the proof. 70 is recommended for production
  // anti-fraud gating; lower values increase false-positive risk.
  AI_PROOF_CONFIDENCE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(70),

  // AI confidence score (0-100) at or above which a proof step is auto-verified
  // without manual mediator review.  Set to 101 to disable auto-verification.
  // 80 balances speed and fraud safety; more proofs auto-verify without mediator.
  AI_AUTO_VERIFY_THRESHOLD: z.coerce.number().int().min(0).max(101).default(80),

  // Confidence score assigned to review links from recognized marketplace domains.
  // URL validation acts as the "AI" for review proofs — no screenshot analysis needed.
  AI_REVIEW_LINK_CONFIDENCE: z.coerce.number().int().min(0).max(100).default(95),

  // Cooling period (days) before an approved order can be settled.
  // 14 days provides chargeback protection for marketplace purchases.
  COOLING_PERIOD_DAYS: z.coerce.number().int().min(1).max(90).default(14),

  // Maximum number of times a rejected order can be re-submitted for proof.
  MAX_REPROOF_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // Wallet safety limits
  WALLET_MAX_BALANCE_PAISE: z.coerce.number().int().positive().default(1_00_00_000), // ₹1,00,000

  // Web push (VAPID)
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

type EnvSchema = z.infer<typeof envSchema>;

export type Env = Omit<EnvSchema, 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'> & {
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
};

export function loadEnv(processEnv: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(processEnv);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${message}`);
  }

  const env = parsed.data as any as Env;

  const looksPlaceholder = (value: string | undefined) => {
    if (!value) return true;
    const v = value.trim();
    if (!v) return true;
    if (v.includes('REPLACE_ME')) return true;
    if (v.startsWith('<') && v.endsWith('>')) return true;
    return false;
  };

  const ensureSecret = (
    name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET',
    value: string | undefined
  ) => {
    if (env.NODE_ENV === 'production') {
      if (!value || value.length < 32 || looksPlaceholder(value)) {
        throw new Error(
          `Invalid environment configuration:\n${name}: must be set to a secure random string (>= 32 chars) in production for HMAC-SHA256 safety`
        );
      }
      return value;
    }
    // In dev/test, prefer stability over strength: if a value is provided and isn't a placeholder,
    // use it as-is (even if short) so JWT sessions remain valid across restarts.
    if (value && !looksPlaceholder(value)) return value;
    return crypto.randomBytes(32).toString('hex');
  };

  env.JWT_ACCESS_SECRET = ensureSecret('JWT_ACCESS_SECRET', processEnv.JWT_ACCESS_SECRET);
  env.JWT_REFRESH_SECRET = ensureSecret('JWT_REFRESH_SECRET', processEnv.JWT_REFRESH_SECRET);

  // Production safety: do not default to "allow all origins".
  // The API is consumed by multiple portals, so an explicit allowlist should always be configured.
  if (env.NODE_ENV === 'production') {
    if (!env.DATABASE_URL) {
      throw new Error(
        'Invalid environment configuration:\nDATABASE_URL: must be set in production — the application cannot start without a database'
      );
    }

    const cors = parseCorsOrigins(env.CORS_ORIGINS);
    if (!cors.length) {
      throw new Error(
        'Invalid environment configuration:\nCORS_ORIGINS: must be set to a comma-separated list of allowed origins/hosts in production'
      );
    }
  }

  return env;
}

export function parseCorsOrigins(raw: string): string[] {
  const stripOuterQuotes = (value: string) => {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1).trim();
    }
    return v;
  };

  const normalizeEntry = (value: string): string | null => {
    let v = stripOuterQuotes(value);
    if (!v) return null;

    // Remove obvious trailing slashes early.
    v = v.replace(/\/+$/, '');
    if (!v) return null;

    // If it looks like a concrete URL (no wildcard), normalize it to origin-only.
    // This makes configs like "https://example.com/" or "https://example.com/api" safe.
    if ((v.startsWith('http://') || v.startsWith('https://')) && !v.includes('*')) {
      try {
        const url = new URL(v);
        return `${url.protocol}//${url.host}`;
      } catch {
        // Fall through to the more permissive normalization below.
      }
    }

    // For wildcard/hostname forms, strip any accidental path segment.
    // Examples:
    // - moboadmin.vercel.app/ -> moboadmin.vercel.app
    // - .vercel.app/ -> .vercel.app
    const slashIdx = v.indexOf('/');
    if (slashIdx !== -1) v = v.slice(0, slashIdx);

    v = v.replace(/\/+$/, '').trim();
    return v || null;
  };

  return raw
    .split(',')
    .map((s) => normalizeEntry(s))
    .filter((s): s is string => Boolean(s));
}
