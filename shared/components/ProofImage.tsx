import React, { useState, useEffect, useRef } from 'react';
import { ZoomableImage } from './ZoomableImage';
import { readTokens } from '../services/api';
import { getApiBaseUrl } from '../utils/apiBaseUrl';
import { ImageIcon, RefreshCw } from 'lucide-react';

type ProofType = 'order' | 'payment' | 'rating' | 'review' | 'returnWindow';

/**
 * Authenticated proof-image loader.
 *
 * The list endpoints return lightweight summaries that do NOT include
 * the actual base64 screenshot data (each image is 100 KB – 5 MB).
 * Instead, the summary includes `screenshots.order = "exists"` etc.
 *
 * `ProofImage` fetches the binary image via the authenticated
 * `GET /orders/:id/proof/:type` endpoint, converts it to a Blob URL,
 * and renders it inside `<ZoomableImage>`.
 *
 * If `existingSrc` is already a `data:` or `blob:` URI (e.g. right after
 * upload when the full order was returned), it is used directly — no fetch.
 */
export const ProofImage: React.FC<{
  orderId: string;
  proofType: ProofType;
  /** Existing screenshot value — may be base64 data URI from a fresh upload */
  existingSrc?: string | null;
  alt: string;
  className?: string;
}> = ({ orderId, proofType, existingSrc, alt, className }) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const mountedRef = useRef(true);
  const blobUrlRef = useRef<string | null>(null);

  // If existingSrc is already a loadable data URI or blob, skip the fetch
  const isDirectSrc =
    existingSrc &&
    (existingSrc.startsWith('data:') || existingSrc.startsWith('blob:') || existingSrc.startsWith('http'));

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (isDirectSrc) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const fetchProof = async () => {
      setLoading(true);
      setError(false);
      try {
        const tokens = readTokens();
        const headers: Record<string, string> = {};
        if (tokens?.accessToken) {
          headers['Authorization'] = `Bearer ${tokens.accessToken}`;
        }

        const apiBase = getApiBaseUrl();
        // The proof endpoint uses lowercase 'returnwindow' in the route param
        const typeParam = proofType === 'returnWindow' ? 'returnwindow' : proofType;
        const url = `${apiBase}/orders/${encodeURIComponent(orderId)}/proof/${typeParam}`;

        const res = await fetch(url, { headers, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const blob = await res.blob();
        if (!cancelled && mountedRef.current) {
          setBlobUrl((prev) => {
            // Revoke previous blob URL if any
            if (prev) URL.revokeObjectURL(prev);
            const newUrl = URL.createObjectURL(blob);
            blobUrlRef.current = newUrl;
            return newUrl;
          });
          setLoading(false);
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setError(true);
          setLoading(false);
        }
      }
    };

    fetchProof();

    return () => {
      cancelled = true;
    };
  }, [orderId, proofType, isDirectSrc, retryCount]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []); // cleanup only on unmount

  // Direct data URI path — no fetch needed
  if (isDirectSrc) {
    return <ZoomableImage src={existingSrc!} alt={alt} className={className} />;
  }

  // Loading state
  if (loading) {
    return (
      <div
        className={`${className || 'w-full h-auto rounded-xl max-h-[60dvh] border border-slate-100 flex items-center justify-center bg-gradient-to-r from-slate-100 via-slate-200 to-slate-100 animate-pulse'} min-h-[120px]`}
      >
        <ImageIcon size={32} className="text-slate-300" />
      </div>
    );
  }

  // Error state — with retry button
  if (error || !blobUrl) {
    return (
      <div
        className={`${className || 'w-full h-auto rounded-xl max-h-[60dvh] border border-dashed border-slate-200 flex flex-col items-center justify-center gap-2 bg-slate-50 text-slate-400 p-4'} min-h-[80px]`}
      >
        <ImageIcon size={24} className="text-slate-300" />
        <span className="text-xs font-bold">Failed to load proof</span>
        <button
          type="button"
          onClick={() => setRetryCount((c) => c + 1)}
          className="flex items-center gap-1 text-[10px] font-bold text-blue-500 hover:text-blue-700 transition-colors"
        >
          <RefreshCw size={10} /> Retry
        </button>
      </div>
    );
  }

  return <ZoomableImage src={blobUrl} alt={alt} className={className} />;
};
