import React from 'react';

/**
 * Minimal pull-to-refresh spinner indicator.
 * Shows a rotating arrow while pulling, then a spinner while refreshing.
 */
export function PullToRefreshIndicator({
  distance,
  isRefreshing,
  threshold = 60,
}: {
  distance: number;
  isRefreshing: boolean;
  threshold?: number;
}) {
  if (distance <= 0 && !isRefreshing) return null;

  const progress = Math.min(distance / threshold, 1);
  const rotation = progress * 180;

  return (
    <div
      className="flex items-center justify-center transition-[height] duration-200"
      style={{ height: Math.max(distance, isRefreshing ? 40 : 0) }}
      aria-hidden="true"
    >
      {isRefreshing ? (
        <div className="w-5 h-5 border-2 border-zinc-200 border-t-zinc-600 rounded-full animate-spin" />
      ) : (
        <svg
          width={20}
          height={20}
          viewBox="0 0 20 20"
          className="text-zinc-400 transition-transform duration-100"
          style={{ transform: `rotate(${rotation}deg)`, opacity: progress }}
        >
          <path
            d="M10 3v10M5 8l5-5 5 5"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      )}
    </div>
  );
}
