import React from 'react';
import { cn } from './cn';

type Variant = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'pending';

export const Badge = React.memo(function Badge({
  variant = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  const variants: Record<Variant, string> = {
    neutral: 'bg-zinc-100 text-zinc-700 border-zinc-200',
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    danger: 'bg-rose-50 text-rose-700 border-rose-200',
    info: 'bg-sky-50 text-sky-700 border-sky-200',
    pending: 'bg-slate-200 text-slate-700 border-slate-300 animate-pulse',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-1 rounded-full border uppercase tracking-widest',
        variants[variant],
        className
      )}
      {...props}
    />
  );
});
