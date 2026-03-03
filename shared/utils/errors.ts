/* ────────────────────────────────────────────────────────────
 *  Error classification & user-friendly message helpers
 * ──────────────────────────────────────────────────────────── */

export type ErrorCategory =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limit'
  | 'server'
  | 'unknown';

/** Check if an error is a network connectivity issue (no response received). */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed');
  }
  return false;
}

/** Check if an error is a request timeout (AbortError from our fetchWithTimeout). */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('abort') || msg.includes('timed out') || msg.includes('timeout');
  }
  return false;
}

/** Map an HTTP status code to a short, user-friendly message. */
export function httpStatusToFriendlyMessage(status: number): string {
  if (status === 400) return 'The request was invalid. Please check your input and try again.';
  if (status === 401) return 'Your session has expired. Please log in again.';
  if (status === 403) return 'You do not have permission to perform this action.';
  if (status === 404) return 'The requested resource was not found.';
  if (status === 409) return 'This action conflicts with an existing operation. Please refresh and try again.';
  if (status === 413) return 'The uploaded file is too large. Please reduce the size.';
  if (status === 422) return 'Some of the provided data is invalid. Please review and re-submit.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500 && status < 600) return 'Something went wrong on our end. Please try again shortly.';
  return `Request failed (${status}). Please try again.`;
}

/**
 * Classify an error into a category. Useful for deciding retry strategy,
 * toast variant, or analytic labels.
 */
export function classifyError(err: unknown): ErrorCategory {
  if (isNetworkError(err)) return 'network';
  if (isTimeoutError(err)) return 'timeout';

  const code: string | undefined = (err as any)?.code;
  const status: number | undefined = (err as any)?.status;

  if (code === 'UNAUTHENTICATED' || code === 'INVALID_TOKEN' || status === 401) return 'auth';
  if (code === 'FORBIDDEN' || status === 403) return 'forbidden';
  if (code === 'NOT_FOUND' || status === 404) return 'not_found';
  if (code === 'CONFLICT' || status === 409) return 'conflict';
  if (code === 'RATE_LIMITED' || status === 429) return 'rate_limit';
  if (code === 'VALIDATION_ERROR' || status === 400 || status === 422) return 'validation';
  if (status && status >= 500) return 'server';

  return 'unknown';
}

/**
 * Convert any thrown value into a human-friendly error message.
 * Prioritises server-provided messages, then falls back to
 * status-aware or category-aware friendly text.
 */
export function formatErrorMessage(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (typeof err === 'string' && err.trim()) return err;

  // ── Network / Timeout (no server message available) ──
  if (isNetworkError(err))
    return 'Unable to connect. Please check your internet connection and try again.';
  if (isTimeoutError(err))
    return 'The request took too long. Please try again.';

  // ── Error with a message from the server ──
  if (err instanceof Error && err.message) {
    // Strip raw status-only messages and replace with friendly text
    const statusMatch = err.message.match(/^Request failed:\s*(\d{3})$/);
    if (statusMatch) {
      return httpStatusToFriendlyMessage(Number(statusMatch[1]));
    }
    return err.message;
  }

  return fallback;
}
