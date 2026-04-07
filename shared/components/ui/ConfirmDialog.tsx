'use client';

import React, { useCallback, useRef, useState } from 'react';
import { cn } from './cn';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ConfirmVariant = 'destructive' | 'warning' | 'default';

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

/**
 * Drop-in replacement for `window.confirm()`.
 *
 * ```tsx
 * const { confirm, ConfirmDialogElement } = useConfirm();
 *
 * const ok = await confirm({ message: 'Delete this item?' });
 * if (!ok) return;
 *
 * // somewhere in JSX:
 * {ConfirmDialogElement}
 * ```
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions | string): Promise<boolean> =>
      new Promise((resolve) => {
        const options = typeof opts === 'string' ? { message: opts } : opts;
        setState({ ...options, resolve });
      }),
    [],
  );

  const handleClose = useCallback(
    (result: boolean) => {
      state?.resolve(result);
      setState(null);
    },
    [state],
  );

  const ConfirmDialogElement = state ? (
    <ConfirmDialog
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      variant={state.variant}
      onConfirm={() => handleClose(true)}
      onCancel={() => handleClose(false)}
    />
  ) : null;

  return { confirm, ConfirmDialogElement } as const;
}

/* ------------------------------------------------------------------ */
/*  Presentational component                                           */
/* ------------------------------------------------------------------ */

const variantStyles: Record<ConfirmVariant, { button: string; icon: string }> = {
  destructive: {
    button:
      'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500/40',
    icon: 'bg-red-100 text-red-600',
  },
  warning: {
    button:
      'bg-amber-500 text-white hover:bg-amber-600 focus-visible:ring-amber-400/40',
    icon: 'bg-amber-100 text-amber-600',
  },
  default: {
    button:
      'bg-zinc-900 text-white hover:bg-zinc-800 focus-visible:ring-zinc-400/60',
    icon: 'bg-zinc-100 text-zinc-600',
  },
};

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'destructive',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const styles = variantStyles[variant];

  // Trap focus & handle Escape
  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return; }
    };
    document.addEventListener('keydown', handleKey);
    cancelRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Confirmation'}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onCancel();
      }}
    >
      <div className="relative w-[90vw] max-w-md rounded-3xl bg-white shadow-2xl ring-1 ring-zinc-200/60 p-6 sm:p-8 animate-in zoom-in-95 duration-200">
        {/* Icon */}
        <div
          className={cn(
            'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full',
            styles.icon,
          )}
        >
          {variant === 'destructive' ? (
            <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M4.93 19h14.14c1.34 0 2.19-1.44 1.53-2.6L13.53 4.01a1.75 1.75 0 00-3.06 0L3.4 16.4C2.74 17.56 3.59 19 4.93 19z" />
            </svg>
          ) : (
            <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>

        {/* Title */}
        {title && (
          <h3 className="text-center text-lg font-bold text-zinc-900 mb-1">
            {title}
          </h3>
        )}

        {/* Message */}
        <p className="text-center text-sm text-zinc-600 leading-relaxed mb-6 max-h-[40dvh] overflow-y-auto scrollbar-styled">
          {message}
        </p>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="flex-1 h-12 rounded-2xl border border-zinc-200 bg-white text-zinc-700 font-bold text-sm hover:bg-zinc-50 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'flex-1 h-12 rounded-2xl font-bold text-sm transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
              styles.button,
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
