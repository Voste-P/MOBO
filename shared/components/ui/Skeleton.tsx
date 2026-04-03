import React from 'react';
import { cn } from './cn';

/** Shimmer skeleton element with smooth pulse animation */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg bg-zinc-200/70',
        'before:absolute before:inset-0 before:-translate-x-full',
        'before:animate-[shimmer_1.5s_infinite]',
        'before:bg-gradient-to-r before:from-transparent before:via-white/60 before:to-transparent',
        'motion-reduce:before:animate-none',
        className,
      )}
    />
  );
}

/** Pre-built skeleton for a card element */
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-[2rem] bg-white border border-zinc-100 p-5 space-y-4', className)}>
      <div className="flex gap-4">
        <Skeleton className="w-20 h-20 rounded-2xl flex-shrink-0" />
        <div className="flex-1 space-y-2 py-1">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-5 w-20 mt-2 rounded-full" />
        </div>
      </div>
      <Skeleton className="h-12 rounded-xl" />
    </div>
  );
}

/** Pre-built skeleton for a table/list row */
export function RowSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 p-3 bg-white rounded-xl border border-zinc-100', className)}>
      <Skeleton className="w-10 h-10 rounded-xl flex-shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-6 w-16 rounded-full" />
    </div>
  );
}

/** Stat card skeleton for dashboard grids */
export function StatSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('p-4 bg-white rounded-2xl border border-zinc-100 space-y-2', className)}>
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-7 w-24" />
    </div>
  );
}
