import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeRealtime } from '../services/realtime';

export type RealtimeConnectionStatus = {
  connected: boolean;
  lastEventAt: number | null;
  lastAuthErrorAt: number | null;
  lastAuthErrorStatus: number | null;
};

// Heuristic: backend sends ping every 25s. Consider disconnected if we haven't
// seen anything for ~45s.
const STALE_AFTER_MS = 45_000;

export function useRealtimeConnection(): RealtimeConnectionStatus {
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [lastAuthErrorAt, setLastAuthErrorAt] = useState<number | null>(null);
  const [lastAuthErrorStatus, setLastAuthErrorStatus] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const lastEventAtRef = useRef<number | null>(null);

  useEffect(() => {
    const unsub = subscribeRealtime((msg) => {
      const now = Date.now();

      // Any event implies the stream is alive.
      if (msg.type === 'ping' || msg.type === 'ready' || msg.type === 'message') {
        lastEventAtRef.current = now;
        setLastEventAt(now);
        setConnected(true);
        return;
      }

      if (msg.type === 'auth.error') {
        setLastAuthErrorAt(now);
        const status = msg.payload?.status;
        setLastAuthErrorStatus(typeof status === 'number' ? status : null);
        return;
      }

      // Domain events (orders.changed, etc) also imply liveness.
      lastEventAtRef.current = now;
      setLastEventAt(now);
      setConnected(true);
    });

    return () => {
      unsub();
    };
  }, []);

  // Only update `connected` when staleness threshold is crossed, not on a fixed timer
  useEffect(() => {
    const t = setInterval(() => {
      const ts = lastEventAtRef.current;
      const isStale = !ts || Date.now() - ts >= STALE_AFTER_MS;
      setConnected((prev) => {
        if (isStale && prev) return false;
        if (!isStale && !prev) return true;
        return prev; // no state change — no re-render
      });
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  return useMemo(() => ({
    connected,
    lastEventAt,
    lastAuthErrorAt,
    lastAuthErrorStatus,
  }), [connected, lastEventAt, lastAuthErrorAt, lastAuthErrorStatus]);
}
