import React, { useState, useRef, useCallback } from 'react';
import { ExternalLink, Star, ShoppingBag, Camera, X, Loader2, CheckCircle, Upload, AlertCircle, UserCircle, Lock, Pencil } from 'lucide-react';
import { Product } from '../types';
import { ProxiedImage, placeholderImage } from './ProxiedImage';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';
import { checkProductNameMatch, checkReviewerNameMatch } from '../utils/productNameMatch';

interface ProductCardProps {
  product: Product;
  onPlaceOrder?: (product: Product) => void;
  /** When true, show inline order form instead of modal */
  inlineOrder?: boolean;
}

// Allow React's special props (e.g. `key`) without leaking them into runtime.
type ProductCardComponentProps = React.Attributes & ProductCardProps;

const sanitizeLabel = (value: unknown) => String(value || '').replace(/["\\]/g, '').trim();

const sanitizeImageUrl = (url: unknown): string => {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return /^\/[^/]/.test(s) ? s : '';
  }
};

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

  const imageSrc = sanitizeImageUrl(product.image) || placeholderImage;
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
    accountName?: string;
  }>({ orderId: '', amount: '' });
  const [reviewerName, setReviewerName] = useState('');
  const [fieldsLocked, setFieldsLocked] = useState(false);
  const [productNameMismatch, setProductNameMismatch] = useState(false);
  const [platformMismatch, setPlatformMismatch] = useState(false);
  const [reviewerNameMismatch, setReviewerNameMismatch] = useState(false);
  const [titleExpanded, setTitleExpanded] = useState(false);

  const resetForm = useCallback(() => {
    setScreenshot(null);
    setPreview(null);
    setExtracting(false);
    setSubmitting(false);
    setSubmitted(false);
    setExtractedDetails({ orderId: '', amount: '' });
    setReviewerName('');
    setFieldsLocked(false);
    setProductNameMismatch(false);
    setReviewerNameMismatch(false);
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
    setProductNameMismatch(false);
    setPlatformMismatch(false);
    setReviewerNameMismatch(false);
    try {
      const result = await api.orders.extractDetails(file);
      if (result) {
        setExtractedDetails({
          orderId: result.orderId || '',
          amount: result.amount || '',
          orderDate: result.orderDate || undefined,
          soldBy: result.soldBy || undefined,
          productName: result.productName || undefined,
          accountName: result.accountName || undefined,
        });
        // Lock fields only when BOTH required fields are extracted
        if (result.orderId && result.amount) setFieldsLocked(true);

        // ── Product name matching (shared strict algorithm) ──
        const nameMatchResult = checkProductNameMatch(result.productName, product.title);
        if (nameMatchResult === 'mismatch') {
          setProductNameMismatch(true);
          toast.error('Product name in screenshot does not match this deal. Please upload the correct order screenshot.');
        }
        // ── Platform matching ──
        if (result.platform && product?.platform) {
          const extractedPlatform = String(result.platform).toLowerCase().trim();
          const expectedPlatform = String(product.platform).toLowerCase().trim();
          if (extractedPlatform && expectedPlatform && extractedPlatform !== 'unknown' && extractedPlatform !== expectedPlatform) {
            setPlatformMismatch(true);
            toast.error(`Screenshot appears to be from ${result.platform}, but this deal is for ${product.platform}. Please upload the correct screenshot.`);
          }
        }
        // ── Reviewer name matching against extracted account name ──
        if (result.accountName && reviewerName.trim()) {
          const rnMatch = checkReviewerNameMatch(reviewerName, result.accountName);
          setReviewerNameMismatch(rnMatch === 'mismatch');
        }
      }
    } catch {
      // Extraction is optional — notify user gracefully
      toast.info('Could not auto-extract details. You can enter them manually.');
    } finally {
      setExtracting(false);
    }
  }, [toast]);

  const handleInlineSubmit = useCallback(async () => {
    if (!user || !screenshot || submitting) return;
    // Block if product name mismatch detected
    if (productNameMismatch) {
      toast.error('Product in screenshot does not match this deal. Upload the correct order screenshot.');
      return;
    }
    // Block if platform mismatch detected
    if (platformMismatch) {
      toast.error('Screenshot is from a different platform. Upload the correct order screenshot.');
      return;
    }
    // Block if reviewer name mismatch detected
    if (reviewerNameMismatch) {
      toast.error('Reviewer name does not match the account in screenshot. Please correct it.');
      return;
    }
    // Require reviewer name for Rating/Review deals to prevent cheating
    if ((product.dealType === 'Rating' || product.dealType === 'Review') && !reviewerName.trim()) {
      toast.error('Please enter the reviewer name — the marketplace account name used for this order.');
      return;
    }
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
          reviewerName: reviewerName.trim() || undefined,
        },
      );

      setSubmitted(true);
      toast.success('Order submitted! Track it in the Orders tab.');
      setTimeout(resetForm, 1500);
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Failed to submit order. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }, [user, screenshot, submitting, productNameMismatch, reviewerNameMismatch, extractedDetails, product, reviewerName, toast, resetForm]);

  const handleLinkClick = () => {
    if (product.productUrl && /^https?:\/\//i.test(product.productUrl)) {
      window.open(product.productUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="flex-shrink-0 w-[300px] bg-white rounded-[1.5rem] p-4 shadow-sm border border-gray-100 snap-center flex flex-col relative overflow-hidden group transition-all duration-300 hover:shadow-xl hover:-translate-y-1 active:scale-[0.98]">
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
        <div className="w-28 h-28 rounded-2xl bg-gray-50 border border-gray-100 p-2 flex-shrink-0 flex items-center justify-center relative">
            <ProxiedImage
              src={imageSrc}
              alt={product.title}
              className="w-full h-full object-contain mix-blend-multiply"
            />
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center py-1">
          <h3
            className={`font-bold text-slate-900 text-sm leading-tight mb-2 cursor-pointer ${titleExpanded ? '' : 'line-clamp-2'}`}
            title={titleExpanded ? undefined : product.title}
            onClick={() => setTitleExpanded(!titleExpanded)}
          >
            {product.title}
          </h3>

          <div className="flex items-center gap-1 mb-1">
            <div className="flex text-yellow-400">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={`star-${i}`}
                  size={12}
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
        <div className="absolute top-3 right-3 w-2 h-2 rounded-full bg-lime-500 animate-pulse shadow-lg shadow-lime-500/50"></div>
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
              className="w-full py-6 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center gap-1.5 hover:border-lime-400 hover:bg-lime-50/50 transition-all duration-200"
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
                aria-label="Remove screenshot"
                onClick={() => { setScreenshot(null); setPreview(null); setExtractedDetails({ orderId: '', amount: '' }); setFieldsLocked(false); }}
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
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} aria-label="Upload order screenshot" />

          {/* Order Details — ALWAYS shown after screenshot upload */}
          {preview && !extracting && (
            <div className="space-y-2 animate-in slide-in-from-bottom-2">
              {/* AI status indicator */}
              {(extractedDetails.orderId || extractedDetails.amount || extractedDetails.productName || extractedDetails.soldBy || extractedDetails.orderDate) ? (
                <div className="flex items-center justify-between px-2 py-1.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle size={10} className="text-emerald-600 flex-shrink-0" />
                    <p className="text-[9px] font-bold text-emerald-700">{fieldsLocked ? 'AI extracted — tap edit to correct' : 'Editing — tap lock when done'}</p>
                  </div>
                  <button type="button" onClick={() => setFieldsLocked(!fieldsLocked)} className="p-1 rounded-md hover:bg-emerald-100 transition-colors" aria-label={fieldsLocked ? 'Edit fields' : 'Lock fields'}>
                    {fieldsLocked ? <Pencil size={10} className="text-emerald-600" /> : <Lock size={10} className="text-emerald-600" />}
                  </button>
                </div>
              ) : (
                <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                  <AlertCircle size={11} className="text-amber-500 mt-0.5 flex-shrink-0" />
                  <p className="text-[9px] text-amber-700">Could not auto-detect. Please fill in manually.</p>
                </div>
              )}

              {/* All 5 editable fields — always visible */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1.5">
                <p className="text-[8px] font-extrabold text-slate-500 uppercase tracking-wider">Order Details</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="text-[8px] font-bold text-slate-500 uppercase">Order ID *</label>
                    <input
                      type="text"
                      value={extractedDetails.orderId}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, orderId: e.target.value }))}
                      disabled={fieldsLocked}
                      placeholder="e.g. 408-1234567-8901234"
                      className={`w-full mt-0.5 px-1.5 py-1 text-[10px] font-medium border rounded outline-none transition-all ${fieldsLocked ? 'bg-emerald-50 border-emerald-200 text-emerald-800 cursor-not-allowed' : 'bg-white border-gray-300 focus:ring-1 focus:ring-lime-300 focus:border-lime-400'}`}
                    />
                  </div>
                  <div>
                    <label className="text-[8px] font-bold text-slate-500 uppercase">Amount (₹) *</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={extractedDetails.amount}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, amount: e.target.value }))}
                      disabled={fieldsLocked}
                      placeholder="e.g. 1044"
                      className={`w-full mt-0.5 px-1.5 py-1 text-[10px] font-medium border rounded outline-none transition-all ${fieldsLocked ? 'bg-emerald-50 border-emerald-200 text-emerald-800 cursor-not-allowed' : 'bg-white border-gray-300 focus:ring-1 focus:ring-lime-300 focus:border-lime-400'}`}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[8px] font-bold text-slate-500 uppercase">Product Name</label>
                  <input
                    type="text"
                    readOnly
                    value={extractedDetails.productName || ''}
                    placeholder="Auto-detected from screenshot"
                    className={`w-full mt-0.5 px-1.5 py-1 text-[10px] font-medium border rounded outline-none transition-all cursor-default ${
                      !extractedDetails.productName ? 'bg-white border-gray-300' :
                      productNameMismatch ? 'bg-red-50 border-red-400 text-red-700 ring-1 ring-red-200' :
                      'bg-emerald-50 border-emerald-200 text-emerald-800'
                    }`}
                  />
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="text-[8px] font-bold text-slate-500 uppercase">Seller / Sold By</label>
                    <input
                      type="text"
                      value={extractedDetails.soldBy || ''}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, soldBy: e.target.value }))}
                      disabled={fieldsLocked}
                      placeholder="e.g. Cloudtail India"
                      className={`w-full mt-0.5 px-1.5 py-1 text-[10px] font-medium border rounded outline-none transition-all ${fieldsLocked ? 'bg-emerald-50 border-emerald-200 text-emerald-800 cursor-not-allowed' : 'bg-white border-gray-300 focus:ring-1 focus:ring-lime-300 focus:border-lime-400'}`}
                    />
                  </div>
                  <div>
                    <label className="text-[8px] font-bold text-slate-500 uppercase">Order Date</label>
                    <input
                      type="text"
                      value={extractedDetails.orderDate || ''}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, orderDate: e.target.value }))}
                      disabled={fieldsLocked}
                      placeholder="e.g. 15 Jan 2026"
                      className={`w-full mt-0.5 px-1.5 py-1 text-[10px] font-medium border rounded outline-none transition-all ${fieldsLocked ? 'bg-emerald-50 border-emerald-200 text-emerald-800 cursor-not-allowed' : 'bg-white border-gray-300 focus:ring-1 focus:ring-lime-300 focus:border-lime-400'}`}
                    />
                  </div>
                </div>
              </div>

              {/* Reviewer Name */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1">
                <label className="text-[8px] font-extrabold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                  <UserCircle size={10} /> Reviewer / Account Name
                  {(product.dealType === 'Rating' || product.dealType === 'Review') && <span className="text-red-400">*</span>}
                </label>
                <input
                  type="text"
                  value={reviewerName}
                  onChange={(e) => {
                    const val = e.target.value;
                    setReviewerName(val);
                    if (extractedDetails.accountName && val.trim()) {
                      setReviewerNameMismatch(checkReviewerNameMatch(val, extractedDetails.accountName) === 'mismatch');
                    } else {
                      setReviewerNameMismatch(false);
                    }
                  }}
                  placeholder="e.g. Chetan on Amazon"
                  maxLength={200}
                  className={`w-full px-1.5 py-1 text-[10px] font-medium border rounded bg-white focus:ring-1 outline-none transition-all ${
                    reviewerNameMismatch
                      ? 'border-red-400 focus:ring-red-300 focus:border-red-400'
                      : extractedDetails.accountName && reviewerName.trim() && !reviewerNameMismatch
                        ? 'border-green-400 focus:ring-green-300 focus:border-green-400'
                        : 'border-gray-300 focus:ring-lime-300 focus:border-lime-400'
                  }`}
                />
                {reviewerNameMismatch && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <AlertCircle size={9} className="text-red-500 flex-shrink-0" />
                    <p className="text-[8px] font-bold text-red-600">
                      Account name mismatch — screenshot shows &quot;{extractedDetails.accountName}&quot;
                    </p>
                  </div>
                )}
                <p className="text-[8px] text-zinc-400">
                  Enter the name shown on the marketplace account used for this order.
                  {(product.dealType === 'Rating' || product.dealType === 'Review') && <span className="text-red-400 font-bold"> Required</span>}
                </p>
              </div>
            </div>
          )}

          {/* Submit + Cancel */}
          <div className="space-y-1.5">
            {screenshot && !extracting && !extractedDetails.orderId && (
              <p className="text-[9px] text-red-500 font-semibold text-center">Order ID is required to submit</p>
            )}
            {productNameMismatch && (
              <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                <AlertCircle size={11} className="text-red-500 flex-shrink-0" />
                <p className="text-[9px] font-bold text-red-600">Product name mismatch — this screenshot is for a different product.</p>
              </div>
            )}
            {platformMismatch && (
              <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                <AlertCircle size={11} className="text-red-500 flex-shrink-0" />
                <p className="text-[9px] font-bold text-red-600">Platform mismatch — this screenshot is from a different platform.</p>
              </div>
            )}
            {reviewerNameMismatch && (
              <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                <AlertCircle size={11} className="text-amber-500 flex-shrink-0" />
                <p className="text-[9px] font-bold text-amber-700">Reviewer name doesn&apos;t match the account in screenshot.</p>
              </div>
            )}
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
                disabled={!screenshot || submitting || extracting || !extractedDetails.orderId.trim() || productNameMismatch || platformMismatch || reviewerNameMismatch}
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
