import React from 'react';
import { cn } from './cn';

function Bone({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-gray-200 motion-reduce:animate-none', className)} />;
}

/** Card skeleton — mimics ProductCard layout */
function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('w-full max-w-[300px] bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 space-y-3', className)}>
      <div className="flex gap-4">
        <Bone className="w-24 h-24 rounded-2xl flex-shrink-0" />
        <div className="flex-1 space-y-2 py-1">
          <Bone className="h-4 w-3/4" />
          <Bone className="h-3 w-1/2" />
          <Bone className="h-6 w-20 mt-2" />
        </div>
      </div>
      <Bone className="h-16 rounded-xl" />
      <Bone className="h-12 rounded-xl" />
    </div>
  );
}

/** Row skeleton — mimics a table/list row */
function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100">
      <Bone className="w-10 h-10 rounded-xl flex-shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Bone className="h-3.5 w-2/3" />
        <Bone className="h-3 w-1/3" />
      </div>
      <Bone className="h-6 w-16 rounded-full" />
    </div>
  );
}

/** Full-page skeleton for Suspense fallbacks in app shells */
export function PageSkeleton({ variant = 'cards' }: { variant?: 'cards' | 'dashboard' | 'minimal' }) {
  if (variant === 'minimal') {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[100dvh] bg-surface" role="status" aria-busy="true" aria-label="Loading content">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-gray-200 border-t-gray-500 rounded-full animate-spin motion-reduce:animate-none" />
          <Bone className="h-3 w-24" />
          <span className="sr-only">Loading…</span>
        </div>
      </div>
    );
  }

  if (variant === 'dashboard') {
    return (
      <div className="min-h-[100dvh] bg-surface p-4 space-y-4" role="status" aria-busy="true" aria-label="Loading dashboard">
        {/* Header skeleton */}
        <div className="flex items-center justify-between p-4 bg-white rounded-2xl border border-gray-100">
          <div className="flex items-center gap-3">
            <Bone className="w-10 h-10 rounded-xl" />
            <div className="space-y-1.5">
              <Bone className="h-4 w-32" />
              <Bone className="h-3 w-20" />
            </div>
          </div>
          <Bone className="w-8 h-8 rounded-full" />
        </div>
        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="p-4 bg-white rounded-2xl border border-gray-100 space-y-2">
              <Bone className="h-3 w-16" />
              <Bone className="h-6 w-20" />
            </div>
          ))}
        </div>
        {/* List rows */}
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  // cards variant — mimics Explore page
  return (
    <div className="flex flex-col h-full min-h-0 bg-surface" role="status" aria-busy="true" aria-label="Loading deals">
      {/* Header skeleton */}
      <div className="px-4 pt-10 pb-3 bg-white border-b border-gray-100 space-y-2.5">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Bone className="h-5 w-16 rounded" />
            <Bone className="h-5 w-32" />
          </div>
          <Bone className="w-8 h-8 rounded-full" />
        </div>
        <Bone className="h-10 rounded-xl" />
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <Bone key={i} className="h-7 w-20 rounded-full" />
          ))}
        </div>
      </div>
      {/* Card skeletons */}
      <div className="flex-1 p-6 space-y-6 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`flex justify-center ${i === 1 ? 'opacity-75' : i === 2 ? 'opacity-50' : ''}`}>
            <CardSkeleton />
          </div>
        ))}
      </div>
    </div>
  );
}
