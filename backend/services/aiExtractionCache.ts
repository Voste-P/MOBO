/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AI EXTRACTION CACHE SERVICE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Purpose: Prevent repeated Gemini API calls for the same order proof image
 *
 * Cache Storage:
 * ───────────────────────────────────────────────────────────────────────────────
 * Uses the existing Order.verification JSONB column with structure:
 *   {
 *     orderAiExtraction: { ...result, extractedAt: ISO },
 *     paymentAiExtraction: { ... },
 *     reviewAiExtraction: { ... },
 *     ratingAiExtraction: { ... },
 *     returnWindowAiExtraction: { ... },
 *     ... (other verification data)
 *   }
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from '../database/prisma.js';
import { extractOrderDetailsWithAi, verifyProofWithAi, verifyRatingScreenshotWithAi } from './aiService.js';
import type { Env } from '../config/env.js';
import { aiLog } from '../config/logger.js';

type ProofType = 'order' | 'payment' | 'review' | 'rating' | 'returnWindow';

/** Safely read the verification JSON as an object. */
function parseVerification(v: any): Record<string, any> {
  if (!v) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

/**
 * Get cached AI extraction for a proof type, or extract if not cached.
 */
export async function getOrExtractProof(params: {
  orderId: string;
  proofType: ProofType;
  imageBase64: string;
  expectedOrderId?: string;
  expectedAmount?: number;
  expectedBuyerName?: string;
  expectedProductName?: string;
  expectedReviewerName?: string;
  env: Env;
  forceReExtract?: boolean;
}): Promise<any> {
  const {
    orderId,
    proofType,
    imageBase64,
    expectedOrderId,
    expectedAmount,
    expectedBuyerName,
    expectedProductName,
    expectedReviewerName,
    env,
    forceReExtract = false,
  } = params;

  const cacheKey = `${proofType}AiExtraction`;

  // Check cache first (unless forced)
  if (!forceReExtract) {
    const order = await prisma().order.findFirst({
      where: { id: orderId },
      select: { verification: true },
    });

    const veri = parseVerification(order?.verification);
    if (veri[cacheKey]) {
      const cached = veri[cacheKey];
      const extractedAt = cached.extractedAt ?? null;

      aiLog.info(`AI extraction cache HIT for order ${orderId} proof ${proofType}`, {
        extractedAt,
        ageMinutes: extractedAt ? Math.round((Date.now() - new Date(extractedAt).getTime()) / 60000) : null,
      });

      return { ...cached, cached: true, extractedAt };
    }

    aiLog.info(`AI extraction cache MISS for order ${orderId} proof ${proofType} - calling Gemini`);
  } else {
    aiLog.info(`AI extraction FORCED for order ${orderId} proof ${proofType} - bypassing cache`);
  }

  // Cache miss or forced — extract from AI
  let extraction: any;
  const startTime = Date.now();

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 200;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      switch (proofType) {
        case 'order':
        case 'payment':
          if (!expectedOrderId || expectedAmount === undefined) {
            throw new Error('Order/payment proof requires expectedOrderId and expectedAmount');
          }
          extraction = await verifyProofWithAi(env, { imageBase64, expectedOrderId, expectedAmount });
          break;

        case 'review':
          if (!expectedOrderId) {
            throw new Error('Review proof requires expectedOrderId');
          }
          extraction = await extractOrderDetailsWithAi(env, { imageBase64 });
          break;

        case 'rating':
          if (!expectedBuyerName || !expectedProductName) {
            throw new Error('Rating proof requires expectedBuyerName and expectedProductName');
          }
          extraction = await verifyRatingScreenshotWithAi(env, {
            imageBase64,
            expectedBuyerName,
            expectedProductName,
            expectedReviewerName,
          });
          break;

        case 'returnWindow':
          extraction = await extractOrderDetailsWithAi(env, { imageBase64 });
          break;

        default:
          throw new Error(`Unknown proof type: ${proofType}`);
      }
      break; // Success — exit retry loop
    } catch (error) {
      // Don't retry validation errors (programmer mistakes), only transient AI failures
      if (error instanceof Error && error.message.includes('requires expected')) throw error;
      if (error instanceof Error && error.message.includes('Unknown proof type')) throw error;

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 200, 400, 800ms
        aiLog.warn(`AI extraction attempt ${attempt}/${MAX_RETRIES} failed for order ${orderId} proof ${proofType}, retrying in ${delay}ms`, { error });
        await new Promise(r => setTimeout(r, delay));
      } else {
        aiLog.error(`AI extraction failed after ${MAX_RETRIES} attempts for order ${orderId} proof ${proofType}`, { error });
        throw error;
      }
    }
  }

  const duration = Date.now() - startTime;
  const now = new Date().toISOString();

  // Merge into existing verification JSONB
  const existing = await prisma().order.findFirst({
    where: { id: orderId },
    select: { verification: true },
  });
  const veri = parseVerification(existing?.verification);
  veri[cacheKey] = { ...extraction, extractedAt: now };

  await prisma().order.update({
    where: { id: orderId },
    data: { verification: veri as any },
  });

  aiLog.info(`AI extraction completed and cached for order ${orderId} proof ${proofType}`, {
    duration,
    confidence: extraction?.confidence,
    verified: extraction?.verified,
  });

  return { ...extraction, cached: false, extractedAt: now };
}

/**
 * Clear cache for a specific proof (used when user uploads new screenshot)
 */
export async function clearProofCache(orderId: string, proofType: ProofType): Promise<void> {
  const cacheKey = `${proofType}AiExtraction`;

  const existing = await prisma().order.findFirst({
    where: { id: orderId },
    select: { verification: true },
  });
  const veri = parseVerification(existing?.verification);
  delete veri[cacheKey];

  await prisma().order.update({
    where: { id: orderId },
    data: { verification: veri as any },
  });

  aiLog.info(`AI extraction cache cleared for order ${orderId} proof ${proofType}`);
}

/**
 * Get extraction status for all proofs of an order (used by UI to show progress)
 */
export async function getExtractionStatus(orderId: string): Promise<{
  order: { extracted: boolean; at: string | null };
  payment: { extracted: boolean; at: string | null };
  review: { extracted: boolean; at: string | null };
  rating: { extracted: boolean; at: string | null };
  returnWindow: { extracted: boolean; at: string | null };
}> {
  const row = await prisma().order.findFirst({
    where: { id: orderId },
    select: { verification: true },
  });

  if (!row) {
    throw new Error(`Order ${orderId} not found`);
  }

  const veri = parseVerification(row.verification);

  const status = (key: string) => ({
    extracted: !!veri[`${key}AiExtraction`],
    at: veri[`${key}AiExtraction`]?.extractedAt ?? null,
  });

  return {
    order: status('order'),
    payment: status('payment'),
    review: status('review'),
    rating: status('rating'),
    returnWindow: status('returnWindow'),
  };
}

/**
 * Estimate cost savings from caching (for analytics)
 */
export async function getCostSavings(days: number = 30): Promise<{
  totalExtractions: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  estimatedSavingsUSD: number;
}> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // This is a simplified estimate
  // In production, track cache hits/misses with proper counters
  const orders = await prisma().order.count({
    where: {
      createdAt: { gte: cutoff },
    },
  });

  // Estimated: avg 3 proof types per order, avg 5 views per proof
  const avgProofsPerOrder = 3;
  const avgViewsPerProof = 5;
  const totalExtractions = orders * avgProofsPerOrder;
  const totalViews = orders * avgProofsPerOrder * avgViewsPerProof;
  const cacheHits = totalViews - totalExtractions;
  const cacheMisses = totalExtractions;

  // Gemini API cost ~ $0.001 per image analysis (conservative estimate)
  const costPerExtraction = 0.001;
  const estimatedSavingsUSD = cacheHits * costPerExtraction;

  return {
    totalExtractions,
    cacheHits,
    cacheMisses,
    cacheHitRate: totalViews > 0 ? (cacheHits / totalViews) * 100 : 0,
    estimatedSavingsUSD,
  };
}

/**
 * Batch pre-warm cache for orders (useful after backfill or for high-priority orders)
 */
export async function preWarmCache(params: {
  orderIds: string[];
  proofTypes: ProofType[];
  env: Env;
}): Promise<{ success: number; failed: number; skipped: number }> {
  const { orderIds, proofTypes, env } = params;
  
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const orderId of orderIds) {
    for (const proofType of proofTypes) {
      try {
        const screenshotKey = `screenshot${proofType.charAt(0).toUpperCase() + proofType.slice(1)}` as any;
        const order = await prisma().order.findFirst({
          where: { id: orderId },
          select: { [screenshotKey]: true, verification: true } as any,
        });

        const screenshot = (order as any)?.[screenshotKey];
        if (!screenshot) {
          skipped++;
          continue;
        }

        // Check if already cached
        const cacheKey = `${proofType}AiExtraction`;
        const veri = parseVerification((order as any)?.verification);
        if (veri[cacheKey]) {
          skipped++;
          continue;
        }

        await getOrExtractProof({
          orderId,
          proofType,
          imageBase64: screenshot,
          expectedOrderId: orderId,
          expectedAmount: 0,
          env,
        });

        success++;
      } catch (error) {
        failed++;
        aiLog.error(`Pre-warm cache failed for order ${orderId} proof ${proofType}`, { error });
      }
    }
  }

  return { success, failed, skipped };
}
