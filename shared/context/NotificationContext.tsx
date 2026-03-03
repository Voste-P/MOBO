import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import { AppNotification } from '../types';
import { useAuth } from './AuthContext';
import { api } from '../services/api';
import { subscribeRealtime } from '../services/realtime';
import { useRealtimeConnection } from '../hooks/useRealtimeConnection';

interface NotificationContextType {
  notifications: AppNotification[];
  unreadCount: number;
  markAllRead: () => void;
  refresh: () => Promise<void>;
  showNotification: (notification: Omit<AppNotification, 'id'>) => void;
  removeNotification: (id: string) => void;
}

const STORAGE_LAST_SEEN = 'mobo_v7_notifications_last_seen';
const STORAGE_DISMISSED = 'mobo_v7_notifications_dismissed';

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const { connected } = useRealtimeConnection();
  const [inbox, setInbox] = useState<AppNotification[]>([]);
  const [local, setLocal] = useState<AppNotification[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const storageScope = user?.id ? `:${user.id}` : ':anon';

  // Load per-user read/dismiss state
  useEffect(() => {
    if (!user?.id) return;
    try {
      const rawSeen = localStorage.getItem(`${STORAGE_LAST_SEEN}${storageScope}`);
      setLastSeenAt(rawSeen ? Number(rawSeen) || 0 : 0);
    } catch {
      setLastSeenAt(0);
    }
    try {
      const raw = localStorage.getItem(`${STORAGE_DISMISSED}${storageScope}`);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      setDismissedIds(new Set(Array.isArray(arr) ? arr : []));
    } catch {
      setDismissedIds(new Set());
    }
  }, [user?.id]);

  const refresh = useCallback(async () => {
    if (!user) {
      setInbox([]);
      return;
    }
    try {
      const data = await api.notifications.list();
      const list: AppNotification[] = (Array.isArray(data) ? data : []).map((n: any) => ({
        id: String(n.id),
        title: String(n.title || 'Notification'),
        message: String(n.message || ''),
        type: (n.type === 'success' || n.type === 'alert' || n.type === 'info') ? n.type : 'info',
        createdAt: typeof n.createdAt === 'string' ? n.createdAt : undefined,
        source: 'inbox',
      }));
      setInbox(list);
    } catch (e) {
      // Keep UI resilient: don't break app if notifications fail.
      // Preserve stale inbox data on transient network errors instead of clearing.
      console.error('Failed to load notifications', e);
    }
  }, [user?.id]);

  // Refresh on login; poll only as a fallback when realtime is disconnected.
  useEffect(() => {
    if (!user) return;
    refresh();

    if (connected) return;
    // Poll more frequently (30s) when realtime is disconnected as a fallback
    const t = setInterval(() => {
      refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [user, refresh, connected]);

  // Realtime refresh for anything that impacts derived notifications.
  useEffect(() => {
    if (!user) return;
    let timer: any = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 400);
    };
    const unsub = subscribeRealtime((msg) => {
      if (msg.type === 'orders.changed' || msg.type === 'users.changed' || msg.type === 'wallets.changed') {
        schedule();
      }
      if (msg.type === 'notifications.changed') {
        schedule();
      }
      if (msg.type === 'tickets.changed') {
        schedule();
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user, refresh]);

  const notifications = useMemo(() => {
    const safeParse = (v: string | undefined) => {
      if (!v) return 0;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    };
    const merged = [...local, ...inbox]
      .filter((n) => !dismissedIds.has(n.id))
      .map((n) => {
        const ts = safeParse(n.createdAt) || Date.now();
        return { ...n, read: ts <= lastSeenAt };
      })
      .sort((a, b) => {
        const ta = safeParse(a.createdAt);
        const tb = safeParse(b.createdAt);
        return tb - ta;
      })
      .slice(0, 50);
    return merged;
  }, [local, inbox, dismissedIds, lastSeenAt]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  const markAllRead = useCallback(() => {
    const ts = Date.now();
    setLastSeenAt(ts);
    if (user?.id) {
      try {
        localStorage.setItem(`${STORAGE_LAST_SEEN}${storageScope}`, String(ts));
      } catch {
        // ignore
      }
    }
  }, [user?.id, storageScope]);

  const removeNotification = useCallback((id: string) => {
    setLocal((prev) => prev.filter((n) => n.id !== id));
    setInbox((prev) => prev.filter((n) => n.id !== id));
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      // Prune dismissed IDs to prevent unbounded localStorage growth
      const MAX_DISMISSED = 500;
      if (next.size > MAX_DISMISSED) {
        const arr = Array.from(next);
        const pruned = arr.slice(arr.length - MAX_DISMISSED);
        next.clear();
        pruned.forEach((v) => next.add(v));
      }
      if (user?.id) {
        try {
          localStorage.setItem(`${STORAGE_DISMISSED}${storageScope}`, JSON.stringify(Array.from(next)));
        } catch {
          // ignore
        }
      }
      return next;
    });
  }, [user?.id, storageScope]);

  const showNotification = useCallback((notification: Omit<AppNotification, 'id'>) => {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newNotification: AppNotification = {
      ...notification,
      id,
      createdAt: new Date().toISOString(),
      source: 'local',
    };

    // History/Inbox style
    setLocal((prev) => [newNotification, ...prev].slice(0, 30));
  }, []);

  const value = useMemo(
    () => ({ notifications, unreadCount, markAllRead, refresh, showNotification, removeNotification }),
    [notifications, unreadCount, markAllRead, refresh, showNotification, removeNotification],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
};

export const useNotification = () => {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error('useNotification must be used within a NotificationProvider');
  }
  return context;
};
