import { useRef, useCallback } from 'react';

interface UseSwipeTabsOptions<T extends string> {
  tabs: T[];
  activeTab: T;
  onChangeTab: (tab: T) => void;
  /** Minimum horizontal distance (px) to trigger a swipe. Default 50 */
  threshold?: number;
  /** Maximum vertical distance (px) allowed — prevents triggering on scroll. Default 80 */
  maxVertical?: number;
}

/**
 * Instagram-style horizontal swipe to change tabs.
 * Attach the returned `ref` to the swipeable content container
 * and spread `handlers` onto it.
 */
export function useSwipeTabs<T extends string>({
  tabs,
  activeTab,
  onChangeTab,
  threshold = 50,
  maxVertical = 80,
}: UseSwipeTabsOptions<T>) {
  const startX = useRef(0);
  const startY = useRef(0);
  const swiping = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    swiping.current = true;
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!swiping.current) return;
      swiping.current = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX.current;
      const dy = Math.abs(touch.clientY - startY.current);

      if (dy > maxVertical || Math.abs(dx) < threshold) return;

      const idx = tabs.indexOf(activeTab);
      if (dx < -threshold && idx < tabs.length - 1) {
        // swipe left → next tab
        onChangeTab(tabs[idx + 1]);
      } else if (dx > threshold && idx > 0) {
        // swipe right → previous tab
        onChangeTab(tabs[idx - 1]);
      }
    },
    [tabs, activeTab, onChangeTab, threshold, maxVertical],
  );

  return { onTouchStart, onTouchEnd };
}
