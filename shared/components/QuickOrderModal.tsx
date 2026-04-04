import React, { useState, useRef, useCallback } from 'react';
import { X, Upload, Loader2, CheckCircle, ShoppingBag, Camera, AlertCircle, UserCircle } from 'lucide-react';
import { Product } from '../types';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';
import { ProxiedImage, placeholderImage } from './ProxiedImage';
import { checkProductNameMatch, checkReviewerNameMatch } from '../utils/productNameMatch';
import { ExpandableText } from './ui';

interface QuickOrderModalProps {
  open: boolean;
  product: Product | null;
  onClose: () => void;
  onSuccess?: () => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const VALID_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('Failed to read file'));
    r.readAsDataURL(file);
  });

export const QuickOrderModal: React.FC<QuickOrderModalProps> = React.memo(function QuickOrderModal({ open, product, onClose, onSuccess }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [productNameMismatch, setProductNameMismatch] = useState(false);
  const [reviewerNameMismatch, setReviewerNameMismatch] = useState(false);
  const [platformMismatch, setPlatformMismatch] = useState(false);

  const reset = useCallback(() => {
    setScreenshot(null);
    setPreview(null);
    setExtracting(false);
    setSubmitting(false);
    setSubmitted(false);
    setExtractedDetails({ orderId: '', amount: '' });
    setReviewerName('');
    setProductNameMismatch(false);
    setReviewerNameMismatch(false);
    setPlatformMismatch(false);
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!VALID_TYPES.includes(file.type)) {
      toast.error('Please upload a JPG, PNG, or WebP image.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
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
          accountName: result.accountName || undefined,
        });

        // —— Product name matching (shared strict algorithm) ——
        const nameMatchResult = checkProductNameMatch(result.productName, product?.title);
        if (nameMatchResult === 'mismatch') {
          setProductNameMismatch(true);
          toast.error('Product name in screenshot does not match this deal. Please upload the correct order screenshot.');
        }
        // —— Platform matching ——
        if (result.platform && product?.platform) {
          const extractedPlatform = String(result.platform).toLowerCase().trim();
          const expectedPlatform = String(product.platform).toLowerCase().trim();
          if (extractedPlatform && expectedPlatform && extractedPlatform !== 'unknown' && extractedPlatform !== expectedPlatform) {
            setPlatformMismatch(true);
            toast.error(`Screenshot appears to be from ${result.platform}, but this deal is for ${product.platform}. Please upload the correct screenshot.`);
          }
        }
        // —— Reviewer name matching against extracted account name ——
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
  };

  const handleSubmit = async () => {
    if (!product || !user || !screenshot || submitting) return;
    // Block if product name mismatch detected
    if (productNameMismatch) {
      toast.error('Product in screenshot does not match this deal. Upload the correct order screenshot.');
      return;
    }
    // Block if platform mismatch detected
    if (platformMismatch) {
      toast.error(`Screenshot is from the wrong platform. This deal requires ${product.platform}.`);
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
      onSuccess?.();
      setTimeout(handleClose, 1200);
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Failed to submit order. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !product) return null;

  const handleEscape = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onKeyDown={handleEscape} role="dialog" aria-modal="true" aria-label="Order form">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[90dvh] overflow-y-auto scrollbar-styled animate-enter">
        {/* Header */}
        <div className="sticky top-0 bg-white rounded-t-3xl px-5 pt-5 pb-3 border-b border-gray-100 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <ShoppingBag size={18} className="text-lime-600" />
            <h2 className="text-lg font-extrabold text-slate-900">Order Form</h2>
          </div>
          <button type="button" onClick={handleClose} aria-label="Close order form" className="p-1.5 rounded-full hover:bg-gray-100 transition">
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Product Summary */}
          <div className="flex gap-3 bg-slate-50 rounded-xl p-3 border border-slate-100">
            <div className="w-16 h-16 rounded-xl bg-white border border-gray-100 p-1.5 flex items-center justify-center flex-shrink-0">
              <ProxiedImage
                src={product.image || placeholderImage}
                alt={product.title}
                className="w-full h-full object-contain mix-blend-multiply"
              />
            </div>
            <div className="flex-1 min-w-0">
              <ExpandableText text={product.title || ''} clampClass="line-clamp-2" className="font-bold text-sm text-slate-900" as="h3">{product.title}</ExpandableText>
              <p className="text-lg font-extrabold text-lime-600 mt-0.5">₹{product.price.toLocaleString('en-IN')}</p>
              <p className="text-[10px] text-slate-400 uppercase font-bold">{product.platform} &bull; {product.dealType === 'Discount' ? 'Order' : product.dealType} Deal</p>
            </div>
          </div>

          {/* Step 1: Visit Deal Link */}
          <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-3">
            <p className="text-xs font-bold text-blue-700 mb-1">Step 1: Buy on Marketplace</p>
            <p className="text-[11px] text-blue-600 leading-relaxed">
              Tap the link below, complete your purchase on {product.platform || 'the marketplace'},
              then return here with your order screenshot.
            </p>
            {product.productUrl && (
              <a
                href={product.productUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mt-2 px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 transition"
              >
                Open Deal Link &rarr;
              </a>
            )}
          </div>

          {/* Step 2: Upload Screenshot */}
          <div>
            <p className="text-xs font-bold text-slate-700 mb-2">Step 2: Upload Order Screenshot</p>
            {!preview ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-8 border-2 border-dashed border-gray-300 rounded-2xl flex flex-col items-center gap-2 hover:border-lime-400 hover:bg-lime-50/30 transition-all"
              >
                <Camera size={28} className="text-gray-400" />
                <span className="text-xs font-bold text-gray-500">Tap to upload screenshot</span>
                <span className="text-[10px] text-gray-400">JPG, PNG, WebP &bull; Max 10 MB</span>
              </button>
            ) : (
              <div className="relative rounded-2xl border border-gray-200 overflow-hidden">
                <img src={preview} alt="Order proof" loading="lazy" className="w-full max-h-48 object-contain bg-gray-50" />
                <button
                  type="button"
                  aria-label="Remove screenshot"
                  onClick={() => { setScreenshot(null); setPreview(null); setExtractedDetails({ orderId: '', amount: '' }); }}
                  className="absolute top-2 right-2 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center bg-white/90 rounded-full shadow hover:bg-red-50 transition"
                >
                  <X size={14} className="text-red-500" />
                </button>
                {extracting && (
                  <div className="absolute inset-0 bg-white/80 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 animate-fade-in">
                    <Loader2 size={24} className="text-lime-600 animate-spin" />
                    <span className="text-xs font-bold text-slate-600">AI analyzing screenshot...</span>
                    <div className="w-40 space-y-1.5 mt-1">
                      <div className="h-2 bg-lime-200 rounded-full animate-pulse" />
                      <div className="h-2 bg-lime-100 rounded-full animate-pulse w-3/4" />
                      <div className="h-2 bg-lime-100 rounded-full animate-pulse w-1/2" />
                    </div>
                  </div>
                )}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} aria-label="Upload order screenshot" />
          </div>

          {/* Step 3: Order Details — ALWAYS shown after screenshot upload */}
          {preview && !extracting && (
            <div className="space-y-3 animate-enter">
              {/* AI status indicator */}
              {(extractedDetails.orderId || extractedDetails.amount || extractedDetails.productName || extractedDetails.soldBy || extractedDetails.orderDate) ? (
                <div className="flex items-center gap-1.5 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <CheckCircle size={13} className="text-emerald-600 flex-shrink-0" />
                  <p className="text-[10px] font-bold text-emerald-700">AI extracted details below — please verify &amp; correct if needed</p>
                </div>
              ) : (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <AlertCircle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
                  <p className="text-[11px] text-amber-700">
                    Could not auto-detect details. Please fill in the fields below manually.
                  </p>
                </div>
              )}

              {/* All 5 editable fields — always visible */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2.5">
                <p className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider">Order Details</p>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Order ID *</label>
                    <input
                      type="text"
                      value={extractedDetails.orderId}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, orderId: e.target.value }))}
                      placeholder="e.g. 408-1234567-8901234"
                      className="w-full mt-0.5 px-2.5 py-2 text-xs font-medium border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-lime-200 focus:border-lime-400 outline-none transition-all"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Amount (₹) *</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={extractedDetails.amount}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, amount: e.target.value }))}
                      placeholder="e.g. 1044"
                      className="w-full mt-0.5 px-2.5 py-2 text-xs font-medium border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-lime-200 focus:border-lime-400 outline-none transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-bold text-slate-500 uppercase">Product Name</label>
                  <input
                    type="text"
                    readOnly
                    value={extractedDetails.productName || ''}
                    placeholder="Auto-detected from screenshot"
                    className={`w-full mt-0.5 px-2.5 py-2 text-xs font-medium border rounded-lg outline-none transition-all cursor-default ${
                      !extractedDetails.productName ? 'border-gray-300 bg-white' :
                      productNameMismatch ? 'border-red-400 bg-red-50 text-red-700 ring-2 ring-red-200' :
                      'border-emerald-400 bg-emerald-50 text-emerald-700 ring-2 ring-emerald-200'
                    }`}
                  />
                  {productNameMismatch && (
                    <div className="mt-1.5 flex items-start gap-1.5 px-2.5 py-2 bg-red-50 border border-red-200 rounded-lg">
                      <AlertCircle size={13} className="text-red-500 mt-0.5 flex-shrink-0" />
                      <p className="text-[10px] font-bold text-red-600">
                        Product name mismatch — this screenshot is for a different product.
                      </p>
                    </div>
                  )}
                  {platformMismatch && (
                    <div className="mt-1.5 flex items-start gap-1.5 px-2.5 py-2 bg-red-50 border border-red-200 rounded-lg">
                      <AlertCircle size={13} className="text-red-500 mt-0.5 flex-shrink-0" />
                      <p className="text-[10px] font-bold text-red-600">
                        Platform mismatch — this screenshot is not from {product?.platform || 'the required platform'}.
                      </p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Seller / Sold By</label>
                    <input
                      type="text"
                      value={extractedDetails.soldBy || ''}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, soldBy: e.target.value }))}
                      placeholder="e.g. Cloudtail India"
                      className="w-full mt-0.5 px-2.5 py-2 text-xs font-medium border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-lime-200 focus:border-lime-400 outline-none transition-all"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Order Date</label>
                    <input
                      type="text"
                      value={extractedDetails.orderDate || ''}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, orderDate: e.target.value }))}
                      placeholder="e.g. 15 Jan 2026"
                      className="w-full mt-0.5 px-2.5 py-2 text-xs font-medium border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-lime-200 focus:border-lime-400 outline-none transition-all"
                    />
                  </div>
                </div>
              </div>

              {/* Reviewer Name */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-1.5">
                <label className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                  <UserCircle size={12} /> Reviewer / Account Name
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
                  className={`w-full px-2.5 py-2 text-xs font-medium border rounded-lg bg-white focus:ring-2 outline-none transition-all ${
                    reviewerNameMismatch
                      ? 'border-red-400 focus:ring-red-200 focus:border-red-400'
                      : extractedDetails.accountName && reviewerName.trim() && !reviewerNameMismatch
                        ? 'border-green-400 focus:ring-green-200 focus:border-green-400'
                        : 'border-gray-300 focus:ring-lime-200 focus:border-lime-400'
                  }`}
                />
                {reviewerNameMismatch && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <AlertCircle size={10} className="text-red-500 flex-shrink-0" />
                    <p className="text-[10px] font-bold text-red-600">
                      Account name mismatch — screenshot shows &quot;{extractedDetails.accountName}&quot;
                    </p>
                  </div>
                )}
                <p className="text-[10px] text-zinc-400 ml-0.5">
                  Enter the name shown on the marketplace account used for this order.
                  {(product.dealType === 'Rating' || product.dealType === 'Review') && <span className="text-red-400 font-bold"> Required</span>}
                </p>
              </div>
            </div>
          )}

          {/* Submit Button */}
          {submitted ? (
            <div className="flex items-center justify-center gap-2 py-4 text-lime-600 animate-enter">
              <CheckCircle size={20} />
              <span className="font-bold text-sm">Order Submitted Successfully!</span>
            </div>
          ) : (
            <div className="space-y-2">
              {screenshot && !extracting && !extractedDetails.orderId && (
                <p className="text-[10px] text-red-500 font-semibold text-center">Order ID is required to submit</p>
              )}
              {reviewerNameMismatch && (
                <div className="flex items-center justify-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                  <AlertCircle size={11} className="text-amber-500 flex-shrink-0" />
                  <p className="text-[10px] font-bold text-amber-700">Reviewer name doesn&apos;t match the account in screenshot.</p>
                </div>
              )}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!screenshot || submitting || extracting || !extractedDetails.orderId.trim() || productNameMismatch || platformMismatch || reviewerNameMismatch}
                className="w-full py-3.5 bg-black text-white font-extrabold rounded-xl text-xs uppercase tracking-wider shadow-lg disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97] transition-all flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Submitting...
                  </>
                ) : (
                  <>
                    <Upload size={14} /> Submit Order
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
