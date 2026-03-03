import React, { useState, useRef, useCallback } from 'react';
import { X, Upload, Loader2, CheckCircle, ShoppingBag, Camera, AlertCircle } from 'lucide-react';
import { Product } from '../types';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ProxiedImage, placeholderImage } from './ProxiedImage';

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

export const QuickOrderModal: React.FC<QuickOrderModalProps> = ({ open, product, onClose, onSuccess }) => {
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
  }>({ orderId: '', amount: '' });

  const reset = useCallback(() => {
    setScreenshot(null);
    setPreview(null);
    setExtracting(false);
    setSubmitting(false);
    setSubmitted(false);
    setExtractedDetails({ orderId: '', amount: '' });
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
        });
      }
    } catch {
      // Extraction is optional — buyer can still submit
    } finally {
      setExtracting(false);
    }
  };

  const handleSubmit = async () => {
    if (!product || !user || !screenshot || submitting) return;
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
      onSuccess?.();
      setTimeout(handleClose, 1200);
    } catch (err: any) {
      toast.error(String(err?.message || 'Failed to submit order. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !product) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[90vh] overflow-y-auto animate-enter">
        {/* Header */}
        <div className="sticky top-0 bg-white rounded-t-3xl px-5 pt-5 pb-3 border-b border-gray-100 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <ShoppingBag size={18} className="text-lime-600" />
            <h2 className="text-lg font-extrabold text-slate-900">Order Form</h2>
          </div>
          <button type="button" onClick={handleClose} className="p-1.5 rounded-full hover:bg-gray-100 transition">
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
              <h3 className="font-bold text-sm text-slate-900 line-clamp-2">{product.title}</h3>
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
                  onClick={() => { setScreenshot(null); setPreview(null); setExtractedDetails({ orderId: '', amount: '' }); }}
                  className="absolute top-2 right-2 p-1 bg-white/90 rounded-full shadow hover:bg-red-50 transition"
                >
                  <X size={14} className="text-red-500" />
                </button>
                {extracting && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                    <Loader2 size={24} className="text-lime-600 animate-spin" />
                    <span className="ml-2 text-xs font-bold text-slate-600">Analyzing...</span>
                  </div>
                )}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
          </div>

          {/* Extracted Details (auto-filled by AI) */}
          {(extractedDetails.orderId || extractedDetails.amount) && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-2 animate-enter">
              <p className="text-[10px] font-bold text-emerald-700 flex items-center gap-1">
                <CheckCircle size={12} /> AI Detected Details
              </p>
              <div className="grid grid-cols-2 gap-2">
                {extractedDetails.orderId && (
                  <div>
                    <label className="text-[9px] font-bold text-emerald-600 uppercase">Order ID</label>
                    <input
                      type="text"
                      value={extractedDetails.orderId}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, orderId: e.target.value }))}
                      className="w-full mt-0.5 px-2 py-1.5 text-xs border border-emerald-200 rounded-lg bg-white focus:ring-1 focus:ring-emerald-400 focus:border-emerald-400 outline-none"
                    />
                  </div>
                )}
                {extractedDetails.amount && (
                  <div>
                    <label className="text-[9px] font-bold text-emerald-600 uppercase">Amount (₹)</label>
                    <input
                      type="text"
                      value={extractedDetails.amount}
                      onChange={(e) => setExtractedDetails((d) => ({ ...d, amount: e.target.value }))}
                      className="w-full mt-0.5 px-2 py-1.5 text-xs border border-emerald-200 rounded-lg bg-white focus:ring-1 focus:ring-emerald-400 focus:border-emerald-400 outline-none"
                    />
                  </div>
                )}
              </div>
              {extractedDetails.productName && (
                <p className="text-[10px] text-emerald-600">Product: {extractedDetails.productName}</p>
              )}
            </div>
          )}

          {/* Warning for no extraction */}
          {preview && !extracting && !extractedDetails.orderId && !extractedDetails.amount && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 animate-enter">
              <AlertCircle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-amber-700">
                Could not auto-detect order details. Make sure the screenshot clearly shows the Order ID and amount.
                You can still submit — the mediator will review manually.
              </p>
            </div>
          )}

          {/* Submit Button */}
          {submitted ? (
            <div className="flex items-center justify-center gap-2 py-4 text-lime-600">
              <CheckCircle size={20} />
              <span className="font-bold text-sm">Order Submitted!</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!screenshot || submitting || extracting}
              className="w-full py-3.5 bg-black text-white font-extrabold rounded-xl text-xs uppercase tracking-wider shadow-lg disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all flex items-center justify-center gap-2"
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
          )}
        </div>
      </div>
    </div>
  );
};
