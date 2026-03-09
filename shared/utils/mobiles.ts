export function digitsOnly(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\D/g, '');
}

/**
 * Normalizes a phone/mobile input into the canonical 10-digit mobile number.
 *
 * Behavior:
 * - Strips all non-digits.
 * - Accepts common prefixes but keeps only the last 10 digits:
 *   - Leading `0` (11 digits total) -> drop the leading 0
 *   - Country code `91` (12 digits total) -> drop the leading 91
 */
export function normalizeMobileTo10Digits(value: unknown): string {
  const digits = digitsOnly(value);
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  // Fallback: keep first 10 digits to avoid runaway input; backend will validate.
  return digits.slice(0, 10);
}

export function isValidMobile10(value: string): boolean {
  return /^\d{10}$/.test(value);
}

/** Mask mobile number for display: 98****1234 */
export function maskMobile(m: string | undefined | null): string {
  if (!m || m.length < 6) return m || '';
  return m.slice(0, 2) + '****' + m.slice(-4);
}
