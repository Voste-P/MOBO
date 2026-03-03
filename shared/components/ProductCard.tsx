import React, { useState, useRef, useCallback } from 'react';
import { ExternalLink, Star, ShoppingBag, Camera, X, Loader2, CheckCircle, Upload } from 'lucide-react';
import { Product } from '../types';
import { ProxiedImage, placeholderImage } from './ProxiedImage';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

interface ProductCardProps {
  product: Product;
  onPlaceOrder?: (product: Product) => void;
  /** When true, show inline order form instead of modal */
  inlineOrder?: boolean;
}

// Allow React's special props (e.g. `key`) without leaking them into runtime.
type ProductCardComponentProps = React.Attributes & ProductCardProps;

const sanitizeLabel = (value: unknown) => String(value || '').replace(/["\\]/g, '').trim();

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('Failed to read file'));
    r.readAsDataURL(file);
  });

const VALID_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/jpg']);

export const ProductCard = React.memo<ProductCardComponentProps>(({ product, onPlaceOrder, inlineOrder }) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rawImage = sanitizeLabel(product.image);
  const imageSrc = rawImage || placeholderImage;
  const platformLabel = sanitizeLabel(product.platform) || 'DEAL';
  const brandLabel = sanitizeLabel(product.brandName) || 'PARTNER';
  const mediatorLabel = sanitizeLabel(product.mediatorName || product.mediatorCode) || 'PARTNER';
  const effectiveOriginal =
    product.originalPrice > product.price ? product.originalPrice : null;

  // ── Inline order form state ──
  const [formOpen, setFormOpen] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [extractedDetails, setExtractedDetails] = useState<{
    orderId: string;
    amount: string;
    orderDate?: string;
    soldBy?: string;
    productName?: string;
  }>({ orderId: '', amount: '' });

  const resetForm = useCallback(() => {
    setScreenshot(null);
    setPreview(null);
    setExtracting(false);
    setSubmitting(false);
    setSubmitted(false);
    setExtractedDetails({ orderId: '', amount: '' });
    setFormOpen(false);
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!VALID_TYPES.has(file.type)) {
      toast.error('Please upload a JPG, PNG, or WebP image.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be under 10 MB.');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    setScreenshot(dataUrl);
    setPreview(dataUrl);

    // AI extraction
    setExtracting(true);
    try {
      const result = await api.orders.extractDetails(file);
      if (result) {
        setExtractedDetails({
          orderId: result.orderId || '',
          amount: result.amount || '',
          orderDate: result.orderDate || undefined,
          soldBy: result.soldBy || undefined,
          productName: result.productName || undefined,
        });
      }
    } catch {
      // Extraction is optional
    } finally {
      setExtracting(false);
    }
  }, [toast]);

  const handleInlineSubmit = useCallback(async () => {
    if (!user || !screenshot || submitting) return;
    setSubmitting(true);
    try {
      const parsedAmount =
        extractedDetails.amount && !isNaN(parseFloat(extractedDetails.amount))
          ? parseFloat(extractedDetails.amount)
          : product.price;

      await api.orders.create(
        user.id,
        [
          {
            productId: product.id,
            title: product.title,
            image: product.image,
            priceAtPurchase: parsedAmount,
            commission: product.commission,
            campaignId: product.campaignId,
            dealType: product.dealType,
            quantity: 1,
            platform: product.platform,
            brandName: product.brandName,
          },
        ],
        {
          screenshots: { order: screenshot },
          externalOrderId: extractedDetails.orderId || undefined,
          orderDate: extractedDetails.orderDate || undefined,
          soldBy: extractedDetails.soldBy || undefined,
          extractedProductName: extractedDetails.productName || undefined,
        },
      );

      setSubmitted(true);
      toast.success('Order submitted! Track it in the Orders tab.');
      setTimeout(resetForm, 1500);
    } catch (err: any) {
      toast.error(String(err?.message || 'Failed to submit order. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }, [user, screenshot, submitting, extractedDetails, product, toast, resetForm]);

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

      {/* Inline order form (when inlineOrder=true) */}
      {inlineOrder && !formOpen && !submitted && (
        <button
          onClick={() => setFormOpen(true)}
          className="w-full mt-2 py-3 bg-lime-500 text-white font-extrabold rounded-xl text-xs uppercase tracking-wider shadow-lg shadow-lime-500/20 active:scale-95 transition-all flex items-center justify-center gap-2 hover:bg-lime-600"
        >
          <ShoppingBag size={14} className="stroke-[3]" /> ORDER FORM
        </button>
      )}

      {inlineOrder && formOpen && !submitted && (
        <div className="mt-3 border-t border-gray-100 pt-3 space-y-3 animate-in slide-in-from-bottom-2">
          {/* Upload Area */}
          {!preview ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-6 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center gap-1.5 hover:border-lime-400 hover:bg-lime-50/30 transition-all"
            >
              <Camera size={22} className="text-gray-400" />
              <span className="text-[11px] font-bold text-gray-500">Upload order screenshot</span>
              <span className="text-[9px] text-gray-400">JPG, PNG, WebP &bull; Max 10 MB</span>
            </button>
          ) : (
            <div className="relative rounded-xl border border-gray-200 overflow-hidden">
              <img src={preview} alt="Order proof" loading="lazy" className="w-full max-h-32 object-contain bg-gray-50" />
              <button
                type="button"
                onClick={() => { setScreenshot(null); setPreview(null); setExtractedDetails({ orderId: '', amount: '' }); }}
                className="absolute top-1.5 right-1.5 p-1 bg-white/90 rounded-full shadow hover:bg-red-50 transition"
              >
                <X size={12} className="text-red-500" />
              </button>
              {extracting && (
                <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                  <Loader2 size={18} className="text-lime-600 animate-spin" />
                  <span className="ml-1.5 text-[10px] font-bold text-slate-600">Analyzing...</span>
                </div>
              )}
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />

          {/* AI Extracted Details */}
          {(extractedDetails.orderId || extractedDetails.amount) && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 space-y-1.5">
              <p className="text-[9px] font-bold text-emerald-700 flex items-center gap-1">
                <CheckCircle size={10} /> AI Detected
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {extractedDetails.orderId && (
                  <div>
                    <label className="text-[8px] font-bold text-emerald-600 uppercase">Order ID</label>
                    <input
                      type="text"
                      value={extractedDetails.orderId}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, orderId: e.target.value }))}
                      className="w-full mt-0.5 px-1.5 py-1 text-[10px] border border-emerald-200 rounded bg-white focus:ring-1 focus:ring-emerald-400 outline-none"
                    />
                  </div>
                )}
                {extractedDetails.amount && (
                  <div>
                    <label className="text-[8px] font-bold text-emerald-600 uppercase">Amount (₹)</label>
                    <input
                      type="text"
                      value={extractedDetails.amount}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, amount: e.target.value }))}
                      className="w-full mt-0.5 px-1.5 py-1 text-[10px] border border-emerald-200 rounded bg-white focus:ring-1 focus:ring-emerald-400 outline-none"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Submit + Cancel */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resetForm}
              className="flex-1 py-2.5 text-xs font-bold text-gray-500 bg-gray-100 rounded-xl hover:bg-gray-200 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleInlineSubmit}
              disabled={!screenshot || submitting || extracting}
              className="flex-1 py-2.5 bg-black text-white font-extrabold rounded-xl text-xs uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all flex items-center justify-center gap-1.5"
            >
              {submitting ? (
                <><Loader2 size={12} className="animate-spin" /> Submitting...</>
              ) : (
                <><Upload size={12} /> Submit</>
              )}
            </button>
          </div>
        </div>
      )}

      {inlineOrder && submitted && (
        <div className="mt-3 flex items-center justify-center gap-2 py-3 text-lime-600">
          <CheckCircle size={16} />
          <span className="font-bold text-xs">Order Submitted!</span>
        </div>
      )}

      {/* Fallback: modal trigger when not inline */}
      {!inlineOrder && onPlaceOrder && (
        <button
          onClick={() => onPlaceOrder(product)}
          className="w-full mt-2 py-3 bg-lime-500 text-white font-extrabold rounded-xl text-xs uppercase tracking-wider shadow-lg shadow-lime-500/20 active:scale-95 transition-all flex items-center justify-center gap-2 hover:bg-lime-600"
        >
          <ShoppingBag size={14} className="stroke-[3]" /> ORDER FORM
        </button>
      )}
    </div>
  );
});
ProductCard.displayName = 'ProductCard';
