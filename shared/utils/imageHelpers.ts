import { getApiBaseUrl } from './apiBaseUrl';

/**
 * Read a File as a base64 data-URI with error handling and timeout.
 * Rejects on error, abort, or if the read takes longer than `timeoutMs`.
 */
export function readFileAsDataUrl(file: File | Blob, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); };
    reader.onloadend = () => { cleanup(); resolve(reader.result as string); };
    reader.onerror = () => { cleanup(); reject(new Error('Failed to read file')); };
    reader.onabort = () => { cleanup(); reject(new Error('File read aborted')); };
    timer = setTimeout(() => { reader.abort(); reject(new Error('File read timed out')); }, timeoutMs);
    reader.readAsDataURL(file);
  });
}

/**
 * Convert an image URL to a base64 data-URI.
 * Returns '' on SSR, cross-origin block, or any fetch error.
 * Already-base64 `data:` URLs are returned as-is.
 */
export async function urlToBase64(url: string): Promise<string> {
  if (typeof window === 'undefined') return '';
  try {
    if (url.startsWith('data:')) return url;
    const apiBase = getApiBaseUrl();
    const allowed = apiBase.startsWith('http') ? new URL(apiBase).origin : window.location.origin;
    const target = new URL(url, window.location.origin);
    if (target.origin !== allowed && target.origin !== window.location.origin) {
      return '';
    }
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}
