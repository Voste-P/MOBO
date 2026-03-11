import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import type { Env } from '../config/env.js';
import {
  checkGeminiApiKey,
  extractOrderDetailsWithAi,
  generateChatUiResponse,
  isGeminiConfigured,
  verifyProofWithAi,
  verifyRatingScreenshotWithAi,
} from '../services/aiService.js';
import { toUiDeal } from '../utils/uiMappers.js';
import { normalizeMediatorCode } from '../utils/mediatorCode.js';
import { prisma, isPrismaAvailable } from '../database/prisma.js';
import { optionalAuth, requireAuth, requireRoles } from '../middleware/auth.js';
import { writeAuditLog } from '../services/audit.js';
import { logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { businessLog } from '../config/logger.js';

export function aiRoutes(env: Env): Router {
  const router = Router();

  const maxMessageChars = Math.round(env.AI_MAX_INPUT_CHARS * 1.2);
  const maxHistoryChars = Math.round(env.AI_MAX_INPUT_CHARS * 1.5);

  const chatSchema = z.object({
    message: z.string().max(maxMessageChars).default(''),
    // Legacy UI fields (ignored server-side unless no auth is present)
    userId: z.string().optional(),
    userName: z.string().max(120).default('Guest'),
    products: z.array(z.object({
      id: z.string().max(200).optional(),
      title: z.string().max(500).optional(),
      price: z.number().finite().optional(),
      originalPrice: z.number().finite().optional(),
      platform: z.string().max(100).optional(),
      description: z.string().max(2000).optional(),
      brandName: z.string().max(200).optional(),
      image: z.string().max(5000).optional(),
    }).passthrough()).max(200).optional(),
    orders: z.array(z.object({
      id: z.string().max(200).optional(),
      externalOrderId: z.string().max(200).optional(),
      status: z.string().max(100).optional(),
      paymentStatus: z.string().max(100).optional(),
      affiliateStatus: z.string().max(100).optional(),
    }).passthrough()).max(200).optional(),
    tickets: z.array(z.object({
      id: z.string().max(200).optional(),
      status: z.string().max(100).optional(),
      issueType: z.string().max(200).optional(),
    }).passthrough()).max(200).optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(maxHistoryChars),
        })
      )
      .max(20)
      .optional(),
    // data URL / base64; overall request size is also capped by express.json({limit:'10mb'})
    image: z.string().max(env.AI_MAX_IMAGE_CHARS).optional(),
  });

  const proofSchema = z.object({
    imageBase64: z.string().min(1).max(env.AI_MAX_IMAGE_CHARS),
    expectedOrderId: z.string().min(1),
    expectedAmount: z.number().finite().positive(),
  });

  const extractOrderSchema = z.object({
    imageBase64: z.string().min(1).max(env.AI_MAX_IMAGE_CHARS),
  });

  const verifyRatingSchema = z.object({
    imageBase64: z.string().min(1).max(env.AI_MAX_IMAGE_CHARS),
    expectedBuyerName: z.string().min(1).max(200),
    expectedProductName: z.string().min(1).max(500),
    expectedReviewerName: z.string().max(200).optional(),
    orderId: z.string().max(200).optional(),
  });

  // Optional auth so the UI can call AI routes without sending a token,
  // but if a token is provided we can trust user identity from DB.
  router.use(optionalAuth(env));

  // Tighten AI abuse surface beyond the global app limiter.
  // - Authenticated users get a higher quota.
  // - Unauthenticated requests are heavily throttled.
  const limiterChat = rateLimit({
    windowMs: 60_000,
    limit: (req) => {
      return req.auth?.userId ? env.AI_CHAT_RPM_AUTH : env.AI_CHAT_RPM_ANON;
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.userId || req.ip || 'unknown'),
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
      });
    },
  });

  const limiterVerifyProof = rateLimit({
    windowMs: 60_000,
    limit: (req) => {
      return req.auth?.userId ? env.AI_PROOF_RPM_AUTH : env.AI_PROOF_RPM_ANON;
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.userId || req.ip || 'unknown'),
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
      });
    },
  });

  const limiterExtractOrder = rateLimit({
    windowMs: 60_000,
    limit: (req) => {
      return req.auth?.userId ? env.AI_EXTRACT_RPM_AUTH : env.AI_EXTRACT_RPM_ANON;
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.auth?.userId || req.ip || 'unknown'),
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
      });
    },
  });

  // ⚠ DEPLOYMENT NOTE: These rate-limit Maps live in process memory.
  // They reset on restart and are per-instance in multi-worker deployments.
  // For production with multiple instances, replace with Redis-backed
  // stores (e.g. `rate-limit-redis`) to share counters across workers.
  const dailyUsage = new Map<string, { day: string; count: number }>();
  const lastCallAt = new Map<string, number>();

  // Periodically purge stale entries so the Maps don't grow without bound.
  const PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const purgeStaleEntries = () => {
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, value] of dailyUsage) {
      if (value.day !== today) dailyUsage.delete(key);
    }
    for (const [key, ts] of lastCallAt) {
      if (ts < cutoff) lastCallAt.delete(key);
    }
  };
  setInterval(purgeStaleEntries, PURGE_INTERVAL_MS).unref();

  const ensureAiEnabled = (res: any): boolean => {
    if (env.AI_ENABLED) return true;
    res.status(503).json({
      error: { code: 'AI_DISABLED', message: 'AI features are currently unavailable.' },
    });
    return false;
  };

  const enforceDailyLimit = (req: any, res: any): boolean => {
    if (env.NODE_ENV !== 'production') return true;
    const day = new Date().toISOString().slice(0, 10);
    const subject = String(req.auth?.userId || req.ip || 'unknown');
    const key = `${day}:${subject}`;
    const limit = req.auth?.userId ? env.AI_DAILY_LIMIT_AUTH : env.AI_DAILY_LIMIT_ANON;

    if (!Number.isFinite(limit) || limit <= 0) {
      res.set('Retry-After', '3600');
      res.status(429).json({
        error: { code: 'DAILY_LIMIT_REACHED', message: 'You have reached the daily limit. Please try again tomorrow.' },
      });
      return false;
    }

    const existing = dailyUsage.get(key);
    if (!existing || existing.day !== day) {
      dailyUsage.set(key, { day, count: 1 });
      return true;
    }

    if (existing.count >= limit) {
      res.set('Retry-After', '3600');
      res.status(429).json({
        error: { code: 'DAILY_LIMIT_REACHED', message: 'You have reached the daily limit. Please try again tomorrow.' },
      });
      return false;
    }

    existing.count += 1;
    return true;
  };

  const enforceMinInterval = (req: any, res: any): boolean => {
    if (env.NODE_ENV !== 'production') return true;
    if (!env.AI_MIN_SECONDS_BETWEEN_CALLS) return true;
    const subject = String(req.auth?.userId || req.ip || 'unknown');
    const now = Date.now();
    const last = lastCallAt.get(subject) || 0;
    if (now - last < env.AI_MIN_SECONDS_BETWEEN_CALLS * 1000) {
      const retryInSeconds = Math.ceil(env.AI_MIN_SECONDS_BETWEEN_CALLS - (now - last) / 1000);
      res.set('Retry-After', String(Math.max(retryInSeconds, 1)));
      res.status(429).json({
        error: { code: 'TOO_FREQUENT', message: 'Please wait a few seconds before trying again.' },
      });
      return false;
    }
    lastCallAt.set(subject, now);
    return true;
  };
  const sendKnownError = (err: unknown, res: any): boolean => {
    if (err instanceof z.ZodError) {
      res
        .status(400)
        .json({
          error: { code: 'BAD_REQUEST', message: 'Please check your input and try again.', details: err.issues },
        });
      return true;
    }
    const anyErr = err as any;
    if (anyErr && typeof anyErr.statusCode === 'number') {
      const statusCode = anyErr.statusCode;
      const message = String(anyErr.message || 'Something went wrong with AI analysis.');
      const code =
        statusCode === 400
          ? 'BAD_REQUEST'
          : message.toLowerCase().includes('disabled')
            ? 'AI_DISABLED'
            : 'AI_NOT_CONFIGURED';
      res
        .status(statusCode)
        .json({
          error: {
            code,
            message,
          },
        });
      return true;
    }
    return false;
  };

  router.post('/chat', limiterChat, async (req, res, next) => {
    try {
      if (!ensureAiEnabled(res)) return;
      if (!enforceDailyLimit(req, res)) return;
      if (!enforceMinInterval(req, res)) return;
      const payload = chatSchema.parse(req.body);
      if (!isGeminiConfigured(env)) {
        res.status(503).json({
          error: { code: 'AI_NOT_CONFIGURED', message: 'AI chat is not available right now.' },
        });
        return;
      }

      let effectiveProducts: any[] = Array.isArray(payload.products) ? payload.products : [];

      // Log AI chat access for ALL code paths (intent-based + AI-generated)
      logAccessEvent('RESOURCE_ACCESS', {
        userId: req.auth?.userId,
        roles: req.auth?.roles,
        ip: req.ip,
        resource: 'AI',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'AI_CHAT', messageLength: String(payload.message || '').length },
      });
      if (!Array.isArray(effectiveProducts) || effectiveProducts.length === 0) {
        const requester = req.auth?.user;
        const roles = req.auth?.roles ?? [];
        if (requester && roles.includes('shopper')) {
          const mediatorCode = normalizeMediatorCode((requester as any).parentCode);
          if (mediatorCode) {
            let deals: any[] = [];
            // Primary: PostgreSQL via Prisma
            if (isPrismaAvailable()) {
              const db = prisma();
              const pgDeals = await db.deal.findMany({
                where: {
                  mediatorCode: { equals: mediatorCode, mode: 'insensitive' },
                  active: true,
                  isDeleted: false,
                },
                orderBy: { createdAt: 'desc' },
                take: 50,
              });
              deals = pgDeals;
            }
            effectiveProducts = deals.map(d => toUiDeal(d));
          }
        }
      }
      if (!Array.isArray(effectiveProducts)) {
        effectiveProducts = [];
      }

      // Zero-trust identity: never trust userId/userName from the client if auth is present.
      const authUser = req.auth?.user;
      // Sanitize userName to prevent prompt injection via system prompt interpolation
      const rawUserName = authUser ? String((authUser as any)?.name || 'User') : payload.userName;
      const effectiveUserName = rawUserName.replace(/[\n\r\t]/g, ' ').replace(/[{}\[\]<>]/g, '').slice(0, 60).trim() || 'Guest';

      const slimProducts = Array.isArray(effectiveProducts)
        ? effectiveProducts.slice(0, 25).map((p: any) => ({
            id: p?.id,
            title: String(p?.title || '').slice(0, 120),
            price: Number(p?.price ?? 0),
            originalPrice: Number(p?.originalPrice ?? p?.price ?? 0),
            platform: String(p?.platform || '').slice(0, 40),
          }))
        : [];

      const slimOrders = Array.isArray(payload.orders)
        ? payload.orders.slice(0, 10).map((o: any) => ({
            id: o?.id,
            externalOrderId: o?.externalOrderId,
            status: o?.status,
            paymentStatus: o?.paymentStatus,
            affiliateStatus: o?.affiliateStatus,
          }))
        : [];

      const slimTickets = Array.isArray(payload.tickets)
        ? payload.tickets.slice(0, 10).map((t: any) => ({
            id: t?.id,
            status: t?.status,
            issueType: t?.issueType,
          }))
        : [];

      const rawMessage = String(payload.message || '').trim();
      const normalizedMessage = rawMessage.toLowerCase();
      const hasProducts = Array.isArray(effectiveProducts) && effectiveProducts.length > 0;
      const hasOrders = Array.isArray(payload.orders) && payload.orders.length > 0;
      const hasTickets = Array.isArray(payload.tickets) && payload.tickets.length > 0;
      const normalizeStatus = (value: unknown) => String(value || '').trim();
      const extractCount = () => {
        const topMatch = normalizedMessage.match(/top\s+(\d{1,2})/i);
        if (topMatch?.[1]) return Math.max(1, Math.min(50, Number(topMatch[1])));
        const countMatch = normalizedMessage.match(/(\d{1,2})\s+deals/i);
        if (countMatch?.[1]) return Math.max(1, Math.min(50, Number(countMatch[1])));
        return null;
      };

      if (hasProducts) {
        const count = extractCount();
        const wantsAll = normalizedMessage.includes('all deals') || normalizedMessage.includes('all available deals');
        const wantsLoot = normalizedMessage.includes('deals');
        const wantsLowest = normalizedMessage.includes('lowest') || normalizedMessage.includes('cheapest');
        const wantsSpecific =
          normalizedMessage.includes('show') ||
          normalizedMessage.includes('find') ||
          normalizedMessage.includes('show me');

        if (wantsAll) {
          res.json({
            text: 'Here are all available deals right now.',
            intent: 'search_deals',
            uiType: 'product_card',
            data: effectiveProducts.slice(0, 50),
          });
          return;
        }

        if (wantsSpecific && rawMessage.length > 6) {
          const tokens = normalizedMessage
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((t) => t.length > 3);

          let best: any = null;
          let bestScore = 0;
          for (const product of effectiveProducts) {
            const title = String(product?.title || '').toLowerCase();
            if (!title) continue;
            let score = 0;
            for (const t of tokens) {
              if (title.includes(t)) score += 1;
            }
            if (tokens.length && title.includes(tokens.join(' '))) score += 3;
            if (score > bestScore) {
              bestScore = score;
              best = product;
            }
          }

          if (best && bestScore >= 2) {
            res.json({
              text: 'Here is the deal you asked for.',
              intent: 'search_deals',
              uiType: 'product_card',
              data: [best],
            });
            return;
          }
        }

        if (wantsLowest) {
          const sorted = [...effectiveProducts].sort((a: any, b: any) => {
            const aPrice = Number(a?.price ?? a?.originalPrice ?? 0);
            const bPrice = Number(b?.price ?? b?.originalPrice ?? 0);
            return aPrice - bPrice;
          });
          const take = count ?? 1;
          res.json({
            text: take === 1 ? 'Here is the lowest priced deal.' : `Here are the lowest ${take} deals.`,
            intent: 'search_deals',
            uiType: 'product_card',
            data: sorted.slice(0, take),
          });
          return;
        }

        if (wantsLoot) {
          const take = count ?? 5;
          res.json({
            text: `Here are the top ${take} deals for you.`,
            intent: 'search_deals',
            uiType: 'product_card',
            data: effectiveProducts.slice(0, take),
          });
          return;
        }
      } else if (normalizedMessage.includes('deal') || normalizedMessage.includes('loot')) {
        res.json({
          text: 'I could not find any active deals for your mediator right now.',
          intent: 'search_deals',
        });
        return;
      }

      const wantsSystem =
        normalizedMessage.includes('what is') ||
        normalizedMessage.includes('explain') ||
        normalizedMessage.includes('how it works') ||
        normalizedMessage.includes('system');

      if (wantsSystem) {
        res.json({
          text:
            'BUZZMA connects buyers to mediator‑published deals. You can explore deals, place orders, submit proofs, and track cashback. Ask me about **deals**, **orders**, or **tickets** anytime.',
          intent: 'unknown',
        });
        return;
      }

      if (normalizedMessage.includes('order') || normalizedMessage.includes('cashback')) {
        if (hasOrders) {
          const latest = (payload.orders ?? [])[0] as any;
          const status = normalizeStatus(latest?.status) || 'Pending';
          const payment = normalizeStatus(latest?.paymentStatus) || 'Pending';
          const affiliate = normalizeStatus(latest?.affiliateStatus) || 'Unchecked';
          res.json({
            text: `Your latest order is **${status}**. Payment: **${payment}**, Affiliate: **${affiliate}**.`,
            intent: 'check_order_status',
          });
          return;
        }
        res.json({
          text: 'I could not find any orders yet. Want to explore deals?',
          intent: 'check_order_status',
        });
        return;
      }

      if (normalizedMessage.includes('ticket') || normalizedMessage.includes('support')) {
        if (hasTickets) {
          // Filter out Feedback entries — only show actual support tickets
          const supportTickets = (payload.tickets ?? []).filter((t: any) => t?.issueType !== 'Feedback');
          const latest = supportTickets[0] as any;
          if (latest) {
            const status = normalizeStatus(latest?.status) || 'Open';
            const issue = normalizeStatus(latest?.issueType) || 'Support';
            res.json({
              text: `Your latest ticket (**${issue}**) is **${status}**.`,
              intent: 'check_ticket_status',
            });
            return;
          }
        }
        res.json({
          text: 'No tickets found. You can create one from the Tickets tab.',
          intent: 'check_ticket_status',
        });
        return;
      }

      if (normalizedMessage.includes('profile') || normalizedMessage.includes('wallet')) {
        res.json({
          text: 'Opening your **Profile & Wallet**.',
          intent: 'navigation',
          navigateTo: 'profile',
        });
        return;
      }

      if (normalizedMessage.includes('explore') || normalizedMessage.includes('home')) {
        res.json({
          text: 'Taking you to **Explore Deals**.',
          intent: 'navigation',
          navigateTo: normalizedMessage.includes('home') ? 'home' : 'explore',
        });
        return;
      }

      const result = await generateChatUiResponse(env, {
        message: payload.message,
        userName: effectiveUserName,
        products: slimProducts,
        orders: slimOrders,
        tickets: slimTickets,
        image: payload.image,
        history: payload.history,
      });

      businessLog.info(`[AI] User ${req.auth?.userId || 'anonymous'} chat — intent: ${result?.intent || 'unknown'}, msgLen: ${rawMessage.length}`, { actorUserId: req.auth?.userId || 'anonymous', intent: result?.intent, messageLength: rawMessage.length, ip: req.ip });

      // Audit log the AI chat interaction
      writeAuditLog({
        req,
        actorUserId: req.auth?.userId,
        actorRoles: req.auth?.roles,
        action: 'AI_CHAT',
        entityType: 'ai',
        entityId: req.auth?.userId || 'anonymous',
        metadata: { intent: result?.intent, messageLength: rawMessage.length },
      });

      logAccessEvent('RESOURCE_ACCESS', {
        userId: req.auth?.userId,
        roles: req.auth?.roles,
        ip: req.ip,
        resource: 'AI_CHAT',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'AI_CHAT', intent: result?.intent, messageLength: rawMessage.length },
      });

      res.json(result);
    } catch (err) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'EXTERNAL_SERVICE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ai/chat' } });
      if (!sendKnownError(err, res)) next(err);
    }
  });

  // Lightweight config status (does not validate the key).
  router.get('/status', (_req, res) => {
    logAccessEvent('RESOURCE_ACCESS', {
      ip: _req.ip,
      resource: 'AI',
      metadata: { action: 'AI_STATUS' },
    });
    res.json({ configured: isGeminiConfigured(env) });
  });

  // Validates whether the configured GEMINI_API_KEY can successfully call Gemini.
  // Protected to avoid turning this into a free public proxy.
  router.post('/check-key', requireAuth(env), requireRoles('admin', 'ops'), async (_req, res, next) => {
    try {
      if (!ensureAiEnabled(res)) return;
      const result = await checkGeminiApiKey(env);
      businessLog.info(`[Admin] User ${_req.auth?.userId} validated AI API key — ok: ${result.ok}`, { actorUserId: _req.auth?.userId, ok: result.ok, ip: _req.ip });
      logAccessEvent('ADMIN_ACTION', {
        userId: _req.auth?.userId,
        roles: _req.auth?.roles,
        ip: _req.ip,
        resource: 'AI',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'AI_KEY_CHECK', ok: result.ok },
      });
      res.status(result.ok ? 200 : 503).json(result);
    } catch (err) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'EXTERNAL_SERVICE', severity: 'medium', userId: _req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ai/check-key' } });
      if (!sendKnownError(err, res)) next(err);
    }
  });

  router.post('/verify-proof', requireAuth(env), limiterVerifyProof, async (req, res, next) => {
    try {
      if (!ensureAiEnabled(res)) return;
      const payload = proofSchema.parse(req.body);

      // E2E runs should be deterministic and must not depend on external AI quotas.
      if (env.NODE_ENV === 'test') {
        res.json({
          orderIdMatch: true,
          amountMatch: true,
          confidenceScore: 95,
          detectedOrderId: payload.expectedOrderId,
          detectedAmount: payload.expectedAmount,
          discrepancyNote: 'Test mode: AI verification bypassed.',
        });
        return;
      }

      if (!isGeminiConfigured(env)) {
        res.status(503).json({
          error: { code: 'AI_NOT_CONFIGURED', message: 'AI analysis is not available right now.' },
        });
        return;
      }

      if (!enforceDailyLimit(req, res)) return;
      if (!enforceMinInterval(req, res)) return;

      const result = await verifyProofWithAi(env, payload);

      // Audit trail: record AI proof verification for backtracking
      writeAuditLog({
        req,
        action: 'ai.verify_proof',
        entityType: 'order_proof',
        metadata: {
          expectedOrderId: payload.expectedOrderId,
          expectedAmount: payload.expectedAmount,
          orderIdMatch: result.orderIdMatch,
          amountMatch: result.amountMatch,
          confidenceScore: result.confidenceScore,
          detectedOrderId: result.detectedOrderId,
          detectedAmount: result.detectedAmount,
          discrepancyNote: result.discrepancyNote,
        },
      });

      businessLog.info(`[AI] User ${req.auth?.userId} verified proof — orderId match: ${result.orderIdMatch}, amount match: ${result.amountMatch}, confidence: ${result.confidenceScore}`, { actorUserId: req.auth?.userId, expectedOrderId: payload.expectedOrderId, orderIdMatch: result.orderIdMatch, amountMatch: result.amountMatch, confidence: result.confidenceScore, ip: req.ip });
      logAccessEvent('RESOURCE_ACCESS', {
        userId: req.auth?.userId,
        roles: req.auth?.roles,
        ip: req.ip,
        resource: 'AI_VERIFY_PROOF',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'AI_VERIFY_PROOF', expectedOrderId: payload.expectedOrderId, orderIdMatch: result.orderIdMatch, amountMatch: result.amountMatch, confidenceScore: result.confidenceScore },
      });

      res.json(result);
    } catch (err) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'EXTERNAL_SERVICE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ai/verify-proof' } });
      if (!sendKnownError(err, res)) next(err);
    }
  });

  // Client-side rating screenshot pre-validation: buyer sees match/mismatch before submitting
  router.post('/verify-rating', requireAuth(env), limiterVerifyProof, async (req, res, next) => {
    try {
      if (!ensureAiEnabled(res)) return;
      const payload = verifyRatingSchema.parse(req.body);

      if (!enforceDailyLimit(req, res)) return;
      if (!enforceMinInterval(req, res)) return;

      // E2E deterministic bypass
      if (env.NODE_ENV === 'test') {
        res.json({
          accountNameMatch: true,
          productNameMatch: true,
          confidenceScore: 95,
          detectedAccountName: payload.expectedBuyerName,
          detectedProductName: payload.expectedProductName,
          discrepancyNote: 'Test mode: AI verification bypassed.',
        });
        return;
      }

      // If expectedReviewerName not provided but orderId is, look up the stored reviewer name
      let reviewerName = payload.expectedReviewerName;
      if (!reviewerName && payload.orderId && isPrismaAvailable()) {
        const order = await prisma().order.findFirst({
          where: { OR: [{ id: payload.orderId }, { mongoId: payload.orderId }], isDeleted: false },
          select: { reviewerName: true },
        });
        if (order?.reviewerName) reviewerName = order.reviewerName;
      }

      // Pass buyer's app account name as expectedBuyerName (secondary), and the
      // marketplace reviewer name as expectedReviewerName (PRIMARY match target).
      // The AI service matches PRIMARILY against expectedReviewerName when provided.
      const result = await verifyRatingScreenshotWithAi(env, {
        imageBase64: payload.imageBase64,
        expectedBuyerName: payload.expectedBuyerName,
        expectedProductName: payload.expectedProductName,
        ...(reviewerName ? { expectedReviewerName: reviewerName } : {}),
      });

      writeAuditLog({
        req,
        action: 'ai.verify_rating_preview',
        entityType: 'rating_verification',
        metadata: {
          accountNameMatch: result.accountNameMatch,
          productNameMatch: result.productNameMatch,
          confidenceScore: result.confidenceScore,
          detectedAccountName: result.detectedAccountName,
          detectedProductName: result.detectedProductName,
        },
      });

      businessLog.info(`[AI] User ${req.auth?.userId} verified rating screenshot — account match: ${result.accountNameMatch}, product match: ${result.productNameMatch}, confidence: ${result.confidenceScore}`, { actorUserId: req.auth?.userId, accountNameMatch: result.accountNameMatch, productNameMatch: result.productNameMatch, confidence: result.confidenceScore, ip: req.ip });
      logAccessEvent('RESOURCE_ACCESS', {
        userId: req.auth?.userId,
        roles: req.auth?.roles,
        ip: req.ip,
        resource: 'AI_VERIFY_RATING',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'AI_VERIFY_RATING', accountNameMatch: result.accountNameMatch, productNameMatch: result.productNameMatch, confidenceScore: result.confidenceScore },
      });

      res.json(result);
    } catch (err) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'EXTERNAL_SERVICE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ai/verify-rating' } });
      if (!sendKnownError(err, res)) next(err);
    }
  });

  router.post('/extract-order', requireAuth(env), limiterExtractOrder, async (req, res, _next) => {
    try {
      // NOTE: Do NOT check ensureAiEnabled here — Tesseract.js works locally
      // without Gemini API key, so extraction should always be available.
      const payload = extractOrderSchema.parse(req.body);

      if (!enforceDailyLimit(req, res)) return;
      if (!enforceMinInterval(req, res)) return;

      // extractOrderDetailsWithAi now works without Gemini via Tesseract.js
      // fallback, so we no longer need to bypass in E2E or non-Gemini mode.
      let result: any;
      try {
        result = await extractOrderDetailsWithAi(env, { imageBase64: payload.imageBase64 });
      } catch (extractErr) {
        // GRACEFUL DEGRADATION: Never return 500 for extraction failures.
        // Return an empty result so the client-side can let user fill in details manually.
        const errMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
        businessLog.warn(`[AI] Extraction pipeline error for user ${req.auth?.userId}: ${errMsg}`, {
          actorUserId: req.auth?.userId,
          error: errMsg,
          ip: req.ip,
        });
        result = {
          orderId: null,
          amount: null,
          orderDate: null,
          soldBy: null,
          productName: null,
          confidenceScore: 0,
          notes: `Extraction encountered an issue: ${errMsg.slice(0, 200)}. Please enter details manually.`,
        };
      }

      // Audit trail: record AI order extraction for backtracking
      writeAuditLog({
        req,
        action: 'ai.extract_order',
        entityType: 'order_extraction',
        metadata: {
          orderId: result.orderId,
          amount: result.amount,
          orderDate: result.orderDate,
          soldBy: result.soldBy,
          productName: result.productName,
          confidenceScore: result.confidenceScore,
        },
      });

      businessLog.info(`[AI] User ${req.auth?.userId} extracted order details — orderId: ${result.orderId}, amount: ${result.amount}, confidence: ${result.confidenceScore}`, { actorUserId: req.auth?.userId, detectedOrderId: result.orderId, detectedAmount: result.amount, confidence: result.confidenceScore, ip: req.ip });
      logAccessEvent('RESOURCE_ACCESS', {
        userId: req.auth?.userId,
        roles: req.auth?.roles,
        ip: req.ip,
        resource: 'AI_EXTRACT_ORDER',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'AI_EXTRACT_ORDER', orderId: result.orderId, confidenceScore: result.confidenceScore },
      });

      res.json(result);
    } catch (err) {
      // Only ZodError (bad request) or rate limit errors will reach here.
      // Extraction errors are caught above and returned as graceful empty results.
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'EXTERNAL_SERVICE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'ai/extract-order' } });
      if (!sendKnownError(err, res)) {
        // Last resort: still return a graceful empty result instead of 500
        res.json({
          orderId: null,
          amount: null,
          orderDate: null,
          soldBy: null,
          productName: null,
          confidenceScore: 0,
          notes: 'An unexpected error occurred. Please enter your order details manually.',
        });
      }
    }
  });

  return router;
}
