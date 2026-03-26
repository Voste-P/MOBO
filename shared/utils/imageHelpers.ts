import { getApiBaseUrl } from './apiBaseUrl';

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
