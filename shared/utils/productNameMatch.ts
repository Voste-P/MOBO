/**
 * Strict product name matching — 100% forward ratio required.
 *
 * All words extracted from the screenshot must exist in the expected deal
 * product name.  This prevents a different product from the same brand
 * (e.g. "Avimee Herbal Scalptone") from matching a deal for another product
 * (e.g. "Avimee Herbal Keshpallav Hair Oil").
 *
 * Shared across Orders page, ProductCard inline form, and QuickOrderModal.
 */

// Expanded noise words aligned with backend PRODUCT_STOP_WORDS
const NOISE_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'not', 'are', 'was',
  'has', 'its', 'all', 'can', 'you', 'our', 'new', 'buy', 'get', 'set',
  'pack', 'pcs', 'free', 'best', 'top', 'good', 'great', 'nice', 'off',
  'upto', 'only', 'just', 'also', 'more', 'very', 'most', 'save', 'deal',
  'per', 'via', 'too', 'any', 'use', 'how', 'may', 'now', 'old', 'own',
  'put', 'run', 'two', 'end', 'big', 'day', 'box', 'kit', 'men', 'man',
  'women', 'woman', 'long', 'lasting', 'item', 'size', 'pair', 'home',
  'made', 'full', 'high', 'low', 'white', 'black', 'red', 'blue', 'pink',
  'gold', 'silver', 'natural', 'pure', 'premium', 'original', 'genuine',
  'quality', 'gift', 'type', 'style', 'brand', 'product', 'online', 'india',
  'combo', 'super', 'ultra', 'pro', 'plus', 'lite', 'mini', 'max', 'extra',
]);

function cleanWords(text: string): string[] {
  const all = Array.from(new Set(
    text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2),
  ));
  const filtered = all.filter((w) => w.length >= 3 && !NOISE_WORDS.has(w));
  return filtered.length > 0 ? filtered : all;
}

function editDist(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function wordMatch(a: string, b: string): boolean {
  return (
    a === b ||
    (a.length >= 4 && b.includes(a)) ||
    (b.length >= 4 && a.includes(b)) ||
    (a.length >= 5 && b.length >= 5 && editDist(a, b) <= 1)
  );
}

export type ProductNameMatchStatus = 'match' | 'mismatch' | 'none';

/**
 * Compare an extracted product name (from a screenshot) against the expected
 * deal product title.  Returns 'match', 'mismatch', or 'none' (when
 * either name is empty).
 */
export function checkProductNameMatch(
  extractedProductName: string | undefined | null,
  expectedProductTitle: string | undefined | null,
): ProductNameMatchStatus {
  const extractedName = (typeof extractedProductName === 'string' ? extractedProductName : '').toLowerCase().trim();
  const expectedName = (typeof expectedProductTitle === 'string' ? expectedProductTitle : '').toLowerCase().trim();

  if (!extractedName || !expectedName) return 'none';

  // Filter out URLs and navigation chrome from extracted product name
  const isUrl = /https?:\/\/|www\.|\.com\/|\.in\/|orderID=|order-details|ref=|utm_/i.test(extractedName);
  const isDeliveryStatus = /^(arriving|shipped|delivered|dispatched|out\s*for\s*delivery|in\s*transit|order\s*(placed|confirmed))/i.test(extractedName);
  if (isUrl || isDeliveryStatus) return 'mismatch';

  const extractedWords = cleanWords(extractedName);
  const expectedWords = cleanWords(expectedName);

  // Forward: ALL extracted words must exist in expected (100%)
  const fwdMatches = extractedWords.filter((w) => expectedWords.some((ew) => wordMatch(w, ew)));
  // Reverse: expected words found in extracted
  const revMatches = expectedWords.filter((ew) => extractedWords.some((w) => wordMatch(ew, w)));

  const fwdRatio = extractedWords.length > 0 ? fwdMatches.length / extractedWords.length : 0;
  const revRatio = expectedWords.length > 0 ? revMatches.length / expectedWords.length : 0;

  // RULE 1: ALL extracted words must exist in expected (100%)
  const fwdPass = fwdMatches.length >= 2 && fwdRatio >= 1.0;

  // RULE 2: Dynamic reverse threshold based on expected name length
  const revThreshold = expectedWords.length <= 6 ? 1.0 : 0.5;
  const revPass = revMatches.length >= Math.min(2, expectedWords.length) && revRatio >= revThreshold;

  const hasEnoughOverlap = fwdPass && revPass;
  const shortNameMatch = expectedWords.length <= 2 && fwdMatches.length >= expectedWords.length;

  return (hasEnoughOverlap || shortNameMatch) ? 'match' : 'mismatch';
}
