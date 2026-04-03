import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { User } from '../types';
import { api, onAuthExpired } from '../services/api';
import { subscribeRealtime, stopRealtime } from '../services/realtime';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (mobile: string, pass: string) => Promise<User>;
  loginAdmin: (username: string, pass: string) => Promise<User>;
  register: (name: string, mobile: string, pass: string, mediatorCode: string, securityQuestions?: { questionId: number; answer: string }[]) => Promise<void>;
  registerOps: (
    name: string,
    mobile: string,
    pass: string,
    role: 'agency' | 'mediator',
    code: string,
    securityQuestions?: { questionId: number; answer: string }[]
  ) => Promise<{ pendingApproval?: boolean; message?: string } | void>;
  registerBrand: (name: string, mobile: string, pass: string, brandCode: string, securityQuestions?: { questionId: number; answer: string }[]) => Promise<void>;
  updateUser: (updates: Partial<User>) => Promise<void>;
  refreshSession: () => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const emitAuthChange = () => {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event('mobo-auth-changed'));
  } catch {
    // ignore
  }
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Realtime: keep the local user snapshot in sync (approval status, wallet balances, etc.)
  // skipNextRealtimeRef prevents a double api.auth.me() after restoreSession sets the user.
  const skipNextRealtimeRef = useRef(true);
  useEffect(() => {
    if (!user?.id) return;
    // On the first run after restoreSession sets user, skip the realtime refresh
    // because restoreSession already fetched the latest user data.
    if (skipNextRealtimeRef.current) {
      skipNextRealtimeRef.current = false;
      // Still set up the subscription, but don't trigger an immediate fetch.
    }
    let timer: any = null;
    let inFlight = false;
    let mounted = true;

    const scheduleRefresh = () => {
      // Debounce: always restart the timer so we fetch the latest state after a burst.
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        if (inFlight || !mounted) return;
        inFlight = true;
        try {
          const me = await api.auth.me();
          if (!mounted) return;
          setUser(me);
          try { localStorage.setItem('mobo_session', JSON.stringify(me)); } catch { /* storage full */ }
          emitAuthChange();
        } catch {
          // If token became invalid, restoreSession() will handle on next load.
        } finally {
          inFlight = false;
        }
      }, 2_000);
    };

    const unsub = subscribeRealtime((msg) => {
      if (msg.type === 'users.changed') {
        const changedId = msg.payload?.userId;
        if (!changedId || String(changedId) === String(user.id)) scheduleRefresh();
      } else if (msg.type === 'wallets.changed') {
        // Only refresh if the wallet change is for the current user
        const changedOwner = msg.payload?.userId || msg.payload?.ownerUserId;
        if (!changedOwner || String(changedOwner) === String(user.id)) scheduleRefresh();
      }
    });

    return () => {
      mounted = false;
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user?.id]);

  useEffect(() => {
    const restoreSession = async () => {
      try {
        const storedUser = localStorage.getItem('mobo_session');
        if (!storedUser) return;

        // If we have a stored user but no access token, treat it as logged-out.
        const rawTokens = localStorage.getItem('mobo_tokens_v1');
        if (!rawTokens) {
          localStorage.removeItem('mobo_session');
          return;
        }

        // Hydrate cached user immediately so the UI renders without a login screen
        // even before the network call finishes (or if it fails).
        try {
          const cached = JSON.parse(storedUser);
          if (cached && cached.id) setUser(cached);
        } catch { /* corrupt cache — will be overwritten below */ }

        // Validate token and refresh user from backend.
        const me = await api.auth.me();
        setUser(me);
        localStorage.setItem('mobo_session', JSON.stringify(me));
        emitAuthChange();
      } catch (err: unknown) {
        // Only clear auth state on definitive auth failures (401/403),
        // not on transient network errors that would cause unnecessary logout.
        const isAuthErr =
          (err instanceof Error && /401|403|unauthorized|forbidden/i.test(err.message)) ||
          (typeof err === 'object' && err !== null && 'status' in err && ((err as any).status === 401 || (err as any).status === 403));
        if (isAuthErr) {
          localStorage.removeItem('mobo_session');
          localStorage.removeItem('mobo_tokens_v1');
          setUser(null);
          emitAuthChange();
        }
        // On network errors, the cached user from above remains in state —
        // user stays logged in with stale data until network recovers.
      }
    };

    restoreSession().finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (mobile: string, pass: string) => {
    const cleanMobile = String(mobile || '').trim();
    const cleanPass = String(pass || '').trim();
    const loggedInUser = (await api.auth.login(cleanMobile, cleanPass)) as User;
    setUser(loggedInUser);
    try { localStorage.setItem('mobo_session', JSON.stringify(loggedInUser)); } catch { /* storage full or restricted */ }
    emitAuthChange();
    return loggedInUser;
  }, []);

  const loginAdmin = useCallback(async (username: string, pass: string) => {
    const cleanUsername = String(username || '').trim();
    const cleanPass = String(pass || '').trim();
    const loggedInUser = (await api.auth.loginAdmin(cleanUsername, cleanPass)) as User;
    setUser(loggedInUser);
    try { localStorage.setItem('mobo_session', JSON.stringify(loggedInUser)); } catch { /* storage full or restricted */ }
    emitAuthChange();
    return loggedInUser;
  }, []);

  const register = useCallback(async (name: string, mobile: string, pass: string, mediatorCode: string, securityQuestions?: { questionId: number; answer: string }[]) => {
    const newUser = await api.auth.register(name, mobile, pass, mediatorCode, securityQuestions);
    setUser(newUser);
    try { localStorage.setItem('mobo_session', JSON.stringify(newUser)); } catch { /* storage full or restricted */ }
    emitAuthChange();
  }, []);

  const registerOps = useCallback(async (
    name: string,
    mobile: string,
    pass: string,
    role: 'agency' | 'mediator',
    code: string,
    securityQuestions?: { questionId: number; answer: string }[]
  ) => {
    const result = await api.auth.registerOps(name, mobile, pass, role, code, securityQuestions);

    // Pending approval means: create request, but don't authenticate the mediator yet.
    if (result && typeof result === 'object' && (result as any).pendingApproval) {
      return { pendingApproval: true, message: (result as any).message };
    }

    const newUser = result as User;
    setUser(newUser);
    try { localStorage.setItem('mobo_session', JSON.stringify(newUser)); } catch { /* storage full or restricted */ }
    emitAuthChange();
  }, []);

  const registerBrand = useCallback(async (name: string, mobile: string, pass: string, brandCode: string, securityQuestions?: { questionId: number; answer: string }[]) => {
    const newUser = await api.auth.registerBrand(name, mobile, pass, brandCode, securityQuestions);
    setUser(newUser);
    try { localStorage.setItem('mobo_session', JSON.stringify(newUser)); } catch { /* storage full or restricted */ }
    emitAuthChange();
  }, []);

  const updateUser = useCallback(async (updates: Partial<User>) => {
    if (!user) return;
    const updatedUser = await api.auth.updateProfile(user.id, updates);
    setUser(updatedUser);
    try { localStorage.setItem('mobo_session', JSON.stringify(updatedUser)); } catch { /* storage full or restricted */ }
    emitAuthChange();
  }, [user]);

  const refreshSession = useCallback(async () => {
    try {
      const me = await api.auth.me();
      setUser(me);
      try { localStorage.setItem('mobo_session', JSON.stringify(me)); } catch { /* storage full */ }
      emitAuthChange();
    } catch { /* ignore — stale cache persists until next successful load */ }
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('mobo_session');
      localStorage.removeItem('mobo_tokens_v1');
    }
    stopRealtime();
    emitAuthChange();
  }, []);

  // Force-logout when api.ts detects an unrecoverable 401 (refresh token expired).
  useEffect(() => {
    const unsub = onAuthExpired(() => {
      logout();
    });
    return unsub;
  }, [logout]);

  const value = useMemo(() => ({
    user,
    isAuthenticated: !!user,
    login,
    loginAdmin,
    register,
    registerOps,
    registerBrand,
    updateUser,
    refreshSession,
    logout,
    isLoading,
  }), [user, isLoading, login, loginAdmin, register, registerOps, registerBrand, updateUser, refreshSession, logout]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
