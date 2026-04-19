'use client';

import { useEffect } from 'react';

export function DisableNumberScroll() {
  useEffect(() => {
    const onWheel = () => {
      const el = document.activeElement;
      if (!el) return;
      if (el instanceof HTMLInputElement && el.type === 'number' && !el.dataset.allowNumberScroll) {
        el.blur();
      }
    };

    window.addEventListener('wheel', onWheel, { passive: true });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  return null;
}
