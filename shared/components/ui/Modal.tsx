'use client';
import React, { useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from './cn';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  /** Max-width class override, default 'max-w-lg' */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Show close button in top-right */
  showClose?: boolean;
  /** Title displayed in header */
  title?: string;
}

const sizeMap = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-3xl',
};

export function Modal({
  open,
  onClose,
  children,
  className,
  size = 'lg',
  showClose = true,
  title,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      // Focus trap — keep Tab cycling inside the modal panel
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          className="fixed inset-0 z-modal flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => {
            if (e.target === overlayRef.current) onClose();
          }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

          {/* Panel */}
          <motion.div
            ref={(el) => { panelRef.current = el; el?.focus(); }}
            tabIndex={-1}
            className={cn(
              'relative w-full bg-white rounded-[2rem] shadow-2xl overflow-hidden outline-none',
              sizeMap[size],
              className,
            )}
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            {(title || showClose) && (
              <div className="flex items-center justify-between px-6 pt-6 pb-2">
                {title && <h3 className="text-lg font-extrabold text-zinc-900">{title}</h3>}
                {showClose && (
                  <button
                    onClick={onClose}
                    className="ml-auto w-11 h-11 flex items-center justify-center rounded-full bg-zinc-100 hover:bg-zinc-200 active:bg-zinc-300 transition-colors text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400/60"
                    aria-label={`Close ${title || 'dialog'}`}
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            )}
            <div className="px-6 pb-6">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
