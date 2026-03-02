import React from 'react';
import { ExternalLink, Star, ShoppingBag } from 'lucide-react';
import { Product } from '../types';
import { ProxiedImage, placeholderImage } from './ProxiedImage';

interface ProductCardProps {
  product: Product;
  onPlaceOrder?: (product: Product) => void;
}

// Allow React's special props (e.g. `key`) without leaking them into runtime.
type ProductCardComponentProps = React.Attributes & ProductCardProps;

const sanitizeLabel = (value: unknown) => String(value || '').replace(/["\\]/g, '').trim();

export const ProductCard = React.memo<ProductCardComponentProps>(({ product, onPlaceOrder }) => {
  const rawImage = sanitizeLabel(product.image);
  const imageSrc = rawImage || placeholderImage;
  const platformLabel = sanitizeLabel(product.platform) || 'DEAL';
  const brandLabel = sanitizeLabel(product.brandName) || 'PARTNER';
  const mediatorLabel = sanitizeLabel(product.mediatorName || product.mediatorCode) || 'PARTNER';
  const effectiveOriginal =
    product.originalPrice > product.price ? product.originalPrice : null;

  const handleLinkClick = () => {
    if (product.productUrl && /^https?:\/\//i.test(product.productUrl)) {
      window.open(product.productUrl, '_blank', 'noopener,noreferrer');
    } else if (product.productUrl) {
      console.warn('Blocked non-HTTP URL:', product.productUrl);
    } else {
      console.warn('No redirection link found for this product.');
    }
  };

  return (
    <div className="flex-shrink-0 w-[300px] bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 snap-center flex flex-col relative overflow-hidden group transition-all duration-300 hover:shadow-xl hover:-translate-y-1">
      {/* Platform Tag (Top Right) */}
      <div className="absolute top-4 right-4 bg-zinc-800 text-white text-[10px] font-bold px-2 py-1 rounded shadow-sm uppercase tracking-wider z-10">
        {platformLabel}
      </div>

      {/* Deal Type Badge (Top Left) */}
      {product.dealType && (
        <div className={`absolute top-4 left-4 text-[10px] font-bold px-2 py-1 rounded shadow-sm uppercase tracking-wider z-10 ${
          product.dealType === 'Rating' ? 'bg-orange-500 text-white' :
          product.dealType === 'Review' ? 'bg-purple-500 text-white' :
          'bg-lime-500 text-white'
        }`}>
          {product.dealType === 'Discount' ? 'Order' : product.dealType}
        </div>
      )}

      {/* Top Section: Image & Key Info */}
      <div className="flex gap-4 mb-4">
        <div className="w-24 h-24 rounded-2xl bg-gray-50 border border-gray-100 p-2 flex-shrink-0 flex items-center justify-center relative">
            <ProxiedImage
              src={imageSrc}
              alt={product.title}
              className="w-full h-full object-contain mix-blend-multiply"
            />
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center py-1">
          <h3
            className="font-bold text-slate-900 text-sm leading-tight line-clamp-2 mb-2"
            title={product.title}
          >
            {product.title}
          </h3>

          <div className="flex items-center gap-1 mb-1">
            <div className="flex text-yellow-400">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={`star-${i}`}
                  size={10}
                  fill={i < Math.floor(product.rating || 5) ? 'currentColor' : 'none'}
                  strokeWidth={0}
                />
              ))}
            </div>
            <span className="text-[10px] font-bold text-slate-400">({product.rating || 5})</span>
          </div>

          <div>
            <p className="text-xl font-extrabold text-lime-600 leading-none">
              ₹{product.price.toLocaleString('en-IN')}
            </p>
          </div>
        </div>
      </div>

      {/* Description Box (Technical / Monospace Style) */}
      <div className="bg-slate-50 rounded-xl p-3 mb-3 border border-slate-100 relative font-mono text-[10px] text-slate-500 leading-relaxed break-words">
        <div className="mb-1">
          <span className="text-indigo-600 font-bold">"{brandLabel}"</span> - {platformLabel} Deal.
        </div>
        <div className="mb-2">
          Exclusive Offer via{' '}
          <span className="text-slate-900 font-bold uppercase">
            {mediatorLabel}
          </span>
          .
        </div>
        <div className="pt-2 border-t border-slate-200 border-dashed flex justify-between items-center">
          {effectiveOriginal ? (
            <>
              <span>Original Price:</span>
              <span className="text-slate-900 font-bold decoration-slice line-through">
                ₹{effectiveOriginal.toLocaleString('en-IN')}
              </span>
            </>
          ) : (
            <span className="text-lime-600 font-bold">Best Price</span>
          )}
        </div>

        {/* Decorative 'Online' Dot */}
        <div className="absolute top-3 right-3 w-1.5 h-1.5 rounded-full bg-lime-500 animate-pulse"></div>
      </div>

      {/* Action Buttons */}
      <button
        onClick={handleLinkClick}
        className="w-full py-3.5 bg-black text-white font-extrabold rounded-xl text-xs uppercase tracking-wider shadow-lg shadow-zinc-900/10 active:scale-95 transition-all flex items-center justify-center gap-2 group-hover:bg-zinc-800"
      >
        <ExternalLink size={14} className="stroke-[3]" /> GET DEAL LINK
      </button>
      {onPlaceOrder && (
        <button
          onClick={() => onPlaceOrder(product)}
          className="w-full mt-2 py-3 bg-lime-500 text-white font-extrabold rounded-xl text-xs uppercase tracking-wider shadow-lg shadow-lime-500/20 active:scale-95 transition-all flex items-center justify-center gap-2 hover:bg-lime-600"
        >
          <ShoppingBag size={14} className="stroke-[3]" /> PLACE ORDER
        </button>
      )}
    </div>
  );
});
ProductCard.displayName = 'ProductCard';
