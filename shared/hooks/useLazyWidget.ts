import { useRef, useState, useCallback, useEffect } from 'react';
import { useIntersectionObserver } from './useIntersectionObserver';

/**
 * Hook for viewport-based lazy-loaded dashboard widgets.
 * Only triggers the fetch function when the widget enters the viewport
 * (or immediately if `eager` is true). Caches the result and avoids
 * duplicate in-flight requests.
 *
 * @param fetchFn  Async function that returns the widget data.
 * @param options.eager  Skip viewport check and fetch immediately (default false).
 * @param options.deps   Extra dependencies that, when changed, trigger a re-fetch.
 */
export function useLazyWidget<T>(
  fetchFn: () => Promise<T>,
  options: { eager?: boolean; deps?: any[] } = {},
) {
  const { eager = false, deps = [] } = options;
  const { ref, isVisible } = useIntersectionObserver<HTMLDivElement>({
    rootMargin: '300px',
    once: true,
  });

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);
  const inFlightRef = useRef(false);
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  const doFetch = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFnRef.current();
      setData(result);
      fetchedRef.current = true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  const refetch = useCallback(async () => {
    fetchedRef.current = false;
    await doFetch();
  }, [doFetch]);

  // Trigger fetch when visible or eager
  const shouldFetch = eager || isVisible;
  useEffect(() => {
    if (!shouldFetch || fetchedRef.current) return;
    doFetch();
  }, [shouldFetch, doFetch, ...deps]);

  return { ref, data, loading, error, refetch, isVisible };
}
