import React, { useCallback, useState } from 'react';
import { getApiBaseAbsolute } from '../utils/apiBaseUrl';

/* ─────────────────────────────────────────────────────────
 * ProxiedImage — drop-in <img> replacement for product/order images.
 *
 * • Routes external URLs through `/api/media/image?url=…` to bypass
 *   hotlink protection on Amazon, Flipkart, etc.
 * • Shows an SVG placeholder on error (never a broken-image icon).
 * • Adds native lazy loading by default.
 * ────────────────────────────────────────────────────────── */

const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" rx="24" fill="#F3F4F6"/>' +
      '<circle cx="80" cy="64" r="24" fill="#E5E7EB"/>' +
      '<rect x="32" y="104" width="96" height="16" rx="8" fill="#E5E7EB"/>' +
    '</svg>'
  );

/** Convert a raw image URL to a backend-proxied URL (if external). */
export function proxyImageUrl(raw: string | null | undefined): string {
  if (!raw) return PLACEHOLDER;
  const trimmed = String(raw).replace(/["\\]/g, '').trim();
  if (!trimmed) return PLACEHOLDER;
  if (/^https?:\/\//i.test(trimmed)) {
    return `${getApiBaseAbsolute()}/media/image?url=${encodeURIComponent(trimmed)}`;
  }
  return trimmed;
}

export interface ProxiedImageProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** Raw image URL — will be proxied if external. */
  src: string | null | undefined;
}

export const ProxiedImage = React.memo<ProxiedImageProps>(
  ({ src, alt = 'Product image', className, ...rest }) => {
    const [errored, setErrored] = useState(false);
    const resolved = errored ? PLACEHOLDER : proxyImageUrl(src);

    const onError = useCallback(() => setErrored(true), []);

    return (
      <img
        loading="lazy"
        decoding="async"
        src={resolved}
        alt={alt}
        className={className}
        onError={onError}
        {...rest}
      />
    );
  },
);
ProxiedImage.displayName = 'ProxiedImage';

export { PLACEHOLDER as placeholderImage };
