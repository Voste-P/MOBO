import { useRef, useState, useEffect } from 'react';

/**
 * Tracks whether a DOM element is visible in the viewport.
 * Useful for lazy-loading dashboard widgets — only fetch data when the component
 * enters the user's view (IntersectionObserver-powered).
 *
 * @param options.threshold  Fraction of element visible before triggering (default 0).
 * @param options.rootMargin  Margin around the root for preloading (default '200px').
 * @param options.once  If true, unobserve after first intersection (default true).
 */
export function useIntersectionObserver<T extends HTMLElement = HTMLDivElement>(
  options: { threshold?: number; rootMargin?: string; once?: boolean } = {},
) {
  const { threshold = 0, rootMargin = '200px', once = true } = options;
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      // SSR / old browser fallback — treat as always visible
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          if (once) observer.unobserve(el);
        } else if (!once) {
          setIsVisible(false);
        }
      },
      { threshold, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold, rootMargin, once]);

  return { ref, isVisible };
}
