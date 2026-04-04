import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ZoomIn, X, ImageIcon } from 'lucide-react';

/**
 * Production-grade image component with:
 * - Lazy loading via IntersectionObserver (only loads when in viewport)
 * - Skeleton shimmer placeholder while loading
 * - Blur-up progressive reveal transition
 * - Click-to-zoom fullscreen overlay
 * - Fallback for broken/missing images
 *
 * Used across all portal proof viewers for screenshot inspection.
 */
export const ZoomableImage: React.FC<{
  src: string;
  alt: string;
  className?: string;
}> = ({ src, alt, className }) => {
  const [zoomed, setZoomed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [inView, setInView] = useState(false);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Lazy-load: observe when the container enters the viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // If IntersectionObserver is unavailable, load immediately
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' } // start loading 200px before entering viewport
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  // Reset state when src changes
  useEffect(() => {
    setLoaded(false);
    setError(false);
  }, [src]);

  const handleLoad = useCallback(() => setLoaded(true), []);
  const handleError = useCallback(() => {
    setError(true);
    setLoaded(true);
  }, []);

  const defaultClass =
    'w-full h-auto rounded-xl max-h-[60dvh] object-contain border border-slate-100';

  return (
    <>
      <div
        ref={containerRef}
        className="relative group cursor-pointer"
        onClick={() => !error && setZoomed(true)}
      >
        {/* Skeleton shimmer placeholder — visible until image loads */}
        {!loaded && (
          <div
            className={`${className || defaultClass} flex items-center justify-center bg-gradient-to-r from-slate-100 via-slate-200 to-slate-100 animate-pulse`}
            style={{ minHeight: 120 }}
          >
            <ImageIcon size={32} className="text-slate-300" />
          </div>
        )}

        {/* Actual image — only rendered once in viewport */}
        {inView && !error && (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            onLoad={handleLoad}
            onError={handleError}
            className={`${className || defaultClass} transition-all duration-500 ${
              loaded ? 'opacity-100 blur-0 scale-100' : 'opacity-0 blur-sm scale-[0.98] absolute inset-0'
            }`}
          />
        )}

        {/* Error fallback */}
        {error && (
          <div
            className={`${className || defaultClass} flex flex-col items-center justify-center gap-2 bg-slate-50 text-slate-400`}
            style={{ minHeight: 120 }}
          >
            <ImageIcon size={32} />
            <span className="text-xs">Image unavailable</span>
          </div>
        )}

        {/* Hover zoom icon */}
        {loaded && !error && (
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-xl flex items-center justify-center">
            <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 backdrop-blur-sm p-2 rounded-full shadow-lg">
              <ZoomIn size={16} className="text-slate-700" />
            </div>
          </div>
        )}
      </div>

      {/* Fullscreen zoom overlay */}
      {zoomed && (
        <div
          role="dialog"
          aria-label={`Zoomed view: ${alt}`}
          aria-modal="true"
          className="fixed inset-0 z-overlay bg-black/95 flex items-center justify-center p-4 cursor-zoom-out animate-fade-in"
          onClick={() => setZoomed(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setZoomed(false); }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <img loading="lazy"
            src={src}
            alt={alt}
            decoding="async"
            className="max-w-full max-h-full object-contain"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              const fallback = e.currentTarget.parentElement?.querySelector('.zoom-fallback') as HTMLElement;
              if (fallback) fallback.style.display = 'flex';
            }}
          />
          <div className="zoom-fallback hidden flex-col items-center justify-center gap-3 text-white/60">
            <ImageIcon size={48} />
            <span className="text-sm">Image unavailable</span>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); setZoomed(false); }}
            aria-label="Close zoomed view"
            className="absolute top-4 right-4 p-2 bg-white/10 rounded-full hover:bg-white/20 transition-colors"
          >
            <X size={20} className="text-white" />
          </button>
        </div>
      )}
    </>
  );
};
