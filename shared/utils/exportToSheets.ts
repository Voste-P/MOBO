import { api } from '../services/api';

export interface SheetsExportOptions {
  title: string;
  headers: string[];
  rows: (string | number)[][];
  sheetName?: string;
  onSuccess?: (url: string) => void;
  onError?: (msg: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

// Cache connection status to avoid redundant API calls within the same session.
let _googleConnectedCache: { connected: boolean; checkedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedStatus(): boolean | null {
  if (!_googleConnectedCache) return null;
  if (Date.now() - _googleConnectedCache.checkedAt > CACHE_TTL_MS) {
    _googleConnectedCache = null;
    return null;
  }
  return _googleConnectedCache.connected;
}

function setCachedStatus(connected: boolean) {
  _googleConnectedCache = { connected, checkedAt: Date.now() };
}

/** Invalidate the cached Google connection status (e.g. after disconnect). */
export function invalidateGoogleStatusCache() {
  _googleConnectedCache = null;
}

/**
 * Initiate Google OAuth in a popup window.
 * Returns a promise that resolves when the popup completes (success or failure).
 * The user only needs to do this ONCE — after that, the refresh token is stored
 * server-side and all subsequent exports work seamlessly.
 */
export async function connectGoogleAccount(): Promise<boolean> {
  try {
    const { url } = await api.google.getAuthUrl();
    return new Promise<boolean>((resolve) => {
      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        url,
        'google-oauth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
      );

      if (!popup) {
        // Popup blocked — resolve false so caller can proceed with service account fallback
        resolve(false);
        return;
      }

      let resolved = false;
      const cleanup = () => {
        window.removeEventListener('message', handleMessage);
        clearInterval(pollTimer);
        clearTimeout(safetyTimer);
      };

      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type === 'GOOGLE_OAUTH_RESULT') {
          resolved = true;
          cleanup();
          const success = !!event.data.success;
          if (success) setCachedStatus(true);
          resolve(success);
        }
      };

      window.addEventListener('message', handleMessage);

      // Fallback: poll for popup closure
      const pollTimer = setInterval(() => {
        if (popup.closed && !resolved) {
          resolved = true;
          cleanup();
          // If popup closed without a message, check connection status from server
          api.google.getStatus()
            .then(s => {
              setCachedStatus(s.connected);
              resolve(s.connected);
            })
            .catch(() => resolve(false));
        }
      }, 500);

      // Safety timeout: 5 minutes
      const safetyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          if (!popup.closed) popup.close();
          resolve(false);
        }
      }, 5 * 60 * 1000);
    });
  } catch {
    return false;
  }
}

/**
 * Export data to Google Sheets via backend API.
 *
 * Flow:
 * 1. Check if user has Google connected (cached for 5 min).
 * 2. If not connected, show a one-time Google sign-in popup.
 * 3. After sign-in (or if already connected), export via backend.
 * 4. Backend uses user's OAuth token → sheet goes to THEIR Drive.
 * 5. If user OAuth unavailable, backend falls back to service account
 *    and auto-shares the sheet with the user's email.
 * 6. Opens the spreadsheet in a new tab.
 */
export async function exportToGoogleSheet(opts: SheetsExportOptions): Promise<void> {
  const { title, headers, rows, sheetName, onSuccess, onError, onStart, onEnd } = opts;

  if (!rows.length) {
    onError?.('No data available to export.');
    return;
  }

  onStart?.();
  try {
    // Check if user has Google connected — use cache to avoid redundant calls
    let connected = getCachedStatus();
    if (connected === null) {
      try {
        const status = await api.google.getStatus();
        connected = status.connected;
        setCachedStatus(connected);
      } catch {
        // Google OAuth may not be configured — proceed anyway (will use service account)
        connected = null;
      }
    }

    if (connected === false) {
      // Try to connect Google account first (one-time sign-in)
      const didConnect = await connectGoogleAccount();
      if (!didConnect) {
        // User cancelled or popup blocked — still proceed with service account fallback.
        // Service account will auto-share the sheet with the user's email.
      }
    }

    const result = await api.sheets.export({ title, headers, rows, sheetName });
    window.open(result.spreadsheetUrl, '_blank', 'noopener');
    onSuccess?.(result.spreadsheetUrl);
  } catch (err: any) {
    const code = err?.code;
    let msg: string;
    if (code === 'SHEETS_AUTH_NOT_CONFIGURED') {
      msg = 'Google Sheets export is not configured yet. Please contact your administrator to set up Google Cloud credentials.';
    } else if (code === 'GOOGLE_OAUTH_NOT_CONFIGURED') {
      msg = 'Google account connection is not available on this server.';
    } else if (code === 'RATE_LIMITED') {
      msg = 'Too many export requests. Please wait a moment and try again.';
    } else {
      msg = err?.message || 'Google Sheets export failed. Please try again later.';
    }
    onError?.(msg);
  } finally {
    onEnd?.();
  }
}
