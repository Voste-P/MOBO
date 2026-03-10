import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';

type ToastVariant = 'success' | 'error' | 'info' | 'warning';

type ToastItem = {
  id: string;
  message: string;
  title?: string;
  variant: ToastVariant;
};

type ToastApi = {
  push: (message: string, options?: { title?: string; variant?: ToastVariant; durationMs?: number }) => void;
  success: (message: string, options?: { title?: string; durationMs?: number }) => void;
  error: (message: string, options?: { title?: string; durationMs?: number }) => void;
  info: (message: string, options?: { title?: string; durationMs?: number }) => void;
  warning: (message: string, options?: { title?: string; durationMs?: number }) => void;
};

type ToastContextValue = {
  toast: ToastApi;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function variantClasses(variant: ToastVariant): string {
  switch (variant) {
    case 'success':
      return 'border-lime-400/60 bg-zinc-950 text-white';
    case 'error':
      return 'border-red-400/70 bg-zinc-950 text-white';
    case 'warning':
      return 'border-yellow-300/70 bg-zinc-950 text-white';
    case 'info':
    default:
      return 'border-sky-300/70 bg-zinc-950 text-white';
  }
}

function VariantIcon({ variant }: { variant: ToastVariant }) {
  const size = 16;
  switch (variant) {
    case 'success': return <CheckCircle size={size} className="text-lime-400 flex-shrink-0" />;
    case 'error': return <XCircle size={size} className="text-red-400 flex-shrink-0" />;
    case 'warning': return <AlertTriangle size={size} className="text-yellow-300 flex-shrink-0" />;
    case 'info': default: return <Info size={size} className="text-sky-300 flex-shrink-0" />;
  }
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) window.clearTimeout(t);
    timersRef.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (message: string, options?: { title?: string; variant?: ToastVariant; durationMs?: number }) => {
      const id = genId();
      const variant = options?.variant ?? 'info';
      const durationMs = options?.durationMs ?? (variant === 'error' ? 12000 : variant === 'warning' ? 6000 : 3000);

      const item: ToastItem = {
        id,
        message,
        title: options?.title,
        variant,
      };

      setToasts((prev) => {
        // Deduplicate: only skip if same message+variant is STILL visible and not yet expired.
        if (prev.some((x) => x.message === message && x.variant === variant)) {
          // Refresh the existing toast timer instead of adding duplicate
          const existing = prev.find((x) => x.message === message && x.variant === variant);
          if (existing) {
            const oldTimer = timersRef.current.get(existing.id);
            if (oldTimer) window.clearTimeout(oldTimer);
            const newTimeout = window.setTimeout(() => dismiss(existing.id), durationMs);
            timersRef.current.set(existing.id, newTimeout);
          }
          return prev;
        }
        return [item, ...prev].slice(0, 4);
      });

      const timeout = window.setTimeout(() => dismiss(id), durationMs);
      timersRef.current.set(id, timeout);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (message, options) => push(message, { ...options, variant: 'success' }),
      error: (message, options) => push(message, { ...options, variant: 'error' }),
      info: (message, options) => push(message, { ...options, variant: 'info' }),
      warning: (message, options) => push(message, { ...options, variant: 'warning' }),
    }),
    [push]
  );

  const value = useMemo<ToastContextValue>(() => ({ toast: api }), [api]);

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-[9999] w-[min(92vw,520px)] pointer-events-none">
        <div className="flex flex-col gap-3">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={clsx(
                'pointer-events-auto border-l-4 rounded-2xl shadow-2xl',
                'px-4 py-3 backdrop-blur',
                variantClasses(t.variant)
              )}
              role="alert"
              aria-live="assertive"
              tabIndex={0}
              onClick={() => dismiss(t.id)}
              onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') dismiss(t.id); }}
            >
              {t.title ? <div className="text-xs font-extrabold uppercase tracking-widest opacity-80">{t.title}</div> : null}
              <div className="flex items-start gap-2.5">
                <VariantIcon variant={t.variant} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold leading-snug">{t.message}</div>
                  <div className="text-[10px] mt-1 opacity-60">Tap to dismiss</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
