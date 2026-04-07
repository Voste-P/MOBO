import React from 'react';
import { cn, type ClassValue } from './cn';

type Variant = 'neutral' | 'primary' | 'danger';

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

const variants: Record<Variant, string> = {
  neutral:
    'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-slate-400/30 focus-visible:ring-offset-white',
  primary:
    'bg-zinc-900 text-white border border-zinc-900/20 hover:bg-zinc-800 focus-visible:ring-zinc-500/40 focus-visible:ring-offset-white',
  danger:
    'bg-rose-600 text-white border border-rose-600/20 hover:bg-rose-500 focus-visible:ring-rose-500/40 focus-visible:ring-offset-white',
};

export const IconButton = React.forwardRef<HTMLButtonElement, Props>(function IconButton(
  { className, variant = 'neutral', disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center',
        'h-11 w-11 rounded-full transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:opacity-60 disabled:cursor-not-allowed',
        variants[variant],
        className as ClassValue
      )}
      {...props}
    />
  );
});
