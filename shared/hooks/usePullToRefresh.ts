import { useRef, useState, useCallback } from 'react';

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void> | void;
  /** Minimum pull distance (px) to trigger refresh. Default 60 */
  threshold?: number;
  /** Maximum indicator travel distance (px). Default 80 */
  maxPull?: number;
}

/**
 * Native-feel pull-to-refresh for PWA scroll containers.
 * Attach the returned handlers to the scrollable element.
 *
 * Usage:
 *   const { handlers, pullDistance, isRefreshing } = usePullToRefresh({ onRefresh });
 *   <div {...handlers}>
 *     {pullDistance > 0 && <PullIndicator distance={pullDistance} />}
 *     ...content
 *   </div>
 */
export function usePullToRefresh({
  onRefresh,
  threshold = 60,
  maxPull = 80,
}: UsePullToRefreshOptions) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startY = useRef(0);
  const pulling = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const el = e.currentTarget;
    // Only enable pull when scrolled to top
    if (el.scrollTop > 0 || isRefreshing) return;
    startY.current = e.touches[0].clientY;
    pulling.current = true;
  }, [isRefreshing]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pulling.current) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy < 0) {
      pulling.current = false;
      setPullDistance(0);
      return;
    }
    // Rubber-band effect: diminish pull as it increases
    const clamped = Math.min(dy * 0.5, maxPull);
    setPullDistance(clamped);
  }, [maxPull]);

  const onTouchEnd = useCallback(async () => {
    if (!pulling.current) return;
    pulling.current = false;

    if (pullDistance >= threshold) {
      setIsRefreshing(true);
      setPullDistance(threshold * 0.6); // Snap to spinner position
      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, threshold, onRefresh]);

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
    pullDistance,
    isRefreshing,
  };
}
