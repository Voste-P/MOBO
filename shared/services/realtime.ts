import { fixMojibakeDeep } from '../utils/mojibake';
import { getApiBaseUrl } from '../utils/apiBaseUrl';
import { readTokens, refreshTokens, TOKEN_STORAGE_KEY } from './api';

type Listener = (msg: RealtimeMessage) => void;

export type RealtimeMessage = {
  type: string;
  ts: string;
  payload?: any;
};

function normalizeApiRoot(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = String(raw).trim();
  if (!v) return undefined;

  // Allow passing either the service root (e.g. https://api.example.com)
  // or the API root (e.g. https://api.example.com/api).
  const withProto = v.startsWith('http://') || v.startsWith('https://') ? v : `https://${v}`;
  const noTrailing = withProto.endsWith('/') ? withProto.slice(0, -1) : withProto;
  return noTrailing.endsWith('/api') ? noTrailing : `${noTrailing}/api`;
}

// Realtime is a long-lived stream. In production we prefer connecting directly to the backend
// (when we have an absolute URL) because some hosting proxies/CDNs buffer or disrupt SSE.
function getRealtimeApiBaseUrl(): string {
  const baseFromEnv = normalizeApiRoot(
    (typeof process !== 'undefined' && (process as any).env && (process as any).env.NEXT_PUBLIC_API_PROXY_TARGET
      ? String((process as any).env.NEXT_PUBLIC_API_PROXY_TARGET)
      : undefined) ||
      (typeof process !== 'undefined' && (process as any).env && (process as any).env.NEXT_PUBLIC_API_URL
        ? String((process as any).env.NEXT_PUBLIC_API_URL)
        : undefined) ||
      (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.VITE_API_URL
        ? String((import.meta as any).env.VITE_API_URL)
        : undefined) ||
      ((globalThis as any).__MOBO_API_URL__ as string | undefined)
  );

  // Keep local dev behavior: talk directly to localhost backend when possible.
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';
    if (isLocalhost) return 'http://localhost:8080/api';
  }

  return baseFromEnv || getApiBaseUrl();
}

/** Read access token from shared token store managed by api.ts */
function readAccessToken(): string | null {
  const tokens = readTokens();
  return tokens?.accessToken || null;
}

/**
 * Refresh the access token via the shared singleton in api.ts.
 * This ensures only ONE refresh request flies at a time across both
 * the regular API client and the SSE realtime client.
 */
async function refreshAccessToken(): Promise<boolean> {
  try {
    const result = await refreshTokens();
    // refreshTokens() already calls notifyAuthExpired() + clearTokens() on failure
    return result !== null;
  } catch {
    return false;
  }
}

class RealtimeClient {
  private listeners = new Set<Listener>();
  private controller: AbortController | null = null;
  private running = false;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 30_000;
  private authFailures = 0;
  private readonly maxAuthFailures = 5;
  private storageListener: ((e: StorageEvent) => void) | null = null;
  private _connected = false;

  // If the connection is open but we stop receiving bytes (proxy buffering/hanging),
  // force a reconnect so UI can recover.
  private readonly idleReconnectMs = 70_000;

  /** Whether the SSE stream is currently connected and receiving data. */
  get connected(): boolean { return this._connected; }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    this.ensureRunning();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  stop() {
    this.running = false;
    this._connected = false;
    this.backoffMs = 1000;
    if (this.controller) this.controller.abort();
    this.controller = null;
    if (this.storageListener && typeof window !== 'undefined') {
      try {
        window.removeEventListener('storage', this.storageListener);
      } catch {
        // ignore
      }
    }
    this.storageListener = null;
  }

  private ensureRunning() {
    if (this.running) return;
    this.running = true;

    // Cross-tab auth changes should trigger an immediate reconnect.
    if (!this.storageListener && typeof window !== 'undefined') {
      this.storageListener = (e: StorageEvent) => {
        if (e.key !== TOKEN_STORAGE_KEY) return;
        this.backoffMs = 1000;
        try {
          this.controller?.abort();
        } catch {
          // ignore
        }
      };
      try {
        window.addEventListener('storage', this.storageListener);
      } catch {
        // ignore
      }
    }

    void this.loop();
  }

  private async loop() {
    while (this.running && this.listeners.size > 0) {
      const token = readAccessToken();
      if (!token) {
        // No auth token; pause until someone logs in.
        await this.sleep(1500);
        continue;
      }

      const url = `${getRealtimeApiBaseUrl()}/realtime/stream`;
      const ctrl = new AbortController();
      this.controller = ctrl;

      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          cache: 'no-store',
          signal: ctrl.signal,
        });

        if (!res.ok) {
          // Auth errors should not spin hot. Try refresh once.
          if (res.status === 401 || res.status === 403) {
            this.authFailures++;
            const refreshed = await refreshAccessToken();
            if (!refreshed) {
              this.dispatch({ type: 'auth.error', ts: new Date().toISOString(), payload: { status: res.status } });
              // Terminal backoff: stop reconnecting after repeated auth failures
              if (this.authFailures >= this.maxAuthFailures) {
                this._connected = false;
                this.running = false;
                break;
              }
              await this.sleep(Math.min(3000 * Math.pow(2, this.authFailures - 1), this.maxBackoffMs));
            } else {
              // Refresh succeeded — reset auth failure counter so we don't give up prematurely
              this.authFailures = 0;
            }
          } else {
            await this.sleep(this.backoffMs);
          }
          // Add a little jitter to avoid reconnect stampedes.
          this.backoffMs = Math.min(Math.floor(this.backoffMs * 1.8 + Math.random() * 250), this.maxBackoffMs);
          continue;
        }

        this.backoffMs = 1000;
        this.authFailures = 0;
        this._connected = true;        const reader = res.body?.getReader();
        if (!reader) {
          await this.sleep(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
          continue;
        }

        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let eventName = 'message';
        let dataLines: string[] = [];

        let lastByteAt = Date.now();
        const idleTimer = setInterval(() => {
          if (!this.running) return;
          if (Date.now() - lastByteAt > this.idleReconnectMs) {
            try {
              ctrl.abort();
            } catch {
              // ignore
            }
          }
        }, 5_000);

        const flushEvent = () => {
          if (!dataLines.length) {
            eventName = 'message';
            return;
          }

          const rawData = dataLines.join('\n');
          dataLines = [];

          let payload: any = rawData;
          try {
            payload = JSON.parse(rawData);
          } catch {
            // keep as string
          }

          const ts =
            payload && typeof payload === 'object' && typeof payload.ts === 'string'
              ? payload.ts
              : new Date().toISOString();

          const innerPayload =
            payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'payload')
              ? (payload as any).payload
              : payload;

          this.dispatch({ type: eventName, ts, payload: fixMojibakeDeep(innerPayload) });
          eventName = 'message';
        };

        try {
          while (this.running && this.listeners.size > 0) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength) lastByteAt = Date.now();
            buffer += decoder.decode(value, { stream: true });

            // Process complete lines.
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, idx).replace(/\r$/, '');
              buffer = buffer.slice(idx + 1);

              if (!line) {
                flushEvent();
                continue;
              }

              if (line.startsWith(':')) continue; // comment

              if (line.startsWith('event:')) {
                eventName = line.slice('event:'.length).trim() || 'message';
                continue;
              }

              if (line.startsWith('data:')) {
                dataLines.push(line.slice('data:'.length).trimStart());
                continue;
              }
            }
          }
        } finally {
          clearInterval(idleTimer);
        }
      } catch (e) {
        this._connected = false;
        if ((e as any)?.name !== 'AbortError') {
          await this.sleep(this.backoffMs);
          this.backoffMs = Math.min(Math.floor(this.backoffMs * 1.8 + Math.random() * 250), this.maxBackoffMs);
        }
      }
    }
  }

  private dispatch(msg: RealtimeMessage) {
    for (const l of Array.from(this.listeners)) {
      try {
        l(msg);
      } catch {
        // ignore listener errors
      }
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const client = new RealtimeClient();

export function subscribeRealtime(listener: Listener) {
  return client.subscribe(listener);
}

export function stopRealtime() {
  client.stop();
}
