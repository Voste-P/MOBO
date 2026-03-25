import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { AppNotification } from '../types';
import { useAuth } from './AuthContext';
import { api, asArray } from '../services/api';
import { subscribeRealtime } from '../services/realtime';

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
  const [local, setLocal] = useState<AppNotification[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const storageScope = user?.id ? `:${user.id}` : ':anon';

  // Native fetch for notifications (replaces React Query)
  const [rawInbox, setRawInbox] = useState<any[]>([]);
  const fetchingRef = useRef(false);

  const fetchNotifications = useCallback(async () => {
    if (!user?.id || fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const data = await api.notifications.list();
      setRawInbox(asArray(data));
    } catch {
      // silent — notifications are non-critical
    } finally {
      fetchingRef.current = false;
    }
  }, [user?.id]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  // Realtime: refresh on relevant events (batch all events with clearTimeout)
  useEffect(() => {
    if (!user?.id) return;
    let timer: any = null;
    const unsub = subscribeRealtime((msg: any) => {
      if (['orders.changed', 'notifications.changed', 'tickets.changed', 'wallets.changed'].includes(msg.type)) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fetchNotifications(); }, 800);
      }
    });
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, [user?.id, fetchNotifications]);

  const inbox = useMemo<AppNotification[]>(() => {
    const data = rawInbox;
    if (!Array.isArray(data)) return [];
    return data.map((n: any) => ({
      id: String(n.id),
      title: String(n.title || 'Notification'),
      message: String(n.message || ''),
      type: (n.type === 'success' || n.type === 'alert' || n.type === 'info') ? n.type : 'info',
      createdAt: typeof n.createdAt === 'string' ? n.createdAt : undefined,
      source: 'inbox' as const,
    }));
  }, [rawInbox]);

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
    await fetchNotifications();
  }, [fetchNotifications]);

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
