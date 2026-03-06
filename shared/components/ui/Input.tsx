'use client';

import React, { useState } from 'react';
import { cn } from './cn';

type Props = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  tone?: 'light' | 'dark';
};

export const Input = React.forwardRef<HTMLInputElement, Props>(function Input(
  { className, label, hint, error, leftIcon, tone = 'light', id, type, ...props },
  ref
) {
  const inputId = id || React.useId();
  const isDark = tone === 'dark';
  const isPasswordType = type === 'password';
  const [showPassword, setShowPassword] = useState(false);

  return (
    <label className="block">
      {label && (
        <span
          className={cn(
            'block text-[10px] font-extrabold uppercase tracking-widest ml-1 mb-1.5',
            isDark ? 'text-slate-500' : 'text-zinc-400'
          )}
        >
          {label}
        </span>
      )}
      <div
        className={cn(
          'relative rounded-2xl transition-all',
          isDark
            ? 'bg-slate-900 border border-slate-700 focus-within:ring-2 focus-within:ring-indigo-400/50 focus-within:border-indigo-400'
            : 'bg-zinc-50 border border-zinc-200 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-400/40 focus-within:border-indigo-300',
          error
            ? isDark
              ? 'border-rose-500/40 focus-within:ring-rose-400/40 focus-within:border-rose-400/60'
              : 'border-red-200 focus-within:ring-red-400/40 focus-within:border-red-300'
            : ''
        )}
      >
        {leftIcon && (
          <div
            className={cn(
              'absolute left-4 top-1/2 -translate-y-1/2',
              isDark ? 'text-slate-500' : 'text-zinc-400'
            )}
          >
            {leftIcon}
          </div>
        )}
        <input
          ref={ref}
          id={inputId}
          type={isPasswordType ? (showPassword ? 'text' : 'password') : type}
          className={cn(
            'w-full bg-transparent outline-none font-semibold',
            isDark ? 'text-white placeholder:text-slate-600' : 'text-zinc-900 placeholder:text-zinc-400',
            leftIcon ? 'pl-11' : 'px-4',
            isPasswordType ? 'pr-12' : 'pr-4',
            'py-4',
            className
          )}
          {...props}
        />
        {isPasswordType && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPassword((v) => !v)}
            className={cn(
              'absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors',
              isDark
                ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                : 'text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100'
            )}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        )}
      </div>
      {error ? (
        <div className={cn('mt-2 text-xs font-bold', isDark ? 'text-rose-400' : 'text-red-600')}>
          {error}
        </div>
      ) : hint ? (
        <div className={cn('mt-2 text-xs font-medium', isDark ? 'text-slate-400' : 'text-zinc-500')}>
          {hint}
        </div>
      ) : null}
    </label>
  );
});
