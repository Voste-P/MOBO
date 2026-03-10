'use client';

import { useEffect } from 'react';

export function DisableNumberScroll() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = document.activeElement;
      if (!el) return;
      if (el instanceof HTMLInputElement && el.type === 'number' && !el.dataset.allowNumberScroll) {
        e.preventDefault();
      }
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  return null;
}
