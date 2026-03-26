import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Lazy-load a component with automatic retry on chunk load failure.
 *
 * On Vercel (and other CDN-backed hosts) a new deployment changes chunk
 * hashes. Browsers that cached the previous HTML will try to load chunk
 * URLs that no longer exist, causing a `ChunkLoadError`. Retrying after
 * a brief delay usually resolves it because the browser re-fetches the
 * updated chunk manifest.
 */
export function lazyRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  retries = 2,
): LazyExoticComponent<T> {
  return lazy(async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await factory();
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw new Error('Module load failed after retries');
  });
}
