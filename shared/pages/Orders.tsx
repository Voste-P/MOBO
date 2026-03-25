import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api, asArray } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatErrorMessage } from '../utils/errors';
import { checkProductNameMatch, checkReviewerNameMatch } from '../utils/productNameMatch';
import { subscribeRealtime } from '../services/realtime';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { PullToRefreshIndicator } from '../components/PullToRefreshIndicator';

import { formatCurrency } from '../utils/formatCurrency';
import { getPrimaryOrderId } from '../utils/orderHelpers';
import { csvSafe, downloadCsv } from '../utils/csvHelpers';
import { Order, Product, Ticket } from '../types';
import { Button, EmptyState, Spinner } from '../components/ui';
import { ProofImage } from '../components/ProofImage';
import { ProxiedImage } from '../components/ProxiedImage';
import { RaiseTicketModal } from '../components/RaiseTicketModal';
import TicketDetailModal from '../components/TicketDetailModal';
import { ReturnWindowVerificationBadge } from '../components/AiVerificationBadge';
import {
  Clock,
  CheckCircle2,
  X,
  Plus,
  Search,
  ScanLine,
  Check,
  Loader2,
  CalendarClock,
  AlertTriangle,
  Package,
  Zap,
  ChevronDown,
  ChevronUp,
  Download,
  Info,
  MessageSquare,
  TicketCheck,
} from 'lucide-react';

/* ─── Sample Screenshot Guide ───────────────────────────────────────── */
const SAMPLE_IMAGES: Record<string, string> = {
  order: '/screenshots/sample-order.png',
  rating: '/screenshots/sample-rating.png',
  returnWindow: '/screenshots/sample-return-window.png',
};

const SampleScreenshotGuide: React.FC<{
  type: 'order' | 'rating' | 'returnWindow';
}> = ({ type }) => {
  const [open, setOpen] = useState(false);
  const guides: Record<string, { title: string; bullets: string[]; highlights: string[] }> = {
    order: {
      title: 'Order Confirmation Screenshot',
      bullets: [
        'Go to your order details page on the marketplace (Amazon, Flipkart, etc.)',
        'Screenshot must clearly show the Order ID / Order Number',
        'Grand Total / Amount Paid should be visible',
        'Product name and "Sold by" seller info should be visible',
        'Include the "Order placed" date if possible',
      ],
      highlights: ['Order Number', 'Grand Total', 'Product Name', 'Sold by', 'Order Date'],
    },
    rating: {
      title: 'Rating / Review Screenshot',
      bullets: [
        'Open the "Write a product review" or "Rate this product" page',
        'Your reviewer name / account name must be visible at the top',
        'The product name should appear clearly on the page',
        'Star rating should be filled (e.g. 5 stars)',
        'Take the screenshot BEFORE submitting if "Submit" button is visible',
      ],
      highlights: ['Reviewer Name', 'Product Name', 'Star Rating'],
    },
    returnWindow: {
      title: 'Return Window Screenshot',
      bullets: [
        'Go to your order details page showing the delivery status',
        'Look for "Return window closed" or delivery date info',
        'Order ID and product name should both be visible',
        'The "Sold by" seller information should be present',
        'Amount / price must appear on the page',
      ],
      highlights: ['Return Window Status', 'Order Number', 'Delivered Date', 'Sold By'],
    },
  };
  const g = guides[type];
  if (!g) return null;
  const sampleImg = SAMPLE_IMAGES[type];
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/50 overflow-hidden animate-enter">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <Info size={13} className="text-blue-500 shrink-0" />
        <span className="text-[10px] font-bold text-blue-600 flex-1">
          How to take a {g.title}?
        </span>
        {open ? <ChevronUp size={12} className="text-blue-400" /> : <ChevronDown size={12} className="text-blue-400" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-blue-100">
          {/* Sample annotated image */}
          {sampleImg && (
            <div className="mt-2 rounded-lg border border-blue-200 overflow-hidden bg-white">
              <p className="text-[9px] font-bold text-blue-500 px-2 pt-1.5 pb-0.5">📸 Example — key fields highlighted</p>
              <img
                src={sampleImg}
                alt={`Sample ${g.title}`}
                className="w-full h-auto"
                loading="lazy"
                onError={(e) => { (e.currentTarget.parentElement as HTMLElement)?.remove(); }}
              />
            </div>
          )}
          <ul className="space-y-1.5 mt-2">
            {g.bullets.map((b, i) => (
              <li key={`bullet-${i}`} className="flex items-start gap-1.5 text-[10px] text-slate-600">
                <span className="w-4 h-4 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-[9px] font-black shrink-0 mt-0.5">{i + 1}</span>
                {b}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-1 mt-1">
            {g.highlights.map((h) => (
              <span key={h} className="text-[9px] font-bold bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded">
                {h}
              </span>
            ))}
          </div>
          <p className="text-[9px] text-blue-400 font-semibold italic mt-1">
            Tip: Use a full-page screenshot in good lighting for best AI detection results.
          </p>
        </div>
      )}
    </div>
  );
};

// formatCurrency, getPrimaryOrderId, csvSafe/downloadCsv imported from shared/utils

const MAX_PROOF_SIZE_BYTES = 10 * 1024 * 1024;

/** Allowed MIME types for proof images — matches what backend AI pipeline can process. */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type ImageValidationError = 'invalid_type' | 'too_large' | null;

const validateImageFile = (file: File): ImageValidationError => {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return 'invalid_type';
  if (file.size > MAX_PROOF_SIZE_BYTES) return 'too_large';
  return null;
};

/** @deprecated Use validateImageFile for detailed error */
const isValidImageFile = (file: File) => validateImageFile(file) === null;

const KNOWN_REVIEW_DOMAINS = [
  'amazon.in', 'amazon.com', 'flipkart.com', 'myntra.com', 'meesho.com',
  'ajio.com', 'jiomart.com', 'nykaa.com', 'tatacliq.com', 'snapdeal.com',
  'bigbasket.com', '1mg.com', 'croma.com', 'purplle.com', 'shopsy.in',
  'blinkit.com', 'zepto.co', 'lenskart.com', 'pharmeasy.in', 'swiggy.com',
];

const isValidReviewLink = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return KNOWN_REVIEW_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
};

export const Orders: React.FC = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [uploadType, setUploadType] = useState<'order' | 'payment' | 'rating' | 'review' | 'returnWindow'>('order');
  const [proofToView, setProofToView] = useState<Order | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const submittingRef = useRef(false);
  const [inputValue, setInputValue] = useState('');

  const [isNewOrderModalOpen, setIsNewOrderModalOpen] = useState(false);
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);
  const [productsLoadError, setProductsLoadError] = useState(false);
  const [dealTypeFilter, setDealTypeFilter] = useState<'Discount' | 'Rating' | 'Review'>(
    'Discount'
  );
  const [formSearch, setFormSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const [formScreenshot, setFormScreenshot] = useState<string | null>(null);
  const [reviewLinkInput, setReviewLinkInput] = useState('');
  // Marketplace reviewer / profile name used by the buyer on the e-commerce platform
  const [reviewerNameInput, setReviewerNameInput] = useState('');

  const [extractedDetails, setExtractedDetails] = useState<{
    orderId: string;
    amount: string;
    orderDate?: string;
    soldBy?: string;
    productName?: string;
    accountName?: string;
  }>({ orderId: '', amount: '' });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // [AI] Smart Extraction UI State
  const [matchStatus, setMatchStatus] = useState<{
    id: 'match' | 'mismatch' | 'none';
    amount: 'match' | 'mismatch' | 'none';
    productName: 'match' | 'mismatch' | 'none';
    reviewerName: 'match' | 'mismatch' | 'none';
  }>({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
  const [orderIdLocked, setOrderIdLocked] = useState(false);
  const [expandedTitles, setExpandedTitles] = useState<Set<string>>(new Set());

  // Buyer ticket state
  const [myTickets, setMyTickets] = useState<Ticket[]>([]);
  const [ticketsExpanded, setTicketsExpanded] = useState(false);
  const [ticketModalOpen, setTicketModalOpen] = useState(false);
  const [ticketOrderId, setTicketOrderId] = useState<string | undefined>();
  const [ticketStatusFilter, setTicketStatusFilter] = useState<'All' | 'Open' | 'Resolved' | 'Rejected'>('All');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);


  // Rating screenshot pre-validation state
  const [ratingPreview, setRatingPreview] = useState<string | null>(null);
  const [ratingAnalyzing, setRatingAnalyzing] = useState(false);
  const [ratingVerification, setRatingVerification] = useState<{
    accountNameMatch: boolean;
    productNameMatch: boolean;
    confidenceScore: number;
    detectedAccountName?: string;
    detectedProductName?: string;
    screenshotCropped?: boolean;
    discrepancyNote?: string;
  } | null>(null);
  const [ratingFile, setRatingFile] = useState<File | null>(null);

  // Return window screenshot pre-validation state
  const [rwPreview, setRwPreview] = useState<string | null>(null);
  const [rwAnalyzing, setRwAnalyzing] = useState(false);
  const [rwVerification, setRwVerification] = useState<{
    orderIdMatch: boolean;
    productNameMatch: boolean;
    amountMatch: boolean;
    soldByMatch: boolean;
    returnWindowClosed: boolean;
    reviewerNameMatch: boolean;
    confidenceScore: number;
    detectedReturnWindow?: string;
    detectedAccountName?: string;
    screenshotCropped?: boolean;
    discrepancyNote?: string;
  } | null>(null);
  const [rwFile, setRwFile] = useState<File | null>(null);

  // AbortController refs to cancel in-flight AI verification when user re-uploads
  const ratingAbortRef = useRef<AbortController | null>(null);
  const rwAbortRef = useRef<AbortController | null>(null);

  // Cleanup abort controllers on unmount
  useEffect(() => {
    return () => {
      ratingAbortRef.current?.abort();
      rwAbortRef.current?.abort();
    };
  }, []);

  // Order list search & filter
  const [orderListSearch, setOrderListSearch] = useState('');
  const [orderListStatus, setOrderListStatus] = useState<string>('All');

  const displayOrders = useMemo(() => {
    let result = orders;
    if (orderListStatus !== 'All') {
      result = result.filter((o) => {
        const st = String(o.affiliateStatus === 'Unchecked' ? o.paymentStatus : o.affiliateStatus || '').toLowerCase();
        return st === orderListStatus.toLowerCase();
      });
    }
    if (orderListSearch.trim()) {
      const q = orderListSearch.trim().toLowerCase();
      result = result.filter((o) =>
        (o.items?.[0]?.title || '').toLowerCase().includes(q) ||
        (o.externalOrderId || o.id || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [orders, orderListSearch, orderListStatus]);

  // Fixed: Defined filteredProducts logic for the New Order Modal
  const filteredProducts = useMemo(() => {
    return availableProducts.filter((p) => {
      const matchesType = p.dealType === dealTypeFilter;
      const matchesSearch =
        p.title.toLowerCase().includes(formSearch.toLowerCase()) ||
        p.brandName.toLowerCase().includes(formSearch.toLowerCase());
      return matchesType && matchesSearch;
    });
  }, [availableProducts, dealTypeFilter, formSearch]);

  useEffect(() => {
    if (user) {
      Promise.all([loadOrders(), loadMyTickets()]);
    } else {
      setIsLoading(false);
    }
  }, [user]);

  // Defer product loading until the New Order modal is opened; reset stale flag on close
  const productsLoadedRef = useRef(false);
  const prevModalOpen = useRef(false);
  useEffect(() => {
    if (!isNewOrderModalOpen && prevModalOpen.current) {
      // Mark stale so the next open refreshes products
      productsLoadedRef.current = false;
    }
    prevModalOpen.current = isNewOrderModalOpen;
    if (!isNewOrderModalOpen || productsLoadedRef.current) return;
    productsLoadedRef.current = true;
    api.products.getAll().then((data) => {
      setAvailableProducts(asArray<Product>(data));
      setProductsLoadError(false);
    }).catch((err) => {
      if (process.env.NODE_ENV !== 'production') console.error('Failed to load products:', err);
      setAvailableProducts([]);
      setProductsLoadError(true);
      toast.error('Failed to load available deals. Pull down to retry.');
    });
  }, [isNewOrderModalOpen]);

  const handlePullRefresh = useCallback(async () => {
    await Promise.all([loadOrders(), loadMyTickets()]);
  }, [user]);
  const { handlers: pullHandlers, pullDistance, isRefreshing: isPullRefreshing } = usePullToRefresh({ onRefresh: handlePullRefresh });

  const loadMyTickets = async () => {
    if (!user?.id) return;
    try {
      const data = await api.tickets.getAll();
      const mine = asArray<Ticket>(data)
        .filter((t: Ticket) => t.userId === user.id && t.issueType !== 'Feedback');
      setMyTickets(mine.sort((a: Ticket, b: Ticket) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch { /* silently degrade — tickets are secondary */ }
  };

  // Merge a submitClaim response (toUiOrder) into the orders list so the UI
  // updates instantly without waiting for a full refetch. This ensures the
  // next proof upload button appears immediately after a successful upload.
  const mergeSubmitResponse = useCallback((updated: any) => {
    if (!updated || !updated.id) return;
    setOrders((prev: any) => {
      if (!Array.isArray(prev)) return prev;
      return prev.map((o: Order) => {
        if (o.id !== updated.id) return o;
        // Merge only the fields the list view needs from the full response
        return {
          ...o,
          screenshots: {
            order: updated.screenshots?.order ? 'exists' : o.screenshots?.order || null,
            payment: updated.screenshots?.payment ? 'exists' : o.screenshots?.payment || null,
            review: updated.screenshots?.review ? 'exists' : o.screenshots?.review || null,
            rating: updated.screenshots?.rating ? 'exists' : o.screenshots?.rating || null,
            returnWindow: updated.screenshots?.returnWindow ? 'exists' : o.screenshots?.returnWindow || null,
          },
          reviewLink: updated.reviewLink || o.reviewLink,
          reviewerName: updated.reviewerName || o.reviewerName,
          verification: updated.verification !== undefined ? updated.verification : o.verification,
          requirements: updated.requirements !== undefined ? updated.requirements : o.requirements,
          workflowStatus: updated.workflowStatus !== undefined ? updated.workflowStatus : o.workflowStatus,
          status: updated.status !== undefined ? updated.status : o.status,
          affiliateStatus: updated.affiliateStatus !== undefined ? updated.affiliateStatus : o.affiliateStatus,
          rejection: updated.rejection !== undefined ? updated.rejection : o.rejection,
          missingProofRequests: updated.missingProofRequests !== undefined ? updated.missingProofRequests : o.missingProofRequests,
        };
      });
    });
  }, []);

  const loadOrders = async () => {
    if (!user?.id) return;
    try {
      const data = asArray<Order>(await api.orders.getUserOrders(user.id));
      setOrders(data);
      // Keep selectedOrder in sync with refreshed data
      setSelectedOrder((prev) => {
        if (!prev) return prev;
        const refreshed = data.find((o: Order) => o.id === prev.id);
        return refreshed || null;
      });
      // Keep proof modal in sync with refreshed data
      setProofToView((prev) => {
        if (!prev) return prev;
        const updated = data.find((o: Order) => o.id === prev.id);
        return updated || null;
      });
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') console.error(e);
      toast.error('Failed to load orders. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Realtime: refresh orders & tickets on relevant events
  useEffect(() => {
    if (!user) return;

    let timer: any = null;
    let ticketTimer: any = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        loadOrders();
      }, 500);
    };
    const scheduleTickets = () => {
      if (ticketTimer) return;
      ticketTimer = setTimeout(() => {
        ticketTimer = null;
        loadMyTickets();
      }, 500);
    };
    const unsub = subscribeRealtime((msg: any) => {
      if (msg.type === 'orders.changed') schedule();
      if (msg.type === 'tickets.changed') scheduleTickets();
      if (msg.type === 'deals.changed') {
        // Refresh products only if modal was already opened
        if (productsLoadedRef.current) {
          api.products
            .getAll()
            .then((data) => { setAvailableProducts(asArray<Product>(data)); setProductsLoadError(false); })
            .catch(() => {});
        }
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      if (ticketTimer) clearTimeout(ticketTimer);
    };
  }, [user?.id]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0] || !selectedOrder || isUploading || submittingRef.current) return;
    submittingRef.current = true;
    setIsUploading(true);
    try {
      const file = e.target.files[0];
      if (!isValidImageFile(file)) {
        const err = validateImageFile(file);
        throw new Error(err === 'too_large' ? 'Image too large (max 10 MB).' : 'Please upload a PNG, JPG, or WebP image.');
      }
      const reviewerName = reviewerNameInput.trim() || selectedOrder.reviewerName || '';
      const resp = await api.orders.submitClaim(selectedOrder.id, {
        type: uploadType,
        data: await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        }),
        ...(reviewerName ? { reviewerName } : {}),
      });
      toast.success('Proof uploaded!');
      mergeSubmitResponse(resp);
      setSelectedOrder(null);
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Failed to upload proof'));
    } finally {
      setIsUploading(false);
      submittingRef.current = false;
    }
  };

  const handleSubmitLink = async () => {
    if (!inputValue || !selectedOrder || isUploading || submittingRef.current) return;
    submittingRef.current = true;
    setIsUploading(true);
    try {
      if (!isValidReviewLink(inputValue)) {
        throw new Error('Please enter a valid HTTPS review link from a recognized marketplace (Amazon, Flipkart, Myntra, etc.).');
      }
      const reviewerName = reviewerNameInput?.trim() || selectedOrder.reviewerName || '';
      const resp = await api.orders.submitClaim(selectedOrder.id, { type: 'review', data: inputValue, ...(reviewerName ? { reviewerName } : {}) });
      toast.success('Link submitted!');
      mergeSubmitResponse(resp);
      setSelectedOrder(null);
      setInputValue('');
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to submit link'));
    } finally {
      setIsUploading(false);
      submittingRef.current = false;
    }
  };

  const handleNewOrderScreenshot = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isValidImageFile(file)) {
      const err = validateImageFile(file);
      toast.error(err === 'too_large' ? 'Image too large (max 10 MB).' : 'Please upload a PNG, JPG, or WebP image.');
      return;
    }

    // Capture selectedProduct BEFORE async operations to prevent race condition:
    // if user switches product while extraction is in-flight, matching would
    // compare against the WRONG product without this snapshot.
    const capturedProduct = selectedProduct;

    const reader = new FileReader();
    reader.onload = () => {
      const raw = reader.result as string;
      setFormScreenshot(raw);
    };
    reader.readAsDataURL(file);

    setIsAnalyzing(true);
    setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
    setOrderIdLocked(false);
    try {
      const details = await api.orders.extractDetails(file);
      const normalizedOrderId =
        typeof details.orderId === 'string'
          ? details.orderId
              .trim()
              .replace(/\s+/g, '')
              .replace(/[^A-Z0-9\-_/]/gi, '')
          : '';
      const hasDigit = /\d/.test(normalizedOrderId);
      // Accept any order ID that has at least one digit and is 4+ chars.
      // This covers Amazon, Flipkart, Myntra, Meesho, Ajio, Nykaa, Tata,
      // JioMart, and any future marketplace format.
      const looksLikeValidId =
        hasDigit && normalizedOrderId.length >= 4 && normalizedOrderId.length <= 64;
      const safeOrderId = /^(null|undefined|n\/a|na)$/i.test(normalizedOrderId)
        ? ''
        : looksLikeValidId
          ? normalizedOrderId
          : '';
      const safeAmount =
        typeof details.amount === 'number' && Number.isFinite(details.amount) && details.amount > 0
          ? details.amount
          : null;
      // If extraction can't read the image, allow manual entry without surfacing size errors.
      setExtractedDetails({
        orderId: safeOrderId,
        amount: safeAmount?.toString() || '',
        orderDate: typeof details.orderDate === 'string' ? details.orderDate : undefined,
        soldBy: typeof details.soldBy === 'string' ? details.soldBy : undefined,
        productName: typeof details.productName === 'string' ? details.productName : undefined,
        accountName: typeof details.accountName === 'string' ? details.accountName : undefined,
      });

      // [AI] Smart Extraction Verification Logic
      // Use capturedProduct (snapshot before await) — NOT selectedProduct which may have changed
      if (capturedProduct) {
        const hasId = Boolean(safeOrderId);
        const hasAmount = typeof safeAmount === 'number';
        const amountMatch = hasAmount && Math.abs(safeAmount - capturedProduct.price) < 10;
        const idValid = hasId && safeOrderId.length > 5;

        // Product name similarity check — strict matching to prevent fraud
        const productNameStatus = checkProductNameMatch(details.productName, capturedProduct.title);

        // Reviewer name matching against extracted account name
        const reviewerNameStatus = (details.accountName && reviewerNameInput.trim())
          ? checkReviewerNameMatch(reviewerNameInput, details.accountName)
          : 'none' as const;

        setMatchStatus({
          id: !hasId ? 'none' : idValid ? 'match' : 'mismatch',
          amount: !hasAmount ? 'none' : amountMatch ? 'match' : 'mismatch',
          productName: productNameStatus,
          reviewerName: reviewerNameStatus,
        });

        // Lock the Order ID field if AI extracted a valid one
        if (hasId && idValid) {
          setOrderIdLocked(true);
        }

        if (productNameStatus === 'mismatch') {
          toast.error('Product name in screenshot does not match the selected deal. Please upload the correct order screenshot.');
        } else if (hasId && hasAmount) {
          const extras = [details.productName && 'Product', details.soldBy && 'Seller', details.orderDate && 'Date'].filter(Boolean);
          const extraMsg = extras.length > 0 ? ` + ${extras.join(', ')}` : '';
          toast.success(`Order ID and Amount detected${extraMsg}!`);
        } else if (hasId) {
          toast.success('Order ID detected! Amount field is ready to edit if needed.');
        } else if (hasAmount) {
          toast.success('Amount detected! You can enter the Order ID below.');
        } else {
          // Show the notes from extraction so users understand WHY extraction failed
          const extractionNote = typeof details.notes === 'string' && details.notes.length > 0
            ? ` (${details.notes})`
            : '';
          toast.info(`Screenshot uploaded but extraction couldn't read the details${extractionNote}. Please enter Order ID and Amount manually.`);
        }
      }
    } catch (e: any) {
      if (process.env.NODE_ENV !== 'production') console.error('[extraction error]', e);
      // Still allow manual entry by showing empty extraction fields
      setExtractedDetails({ orderId: '', amount: '' });
      setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
      setOrderIdLocked(false);
      // Surface meaningful error so users know what went wrong
      const msg =
        typeof e?.message === 'string' && e.message.length > 0
          ? e.message
          : 'Could not extract details from screenshot';
      toast.error(`${msg}. Please enter Order ID and Amount manually.`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Rating screenshot pre-validation: check account name + product name before upload
  const handleRatingScreenshot = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedOrder || !user) return;
    if (!isValidImageFile(file)) {
      const err = validateImageFile(file);
      toast.error(err === 'too_large' ? 'Image too large (max 10 MB).' : 'Please upload a PNG, JPG, or WebP image.');
      return;
    }

    // Cancel any in-flight verification to prevent stale-state race
    ratingAbortRef.current?.abort();
    const controller = new AbortController();
    ratingAbortRef.current = controller;

    // Show preview immediately
    const reader = new FileReader();
    reader.onload = () => setRatingPreview(reader.result as string);
    reader.readAsDataURL(file);

    setRatingFile(file);
    setRatingAnalyzing(true);
    setRatingVerification(null);

    try {
      const buyerName = user.name || '';
      const productName = selectedOrder.items?.[0]?.title || '';
      // Use marketplace reviewer name (provided during order creation) as primary match target.
      // When buyer ordered from a different person's marketplace account, the reviewer name
      // is the name shown on that account — use it instead of the buyer's app account name.
      const reviewerName = selectedOrder.reviewerName || '';
      const hasReviewerName = !!selectedOrder.reviewerName;

      // For orders without a reviewer name, skip name verification to avoid
      // confusing mismatches against the buyer's app account name.
      if (!hasReviewerName) {
        if (productName) {
          const result = await api.orders.verifyRating(file, buyerName || '', productName, undefined, selectedOrder.id, controller.signal);
          // Override account name match — we can't verify without a reviewer name
          setRatingVerification({ ...result, accountNameMatch: true });
          if (result.screenshotCropped) {
            toast.error('Screenshot appears cropped or incomplete. Please upload a FULL screenshot showing the complete page including the account name header at the top.');
          } else if (!result.productNameMatch) {
            toast.warning('Product name does not match this order. Please check the screenshot.');
          } else {
            toast.success('Screenshot verified! Product matches.');
          }
        } else {
          setRatingVerification({ accountNameMatch: true, productNameMatch: true, confidenceScore: 50 });
          toast.info('Screenshot ready for upload.');
        }
      } else {
        if (reviewerName && productName) {
          // Pass buyer's app account name as expectedBuyerName (secondary),
          // and reviewer name as expectedReviewerName (PRIMARY match target).
          const result = await api.orders.verifyRating(file, buyerName || '', productName, reviewerName, selectedOrder.id, controller.signal);
          setRatingVerification(result);

          if (result.screenshotCropped) {
            toast.error('Screenshot appears cropped or incomplete. Please upload a FULL screenshot showing the complete rating page including the account name header at the top.');
          } else if (!result.accountNameMatch && !result.productNameMatch) {
            toast.error(`Reviewer name "${reviewerName}" and product do not match. Upload the correct screenshot.`);
          } else if (!result.accountNameMatch) {
            toast.error(`Reviewer name "${reviewerName}" not found in screenshot. ${result.detectedAccountName ? `Found "${result.detectedAccountName}" instead.` : ''}`);
          } else if (!result.productNameMatch) {
            toast.warning('Product name does not match this order. Please check the screenshot.');
          } else {
            toast.success('Rating screenshot verified! Account and product match.');
          }
        } else {
          setRatingVerification({ accountNameMatch: true, productNameMatch: true, confidenceScore: 50 });
          toast.info('Screenshot ready for upload.');
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // Cancelled by re-upload — ignore silently
      if (process.env.NODE_ENV !== 'production') console.error('Rating pre-validation failed:', err);
      // Keep verification null — submit button stays disabled until user retries
      setRatingVerification(null);
      const msg = err?.message || 'AI verification failed. Please try uploading the screenshot again.';
      toast.error(msg);
    } finally {
      setRatingAnalyzing(false);
    }
  };

  // Submit the pre-validated rating screenshot
  const submitRatingScreenshot = async () => {
    if (!ratingFile || !selectedOrder || isUploading || submittingRef.current) return;

    // Block if AI verification hasn't completed yet (file uploaded but not verified)
    if (!ratingVerification) {
      toast.error('Please wait for AI verification to complete before submitting.');
      return;
    }

    // Block submission when screenshot is cropped/incomplete
    if (ratingVerification.screenshotCropped) {
      toast.error('Screenshot appears cropped or incomplete. Please upload a FULL screenshot showing the complete rating page including the account name header at the top.');
      return;
    }

    const hasReviewerName = !!selectedOrder.reviewerName;

    // Block submission when reviewer name is provided but doesn't match
    if (!ratingVerification.accountNameMatch && hasReviewerName) {
      toast.error(`Reviewer name "${selectedOrder.reviewerName}" does not match the screenshot. Please upload the correct rating screenshot.`);
      return;
    }

    // Block submission when product name doesn't match
    if (!ratingVerification.productNameMatch) {
      toast.error('Product name does not match this order. Please upload the correct rating screenshot.');
      return;
    }

    setIsUploading(true);
    submittingRef.current = true;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(ratingFile);
      });
      const reviewerName = selectedOrder.reviewerName || '';
      const resp = await api.orders.submitClaim(selectedOrder.id, { type: 'rating', data, ...(reviewerName ? { reviewerName } : {}) });
      toast.success('Proof uploaded!');
      mergeSubmitResponse(resp);
      setSelectedOrder(null);
      setRatingPreview(null);
      setRatingFile(null);
      setRatingVerification(null);
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Failed to upload proof'));
    } finally {
      setIsUploading(false);
      submittingRef.current = false;
    }
  };

  // Return window screenshot pre-validation handler (mirrors handleRatingScreenshot)
  const handleReturnWindowScreenshot = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedOrder) return;
    if (!isValidImageFile(file)) {
      const err = validateImageFile(file);
      toast.error(err === 'too_large' ? 'Image too large (max 10 MB).' : 'Please upload a PNG, JPG, or WebP image.');
      return;
    }

    // Cancel any in-flight verification to prevent stale-state race
    rwAbortRef.current?.abort();
    const controller = new AbortController();
    rwAbortRef.current = controller;

    // Show preview immediately
    const reader = new FileReader();
    reader.onload = () => setRwPreview(reader.result as string);
    reader.readAsDataURL(file);

    setRwFile(file);
    setRwAnalyzing(true);
    setRwVerification(null);

    try {
      const orderId = selectedOrder.externalOrderId || '';
      const productName = selectedOrder.items?.[0]?.title || '';
      const amount = (selectedOrder.items ?? []).reduce(
        (sum: number, it: any) => sum + (Number(it.priceAtPurchase) || 0) * (Number(it.quantity) || 1), 0
      ) || selectedOrder.total || 0;
      const soldBy = selectedOrder.soldBy || '';
      const reviewerName = selectedOrder.reviewerName || '';

      if (!(orderId && productName && amount > 0)) {
        // Missing order data — block verification instead of silently approving
        setRwVerification(null);
        toast.error('Order data incomplete — please re-upload the order screenshot first so we can verify this return window screenshot.');
        return;
      }

      const result = await api.orders.verifyReturnWindow(
        file, orderId, productName, amount,
        soldBy || undefined,
        reviewerName || undefined,
        controller.signal,
      );
      setRwVerification(result);

      if (result.screenshotCropped) {
        toast.error('Screenshot appears cropped or incomplete. Please upload a FULL screenshot showing the complete order page including the page header.');
      } else {
        // Hard-block fields: order ID, product name, seller/sold by
        const hardFails: string[] = [];
        if (!result.orderIdMatch) hardFails.push('Order ID');
        if (!result.productNameMatch) hardFails.push('Product name');
        if (!result.soldByMatch && soldBy) hardFails.push('Seller name');

        if (hardFails.length > 0) {
          toast.error(`Mismatch: ${hardFails.join(', ')}. Please upload the correct return window screenshot.`);
        } else {
          toast.success(`Return window verified! Return window: ${result.returnWindowClosed ? 'Closed' : 'Open'}. You can submit.`);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // Cancelled by re-upload — ignore silently
      if (process.env.NODE_ENV !== 'production') console.error('Return window pre-validation failed:', err);
      // Keep verification null — submit button stays disabled until user retries
      setRwVerification(null);
      const msg = err?.message || 'AI verification failed. Please try uploading the screenshot again.';
      toast.error(msg);
    } finally {
      setRwAnalyzing(false);
    }
  };

  // Submit the pre-validated return window screenshot
  const submitReturnWindowScreenshot = async () => {
    if (!rwFile || !selectedOrder || isUploading || submittingRef.current) return;

    // Block if AI verification hasn't completed yet (file uploaded but not verified)
    if (!rwVerification) {
      toast.error('Please wait for AI verification to complete before submitting.');
      return;
    }

    // Block submission when screenshot is cropped/incomplete
    if (rwVerification.screenshotCropped) {
      toast.error('Screenshot appears cropped or incomplete. Please upload a FULL screenshot showing the complete order page including the page header.');
      return;
    }

    // Hard-block: order ID, product name, seller must match
    if (!rwVerification.orderIdMatch) {
      toast.error('Order ID does not match. Please upload the correct return window screenshot.');
      return;
    }
    if (!rwVerification.productNameMatch) {
      toast.error('Product name does not match. Please upload the correct return window screenshot.');
      return;
    }
    if (!rwVerification.soldByMatch && selectedOrder.soldBy) {
      toast.error('Seller/Sold by name does not match. Please upload the correct return window screenshot.');
      return;
    }

    setIsUploading(true);
    submittingRef.current = true;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(rwFile);
      });
      const reviewerName = selectedOrder.reviewerName || '';
      const resp = await api.orders.submitClaim(selectedOrder.id, { type: 'returnWindow', data, ...(reviewerName ? { reviewerName } : {}) });
      toast.success('Return window proof uploaded!');
      mergeSubmitResponse(resp);
      setSelectedOrder(null);
      setRwPreview(null);
      setRwFile(null);
      setRwVerification(null);
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Failed to upload proof'));
    } finally {
      setIsUploading(false);
      submittingRef.current = false;
    }
  };

  const submitNewOrder = async () => {
    if (!selectedProduct || !user || isUploading || submittingRef.current) return;
    if (!formScreenshot) {
      toast.error('Please upload a valid order image before submitting.');
      return;
    }
    // Block if product name mismatch or undetected by AI
    if (matchStatus.productName === 'mismatch' || matchStatus.productName === 'none') {
      toast.error(matchStatus.productName === 'none'
        ? 'Could not detect the product name in the screenshot. Please upload a clearer order screenshot.'
        : 'The product in the screenshot does not match the selected deal. Please upload the correct order screenshot.');
      return;
    }
    // Block if reviewer name mismatch
    if (matchStatus.reviewerName === 'mismatch') {
      toast.error('Reviewer name does not match the account in screenshot. Please correct it.');
      return;
    }
    // Require reviewer/account name for Rating & Review deals — it's used for
    // AI screenshot verification and cannot be added later (prevents cheating).
    if ((selectedProduct.dealType === 'Rating' || selectedProduct.dealType === 'Review') && !reviewerNameInput.trim()) {
      toast.error('Please enter the reviewer name — the marketplace account name used for this order.');
      return;
    }
    submittingRef.current = true;
    const hasExtraction = Boolean(extractedDetails.orderId || extractedDetails.amount !== '');
    const isDiscountDeal = selectedProduct.dealType === 'Discount';
    if (isDiscountDeal && hasExtraction && (matchStatus.id === 'mismatch' || matchStatus.amount === 'mismatch')) {
      toast.error('Order proof does not look valid. Please upload a clearer proof.');
      submittingRef.current = false;
      return;
    }
    // Rating/review proofs are now submitted after mediator verifies order screenshot.
    // No longer required at creation time.
    setIsUploading(true);
    try {
      const screenshots: any = { order: formScreenshot };

      await api.orders.create(
        user.id,
        [
          {
            productId: selectedProduct.id,
            title: selectedProduct.title,
            image: selectedProduct.image,
            priceAtPurchase:
              extractedDetails.amount !== '' && !isNaN(parseFloat(extractedDetails.amount))
                ? parseFloat(extractedDetails.amount)
                : selectedProduct.price,
            commission: selectedProduct.commission,
            campaignId: selectedProduct.campaignId,
            dealType: selectedProduct.dealType,
            quantity: 1,
            platform: selectedProduct.platform,
            brandName: selectedProduct.brandName,
          },
        ],
        {
          screenshots: screenshots,
          externalOrderId: extractedDetails.orderId ? extractedDetails.orderId : undefined,
          reviewLink:
            selectedProduct.dealType === 'Review' && isValidReviewLink(reviewLinkInput)
              ? reviewLinkInput
              : undefined,
          orderDate: extractedDetails.orderDate || undefined,
          soldBy: extractedDetails.soldBy || undefined,
          extractedProductName: extractedDetails.productName || undefined,
          reviewerName: reviewerNameInput.trim() || undefined,
        }
      );

      setIsNewOrderModalOpen(false);
      setSelectedProduct(null);
      setFormScreenshot(null);
      setReviewLinkInput('');
      setReviewerNameInput('');
      setExtractedDetails({ orderId: '', amount: '' });
      setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
      setOrderIdLocked(false);
      loadOrders();
      toast.success('Order submitted successfully!');
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to submit order.'));
    } finally {
      setIsUploading(false);
      submittingRef.current = false;
    }
  };



  return (
    <div className="flex flex-col h-full min-h-0 bg-[#f8f9fa]">
      <div className="p-6 pb-4 bg-white shadow-sm z-10 sticky top-0 flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">My Orders</h1>
          <div className="flex items-center gap-2">
            <p className="text-sm text-slate-500 font-medium">Track purchases & cashback.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Download CSV"
            title="Download as CSV"
            onClick={() => {
              if (!orders.length) { toast.error('No orders to export'); return; }
              const h = [
                'External Order ID', 'Date', 'Time', 'Product', 'Platform', 'Brand', 'Deal Type',
                'Unit Price (₹)', 'Quantity', 'Total (₹)', 'Commission/Cashback (₹)',
                'Workflow Status', 'Affiliate Status', 'Payment Status', 'Settlement Date',
                'Mediator', 'Agency', 'Reviewer Name', 'Sold By', 'Order Date', 'Extracted Product', 'Internal Ref',
              ];
              const csvRows = orders.map(o => {
                const d = new Date(o.createdAt);
                const item = o.items?.[0];
                return [
                  csvSafe(getPrimaryOrderId(o)),
                  csvSafe(d.toLocaleDateString('en-GB')),
                  csvSafe(d.toLocaleTimeString('en-GB')),
                  csvSafe(item?.title || ''),
                  csvSafe(item?.platform || ''),
                  csvSafe(item?.brandName || ''),
                  csvSafe(item?.dealType || 'Discount'),
                  csvSafe(String(item?.priceAtPurchase ?? 0)),
                  csvSafe(String(item?.quantity || 1)),
                  csvSafe(String(o.total || 0)),
                  csvSafe(String(item?.commission || 0)),
                  csvSafe(o.workflowStatus || ''),
                  csvSafe(o.affiliateStatus || ''),
                  csvSafe(o.paymentStatus || ''),
                  csvSafe((o as any).expectedSettlementDate ? new Date((o as any).expectedSettlementDate).toLocaleDateString('en-GB') : ''),
                  csvSafe(o.managerName || ''),
                  csvSafe(o.agencyName || ''),
                  csvSafe((o as any).reviewerName || ''),
                  csvSafe(o.soldBy || ''),
                  csvSafe(o.orderDate ? new Date(o.orderDate).toLocaleDateString('en-GB') : ''),
                  csvSafe(o.extractedProductName || ''),
                  csvSafe(o.id),
                ].join(',');
              });
              const csv = [h.join(','), ...csvRows].join('\n');
              downloadCsv(`my-orders-${new Date().toISOString().slice(0, 10)}.csv`, csv);
              toast.success('CSV downloaded!');
            }}
            className="p-2.5 rounded-xl border border-zinc-100 bg-white hover:bg-zinc-50 transition-colors"
          >
            <Download size={18} className="text-zinc-600" />
          </button>
          <Button
            type="button"
            size="icon"
            onClick={() => {
              // Reset all form state to prevent screenshot/data leaking between orders
              setFormScreenshot(null);
              setExtractedDetails({ orderId: '', amount: '' });
              setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
              setOrderIdLocked(false);
              setSelectedProduct(null);
              setReviewLinkInput('');
              setReviewerNameInput('');
              setFormSearch('');
              setIsNewOrderModalOpen(true);
            }}
            aria-label="New order"
            className="bg-black text-lime-400 hover:bg-zinc-800 focus-visible:ring-lime-400"
          >
            <Plus size={20} strokeWidth={3} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-28 scrollbar-styled overscroll-none" {...pullHandlers}>
        <PullToRefreshIndicator distance={pullDistance} isRefreshing={isPullRefreshing} />
        {/* Search & Filter */}
        <div className="flex gap-2 items-center">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={orderListSearch}
              onChange={(e) => setOrderListSearch(e.target.value)}
              placeholder="Search orders..."
              className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs font-medium focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 outline-none"
            />
          </div>
          <select
            value={orderListStatus}
            onChange={(e) => setOrderListStatus(e.target.value)}
            aria-label="Filter orders by status"
            className="px-3 py-2.5 rounded-xl border border-zinc-200 bg-white text-xs font-bold"
          >
            <option value="All">All</option>
            <option value="Pending">Pending</option>
            <option value="Pending_Cooling">Cooling</option>
            <option value="Approved_Settled">Settled</option>
            <option value="Paid">Paid</option>
          </select>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-10 text-lime-500">
            <Spinner className="w-6 h-6" />
          </div>
        ) : orders.length === 0 ? (
          <EmptyState
            title="No orders yet"
            description="Create your first order from Explore."
            icon={<Package size={40} className="text-zinc-300" />}
            action={
              <Button type="button" variant="secondary" onClick={() => {
                // Reset all form state to prevent screenshot/data leaking between orders
                setFormScreenshot(null);
                setExtractedDetails({ orderId: '', amount: '' });
                setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
                setOrderIdLocked(false);
                setSelectedProduct(null);
                setReviewLinkInput('');
                setFormSearch('');
                setIsNewOrderModalOpen(true);
              }}>
                Create Order
              </Button>
            }
          />
        ) : displayOrders.length === 0 ? (
          <EmptyState
            title="No matching orders"
            description="Try a different search or filter."
            icon={<Search size={40} className="text-zinc-300" />}
          />
        ) : (
          displayOrders.map((order) => {
            const firstItem = order.items?.[0];
            if (!firstItem) return null; // Skip orders with no items
            const dealType = firstItem.dealType || 'Discount';
            const isDiscount = dealType === 'Discount';
            const isReview = dealType === 'Review';
            const isRating = dealType === 'Rating';
            const rejectionType = order.rejection?.type;
            const rejectionReason = order.rejection?.reason;

            const purchaseVerified = !!order.verification?.orderVerified;
            const reviewVerified = !!order.verification?.reviewVerified;
            const ratingVerified = !!order.verification?.ratingVerified;
            const returnWindowVerified = !!order.verification?.returnWindowVerified;
            const missingProofs = order.requirements?.missingProofs ?? [];
            const missingVerifications = order.requirements?.missingVerifications ?? [];
            const requiredSteps = order.requirements?.required ?? [];
            const hasExtraSteps = requiredSteps.length > 0;
            const hasMissingProofRequests = (order.missingProofRequests ?? []).length > 0;
            let displayStatus = 'PENDING';
            let statusClass = 'bg-orange-50 text-orange-700 border-orange-100';

            if (order.paymentStatus === 'Paid' && order.affiliateStatus === 'Approved_Settled') {
              displayStatus = 'SETTLED';
              statusClass = 'bg-green-100 text-green-700 border-green-200';
            } else if (order.affiliateStatus === 'Frozen_Disputed') {
              displayStatus = 'FROZEN';
              statusClass = 'bg-red-50 text-red-700 border-red-200';
            } else if (order.affiliateStatus === 'Rejected') {
              displayStatus = 'REJECTED';
              statusClass = 'bg-red-50 text-red-700 border-red-200';
            } else if (order.affiliateStatus === 'Cap_Exceeded') {
              displayStatus = 'CAP REACHED';
              statusClass = 'bg-orange-100 text-orange-800 border-orange-200';
            } else if (rejectionReason) {
              displayStatus = 'ACTION REQUIRED';
              statusClass = 'bg-red-50 text-red-700 border-red-200';
            } else if (order.affiliateStatus === 'Pending_Cooling') {
              displayStatus = 'VERIFIED';
              statusClass = 'bg-blue-50 text-blue-700 border-blue-100';
            } else if (String((order as any).workflowStatus || '') === 'UNDER_REVIEW' && !purchaseVerified) {
              displayStatus = 'UNDER REVIEW';
              statusClass = 'bg-slate-50 text-slate-700 border-slate-200';
            } else if (purchaseVerified && missingProofs.length > 0) {
              displayStatus = 'UPLOAD PROOF';
              statusClass = 'bg-yellow-50 text-yellow-800 border-yellow-200';
            } else if (purchaseVerified && missingVerifications.length > 0) {
              displayStatus = 'AWAITING APPROVAL';
              statusClass = 'bg-purple-50 text-purple-700 border-purple-200';
            }

            const settlementDate = order.expectedSettlementDate
              ? new Date(order.expectedSettlementDate)
              : null;
            const isPastSettlement = settlementDate && settlementDate < new Date();

            return (
              <div
                key={order.id}
                className={`bg-white rounded-[1.5rem] p-5 shadow-sm border relative overflow-hidden group transition-all duration-200 hover:shadow-md ${order.affiliateStatus === 'Frozen_Disputed' ? 'border-red-200' : 'border-slate-100'}`}
              >
                {order.affiliateStatus === 'Frozen_Disputed' && (
                  <div className="absolute top-0 left-0 w-full bg-red-500 text-white text-[9px] font-black py-1 text-center uppercase tracking-widest z-20">
                    Support Hold Active
                  </div>
                )}
                <div className="flex justify-between items-start mb-4 pl-2">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] bg-gray-100 text-gray-500 font-bold px-2 py-0.5 rounded-md uppercase tracking-wider">
                        {getPrimaryOrderId(order)}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider ${isReview ? 'bg-purple-50 text-purple-600' : isRating ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600'}`}
                      >
                        {isDiscount ? 'PURCHASE' : dealType}
                      </span>
                    </div>
                    <p className="text-xs font-bold text-gray-400 flex items-center gap-1">
                      <Clock size={10} />
                      {new Date(order.createdAt).toLocaleDateString('en-GB')}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 max-w-[40%]">
                    <span
                      className={`px-3 py-1 text-[10px] font-bold rounded-full border shadow-sm truncate max-w-full ${statusClass}`}
                    >
                      {displayStatus}
                    </span>
                  </div>
                </div>

                <div className="flex gap-4 mb-4">
                  <div className="w-20 h-20 bg-gray-50 rounded-2xl p-2 border border-gray-100 flex-shrink-0">
                    <ProxiedImage
                      src={firstItem.image}
                      className="w-full h-full object-contain mix-blend-multiply"
                      alt={firstItem.title || 'Product'}
                    />
                  </div>
                  <div className="flex-1 min-w-0 py-1">
                    <h3
                      className={`font-bold text-slate-900 text-base leading-tight mb-2 cursor-pointer ${expandedTitles.has(order.id) ? '' : 'line-clamp-2'}`}
                      title={expandedTitles.has(order.id) ? undefined : firstItem.title}
                      onClick={() => setExpandedTitles(prev => { const next = new Set(prev); if (next.has(order.id)) next.delete(order.id); else next.add(order.id); return next; })}
                    >
                      {firstItem.title}
                    </h3>
                    <div className="flex items-center gap-3 text-xs font-bold text-slate-500">
                      <span>{formatCurrency(order.total)}</span>
                    </div>
                    {/* AI-extracted metadata */}
                    {(() => {
                      const seller = order.soldBy && order.soldBy !== 'null' && order.soldBy !== 'undefined' ? order.soldBy : '';
                      const rawDate = order.orderDate;
                      const parsedDate = rawDate ? new Date(rawDate) : null;
                      const validDate = parsedDate && !isNaN(parsedDate.getTime()) && parsedDate.getFullYear() > 2020 ? parsedDate : null;
                      return (seller || validDate) ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-slate-400 font-medium">
                          {seller && <span>Seller: {seller}</span>}
                          {validDate && <span>Ordered: {validDate.toLocaleDateString('en-GB')}</span>}
                        </div>
                      ) : null;
                    })()}
                  </div>
                </div>

                {/* Reviewer / Marketplace Account Name (read-only — set during order creation) */}
                {(isRating || isReview) && order.reviewerName && (
                  <div className="mb-3">
                    <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-xl border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Reviewer:</span>
                      <span className="text-xs font-bold text-slate-700">{order.reviewerName}</span>
                    </div>
                  </div>
                )}

                {(order.affiliateStatus === 'Pending_Cooling' || order.paymentStatus === 'Paid') &&
                  settlementDate &&
                  order.affiliateStatus !== 'Frozen_Disputed' && (
                    <div className="mb-4 bg-slate-50 rounded-xl p-3 border border-slate-100 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className={`p-1.5 rounded-lg ${isPastSettlement ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}
                        >
                          <CalendarClock size={16} />
                        </div>
                        <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">
                            Unlock Date
                          </p>
                          <p className="text-xs font-bold text-slate-900">
                            {settlementDate.toDateString()}
                          </p>
                        </div>
                      </div>
                      {isPastSettlement && order.paymentStatus !== 'Paid' && (
                        <span className="text-[10px] font-bold text-green-600 bg-green-50 px-2 py-1 rounded border border-green-100">
                          Settling...
                        </span>
                      )}
                    </div>
                  )}

                {rejectionReason && (
                  <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-bold text-red-700 flex items-start gap-2">
                    <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="uppercase text-[9px] tracking-wider font-black text-red-500 block mb-0.5">
                        {rejectionType === 'order' ? 'Purchase Proof' : rejectionType === 'review' ? 'Review Proof' : rejectionType === 'rating' ? 'Rating Proof' : rejectionType === 'returnWindow' ? 'Return Window Proof' : 'Proof'} Rejected
                      </span>
                      {rejectionReason}
                    </div>
                  </div>
                )}

                {hasMissingProofRequests && !rejectionReason && (
                  <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800 flex items-start gap-2">
                    <Zap size={14} className="flex-shrink-0 mt-0.5 text-amber-500" />
                    <div>
                      <span className="uppercase text-[9px] tracking-wider font-black text-amber-600 block mb-0.5">
                        Action Required
                      </span>
                      {(order.missingProofRequests ?? []).map((r, i) => (
                        <span key={r.type || `req-${i}`}>
                          Please upload your <strong>{r.type}</strong> proof.{r.note ? ` ${r.note}` : ''}
                          {i < (order.missingProofRequests ?? []).length - 1 ? ' ' : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* STEP PROGRESS INDICATOR — shows buyers what step they're at */}
                {hasExtraSteps && displayStatus !== 'SETTLED' && displayStatus !== 'FROZEN' && (
                  <div className="mb-3 rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider mb-2">Steps to complete</p>
                    <div className="flex items-center gap-0.5">
                      {/* Step 1: Purchase */}
                      <div className="flex items-center gap-1 min-w-0 shrink-0">
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${
                          purchaseVerified
                            ? 'bg-green-500 text-white'
                            : rejectionType === 'order'
                              ? 'bg-red-500 text-white'
                              : 'bg-slate-200 text-slate-500'
                        }`}>
                          {purchaseVerified ? <Check size={12} strokeWidth={3} /> : '1'}
                        </div>
                        <span className={`text-[9px] font-bold truncate ${purchaseVerified ? 'text-green-600' : 'text-slate-500'}`}>
                          Buy
                        </span>
                      </div>
                      <div className={`flex-1 h-0.5 mx-0.5 rounded min-w-[8px] ${purchaseVerified ? 'bg-green-400' : 'bg-slate-200'}`} />

                      {/* Step 2: Review or Rating proof upload */}
                      {requiredSteps.includes('review') && (
                        <>
                          <div className="flex items-center gap-1 min-w-0 shrink-0">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${
                              reviewVerified
                                ? 'bg-green-500 text-white'
                                : rejectionType === 'review'
                                  ? 'bg-red-500 text-white'
                                  : !missingProofs.includes('review') && purchaseVerified
                                    ? 'bg-purple-500 text-white'
                                    : purchaseVerified
                                      ? 'bg-yellow-400 text-yellow-900'
                                      : 'bg-slate-200 text-slate-400'
                            }`}>
                              {reviewVerified ? <Check size={12} strokeWidth={3} /> : '2'}
                            </div>
                            <span className={`text-[9px] font-bold truncate ${
                              reviewVerified ? 'text-green-600' : purchaseVerified ? 'text-slate-700' : 'text-slate-400'
                            }`}>
                              Review
                            </span>
                          </div>
                          <div className={`flex-1 h-0.5 mx-0.5 rounded min-w-[8px] ${reviewVerified ? 'bg-green-400' : 'bg-slate-200'}`} />
                        </>
                      )}

                      {requiredSteps.includes('rating') && (
                        <>
                          <div className="flex items-center gap-1 min-w-0 shrink-0">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${
                              ratingVerified
                                ? 'bg-green-500 text-white'
                                : rejectionType === 'rating'
                                  ? 'bg-red-500 text-white'
                                  : !missingProofs.includes('rating') && purchaseVerified
                                    ? 'bg-purple-500 text-white'
                                    : purchaseVerified
                                      ? 'bg-yellow-400 text-yellow-900'
                                      : 'bg-slate-200 text-slate-400'
                            }`}>
                              {ratingVerified ? <Check size={12} strokeWidth={3} /> : requiredSteps.includes('review') ? '3' : '2'}
                            </div>
                            <span className={`text-[9px] font-bold truncate ${
                              ratingVerified ? 'text-green-600' : purchaseVerified ? 'text-slate-700' : 'text-slate-400'
                            }`}>
                              Rate
                            </span>
                          </div>
                          <div className={`flex-1 h-0.5 mx-0.5 rounded min-w-[8px] ${ratingVerified ? 'bg-green-400' : 'bg-slate-200'}`} />
                        </>
                      )}

                      {/* Return Window step */}
                      {requiredSteps.includes('returnWindow') && (
                        <>
                          <div className="flex items-center gap-1 min-w-0 shrink-0">
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${
                              returnWindowVerified
                                ? 'bg-green-500 text-white'
                                : rejectionType === 'returnWindow'
                                  ? 'bg-red-500 text-white'
                                  : !missingProofs.includes('returnWindow') && (!!order.screenshots?.rating || !requiredSteps.includes('rating')) && (!!order.reviewLink || !!order.screenshots?.review || !requiredSteps.includes('review'))
                                    ? 'bg-purple-500 text-white'
                                    : (!!order.screenshots?.rating || !requiredSteps.includes('rating')) && (!!order.reviewLink || !!order.screenshots?.review || !requiredSteps.includes('review'))
                                      ? 'bg-yellow-400 text-yellow-900'
                                      : 'bg-slate-200 text-slate-400'
                            }`}>
                              {returnWindowVerified ? <Check size={12} strokeWidth={3} /> :
                                (requiredSteps.includes('review') && requiredSteps.includes('rating') ? '4' :
                                 requiredSteps.includes('review') || requiredSteps.includes('rating') ? '3' : '2')
                              }
                            </div>
                            <span className={`text-[9px] font-bold truncate ${
                              returnWindowVerified ? 'text-green-600' : purchaseVerified ? 'text-slate-700' : 'text-slate-400'
                            }`}>
                              Return
                            </span>
                          </div>
                          <div className={`flex-1 h-0.5 mx-0.5 rounded min-w-[8px] ${returnWindowVerified ? 'bg-green-400' : 'bg-slate-200'}`} />
                        </>
                      )}

                      {/* Final: Cashback */}
                      <div className="flex items-center gap-1 min-w-0 shrink-0">
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${
                          order.affiliateStatus === 'Pending_Cooling' || order.paymentStatus === 'Paid'
                            ? 'bg-green-500 text-white'
                            : 'bg-slate-200 text-slate-400'
                        }`}>
                          {order.affiliateStatus === 'Pending_Cooling' || order.paymentStatus === 'Paid'
                            ? <Check size={12} strokeWidth={3} />
                            : <Zap size={10} />}
                        </div>
                        <span className={`text-[9px] font-bold truncate ${
                          order.affiliateStatus === 'Pending_Cooling' || order.paymentStatus === 'Paid'
                            ? 'text-green-600'
                            : 'text-slate-400'
                        }`}>
                          Cash
                        </span>
                      </div>
                    </div>

                    {/* Context message under the step bar */}
                    {!purchaseVerified && !rejectionReason && (
                      <p className="text-[10px] text-slate-400 mt-2 font-medium">
                        Waiting for your mediator to verify purchase proof…
                      </p>
                    )}
                    {purchaseVerified && missingProofs.length > 0 && !rejectionReason && (
                      <p className="text-[10px] text-yellow-700 mt-2 font-bold">
                        ↓ Upload your {(missingProofs as string[]).map(p => p === 'returnWindow' ? 'return window' : p).join(' & ')} proof below to continue.
                      </p>
                    )}
                    {purchaseVerified && missingProofs.length === 0 && missingVerifications.length > 0 && !rejectionReason && (
                      <p className="text-[10px] text-purple-600 mt-2 font-medium">
                        All proofs uploaded! Waiting for mediator approval…
                      </p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 pt-4 border-t border-slate-50">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center bg-green-100 text-green-600">
                      <CheckCircle2 size={14} />
                    </div>
                    <button
                      onClick={() => {
                        setProofToView(order);
                      }}
                      className="text-[10px] font-bold uppercase hover:underline text-slate-500"
                    >
                      VIEW PROOFS
                    </button>
                  </div>

                  <div className="flex items-center justify-end gap-2 flex-wrap">
                    {/* Re-upload order proof: only if rejected or missing */}
                    {(rejectionType === 'order' || !order.screenshots?.order) && (
                      <button
                        onClick={() => {
                          setSelectedOrder(order);
                          setUploadType('order');
                        }}
                        className="text-[10px] font-bold uppercase text-blue-600"
                      >
                        {rejectionType === 'order' ? 'Reupload Purchase' : 'Upload Purchase Proof'}
                      </button>
                    )}
                    {/* Review upload: ONLY shown after purchase is verified by mediator */}
                    {isReview && purchaseVerified && (!order.reviewLink || rejectionType === 'review') && (
                      <button
                        onClick={() => {
                          setSelectedOrder(order);
                          setUploadType('review');
                          setReviewerNameInput(order.reviewerName || '');
                        }}
                        className="text-[10px] font-bold uppercase text-purple-600"
                      >
                        {rejectionType === 'review' ? 'Reupload Review' : 'Add Review'}
                      </button>
                    )}
                    {/* Rating upload: ONLY shown after purchase is verified by mediator */}
                    {isRating && purchaseVerified && (!order.screenshots?.rating || rejectionType === 'rating') && (
                      <button
                        onClick={() => {
                          setSelectedOrder(order);
                          setUploadType('rating');
                          setReviewerNameInput(order.reviewerName || '');
                        }}
                        className="text-[10px] font-bold uppercase text-purple-600"
                      >
                        {rejectionType === 'rating' ? 'Reupload Rating' : 'Add Rating'}
                      </button>
                    )}
                    {/* Return Window upload: shown after rating/review proof is UPLOADED (not verified) */}
                    {requiredSteps.includes('returnWindow') && purchaseVerified
                      && (!!order.screenshots?.rating || !requiredSteps.includes('rating'))
                      && (!!order.reviewLink || !!order.screenshots?.review || !requiredSteps.includes('review'))
                      && (!order.screenshots?.returnWindow || rejectionType === 'returnWindow') && (
                      <button
                        onClick={() => {
                          setSelectedOrder(order);
                          setUploadType('returnWindow');
                          setReviewerNameInput(order.reviewerName || '');
                        }}
                        className="text-[10px] font-bold uppercase text-teal-600"
                      >
                        {rejectionType === 'returnWindow' ? 'Reupload Return Window' : 'Upload Return Window'}
                      </button>
                    )}
                    {/* Raise Ticket for this specific order */}
                    <button
                      onClick={() => { setTicketOrderId(order.externalOrderId || order.id); setTicketModalOpen(true); }}
                      className="text-[10px] font-bold uppercase text-red-500 hover:text-red-700"
                    >
                      Raise Ticket
                    </button>
                  </div>
                </div>

              </div>
            );
          })
        )}

        {/* ─── My Tickets Section ──────────────────────────── */}
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setTicketsExpanded(!ticketsExpanded)}
            className="w-full flex items-center justify-between p-3 bg-white rounded-xl border border-zinc-200 hover:border-zinc-300 transition-all"
          >
            <div className="flex items-center gap-2">
              <TicketCheck size={16} className="text-red-500" />
              <span className="text-sm font-bold text-slate-800">My Tickets</span>
              {myTickets.filter(t => t.status === 'Open').length > 0 && (
                <span className="px-1.5 py-0.5 text-[9px] font-bold bg-red-100 text-red-600 rounded-full">
                  {myTickets.filter(t => t.status === 'Open').length} open
                </span>
              )}
            </div>
            {ticketsExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
          </button>

          {ticketsExpanded && (
            <div className="mt-2 space-y-2 animate-enter">
              <button
                type="button"
                onClick={() => { setTicketOrderId(undefined); setTicketModalOpen(true); }}
                className="w-full py-2.5 bg-red-50 text-red-600 font-bold text-xs rounded-xl border border-red-200 hover:bg-red-100 transition-all flex items-center justify-center gap-1.5"
              >
                <MessageSquare size={13} /> Raise a Ticket
              </button>
              {/* Export tickets CSV */}
              {myTickets.length > 0 && (
                <button type="button" onClick={() => {
                  const header = ['Ticket ID','Status','Issue Type','Description','Order ID','Resolution Note','Resolved By','Resolved At','Created At'].map(csvSafe).join(',');
                  const rows = myTickets.map(t => [
                    csvSafe(t.id.slice(-8)), csvSafe(String(t.status)),
                    csvSafe(String(t.issueType)), csvSafe(String(t.description || '')), csvSafe(String(t.orderId || '')),
                    csvSafe(String(t.resolutionNote || '')), csvSafe(String(t.resolvedByName || '')),
                    csvSafe(t.resolvedAt ? new Date(t.resolvedAt).toLocaleDateString('en-GB') : ''),
                    csvSafe(t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : ''),
                  ].join(','));
                  downloadCsv(`my-tickets-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows].join('\n'));
                  toast.success(`Exported ${myTickets.length} tickets`);
                }} className="w-full py-2 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-xl border border-emerald-200 hover:bg-emerald-100 transition-all flex items-center justify-center gap-1.5">
                  Export Tickets CSV
                </button>
              )}
              {/* Status filter pills */}
              <div className="flex gap-1.5 flex-wrap">
                {(['All', 'Open', 'Resolved', 'Rejected'] as const).map(st => {
                  const count = st === 'All' ? myTickets.length : myTickets.filter(t => t.status === st).length;
                  const active = ticketStatusFilter === st;
                  return (
                    <button key={st} type="button" onClick={() => setTicketStatusFilter(st)}
                      className={`px-2.5 py-1 rounded-full text-[10px] font-bold transition-all border ${
                        active
                          ? st === 'Open' ? 'bg-amber-500 text-white border-amber-500' :
                            st === 'Resolved' ? 'bg-green-500 text-white border-green-500' :
                            st === 'Rejected' ? 'bg-red-500 text-white border-red-500' :
                            'bg-slate-800 text-white border-slate-800'
                          : 'bg-white text-slate-600 border-zinc-200 hover:border-zinc-300'
                      }`}>
                      {st} ({count})
                    </button>
                  );
                })}
              </div>
              {(() => {
                const filtered = ticketStatusFilter === 'All' ? myTickets : myTickets.filter(t => t.status === ticketStatusFilter);
                if (filtered.length === 0) return (
                  <p className="text-xs text-slate-400 font-medium text-center py-4">
                    {myTickets.length === 0 ? 'No tickets yet. Raise one if you need help!' : `No ${ticketStatusFilter.toLowerCase()} tickets.`}
                  </p>
                );
                return (
                <div className="max-h-[50dvh] overflow-y-auto scrollbar-styled space-y-2">
                {filtered.map((t) => (
                  <div key={t.id} className="bg-white rounded-xl border border-zinc-200 p-3 space-y-1.5 cursor-pointer hover:border-zinc-400 transition-colors" onClick={() => setSelectedTicket(t)}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-800">{t.issueType}</span>
                      <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                        t.status === 'Resolved' ? 'bg-green-100 text-green-700' :
                        t.status === 'Rejected' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {t.status}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-600 line-clamp-2">{t.description}</p>
                    {t.orderId && (
                      <p className="text-[10px] text-slate-400"><span className="font-bold">Order:</span> {t.orderId}</p>
                    )}
                    {t.resolutionNote && (
                      <p className="text-[10px] text-green-700 bg-green-50 p-1.5 rounded-lg">
                        <span className="font-bold">Resolution:</span> {t.resolutionNote}
                      </p>
                    )}
                    {(t.status === 'Resolved' || t.status === 'Rejected') && (t.resolvedByName || t.resolvedAt) && (
                      <p className="text-[9px] text-slate-500">
                        {t.status === 'Resolved' ? 'Resolved' : 'Rejected'}
                        {t.resolvedByName ? ` by ${t.resolvedByName}` : ''}
                        {t.resolvedAt ? ` on ${new Date(t.resolvedAt).toLocaleDateString('en-GB')}` : ''}
                      </p>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-slate-400">
                        {new Date(t.createdAt).toLocaleDateString('en-GB')}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {(t.status === 'Resolved' || t.status === 'Rejected') && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await api.tickets.update(t.id, 'Open');
                                toast.success('Ticket reopened.');
                                loadMyTickets();
                              } catch (err: any) {
                                toast.error(formatErrorMessage(err, 'Failed to reopen ticket.'));
                              }
                            }}
                            className="px-2 py-0.5 rounded-lg text-[9px] font-bold bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100"
                          >
                            Reopen
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Raise Ticket Modal for buyer */}
      <RaiseTicketModal
        open={ticketModalOpen}
        onClose={() => { setTicketModalOpen(false); loadMyTickets(); }}
        orderId={ticketOrderId}
      />
      <TicketDetailModal
        open={!!selectedTicket}
        onClose={() => { setSelectedTicket(null); loadMyTickets(); }}
        ticket={selectedTicket}
        onRefresh={loadMyTickets}
      />

      {/* SUBMIT PURCHASE MODAL (SMART UI) */}
      {isNewOrderModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => {
            setIsNewOrderModalOpen(false);
            setFormScreenshot(null);
            setExtractedDetails({ orderId: '', amount: '' });
            setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
            setOrderIdLocked(false);
            setSelectedProduct(null);
            setReviewLinkInput('');
            setFormSearch('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setIsNewOrderModalOpen(false);
              setFormScreenshot(null);
              setExtractedDetails({ orderId: '', amount: '' });
              setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
              setOrderIdLocked(false);
              setSelectedProduct(null);
              setReviewLinkInput('');
              setFormSearch('');
            }
          }}
        >
          <div
            className="bg-white w-full max-w-sm rounded-[2.5rem] p-6 shadow-2xl animate-slide-up flex flex-col max-h-[90dvh] relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setIsNewOrderModalOpen(false);
                setFormScreenshot(null);
                setExtractedDetails({ orderId: '', amount: '' });
                setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
                setOrderIdLocked(false);
                setSelectedProduct(null);
                setReviewLinkInput('');
                setFormSearch('');
              }}
              aria-label="Close"
              className="absolute top-6 right-6 p-2 bg-gray-50 rounded-full hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
            >
              <X size={20} />
            </button>

            <h3 className="text-xl font-extrabold text-slate-900 mb-6">Claim Cashback</h3>

            <div className="flex gap-2 p-1 bg-gray-50 rounded-2xl mb-4">
              {['Discount', 'Rating', 'Review'].map((type) => (
                <button
                  key={type}
                  onClick={() => {
                    setDealTypeFilter(type as any);
                    // Reset all form state when switching deal type tab
                    setFormScreenshot(null);
                    setExtractedDetails({ orderId: '', amount: '' });
                    setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
                    setOrderIdLocked(false);
                    setSelectedProduct(null);
                  }}
                  className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-all ${dealTypeFilter === type ? 'bg-black text-white shadow-md' : 'text-slate-500'}`}
                >
                  {type}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-styled space-y-4">
              {!selectedProduct ? (
                <>
                  <div className="relative">
                    <Search
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
                      size={18}
                    />
                    <input
                      type="text"
                      placeholder="Search product..."
                      value={formSearch}
                      onChange={(e) => setFormSearch(e.target.value)}
                      className="w-full pl-11 pr-4 py-3.5 bg-gray-50 border border-gray-100 rounded-2xl text-sm font-bold outline-none focus:ring-2 focus:ring-lime-400"
                    />
                  </div>
                  <div className="space-y-2">
                    {productsLoadError && filteredProducts.length === 0 ? (
                      <div className="text-center py-8 space-y-3">
                        <p className="text-sm font-bold text-red-500">Failed to load deals</p>
                        <p className="text-xs text-slate-400">Check your connection and try again</p>
                        <button
                          type="button"
                          onClick={() => {
                            setProductsLoadError(false);
                            api.products.getAll().then((data) => {
                              setAvailableProducts(asArray<Product>(data));
                              setProductsLoadError(false);
                            }).catch(() => {
                              setProductsLoadError(true);
                              toast.error('Still unable to load deals.');
                            });
                          }}
                          className="px-4 py-2 bg-black text-white text-xs font-bold rounded-xl active:scale-95"
                        >
                          Retry
                        </button>
                      </div>
                    ) : filteredProducts.length === 0 ? (
                      <p className="text-center text-xs text-slate-400 py-6">No {dealTypeFilter.toLowerCase()} deals available</p>
                    ) : filteredProducts.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => {
                          // Reset screenshot state to prevent leak from previous product
                          setFormScreenshot(null);
                          setExtractedDetails({ orderId: '', amount: '' });
                          setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
                          setOrderIdLocked(false);
                          setSelectedProduct(p);
                          // Don't auto-fill reviewer name — buyer must explicitly enter the
                          // marketplace account name used for this order.  They may have ordered
                          // from someone else's account (e.g. brother's Amazon).
                          setReviewerNameInput('');
                        }}
                        className="flex items-center gap-3 p-3 bg-white border border-gray-100 rounded-2xl hover:bg-gray-50 cursor-pointer active:scale-95 transition-transform"
                      >
                        <ProxiedImage
                          src={p.image}
                          className="w-12 h-12 object-contain mix-blend-multiply"
                          alt={p.title || 'Product'}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-900 truncate">{p.title}</p>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase">
                              {p.platform}
                            </span>
                            <span className="text-xs font-bold text-lime-600">{formatCurrency(p.price)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="space-y-5">
                  <div className="bg-gray-50 p-4 rounded-2xl border border-gray-100 flex items-center gap-4 relative">
                    <ProxiedImage
                      src={selectedProduct.image}
                      className="w-16 h-16 object-contain mix-blend-multiply"
                      alt={selectedProduct.title || 'Product'}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 line-clamp-2">
                        {selectedProduct.title}
                      </p>
                      <p className="text-xs font-bold text-lime-600 mt-1">
                        Target Price: {formatCurrency(selectedProduct.price)}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        // Reset all form state when clearing product selection
                        setFormScreenshot(null);
                        setExtractedDetails({ orderId: '', amount: '' });
                        setMatchStatus({ id: 'none', amount: 'none', productName: 'none', reviewerName: 'none' });
                        setOrderIdLocked(false);
                        setSelectedProduct(null);
                      }}
                      aria-label="Clear selected product"
                      className="absolute -top-2 -right-2 bg-white border border-gray-200 p-1.5 rounded-full shadow-sm text-slate-400 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <div>
                    <label
                      className={`w-full aspect-[2/1] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-all group overflow-hidden relative ${formScreenshot ? 'border-lime-200' : 'border-gray-200'}`}
                    >
                      {formScreenshot ? (
                        <img loading="lazy"
                          src={formScreenshot}
                          className="w-full h-full object-cover opacity-80"
                          alt="preview"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <>
                          <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                            <ScanLine size={20} className="text-slate-400" />
                          </div>
                          <span className="text-xs font-bold text-slate-400">
                            Upload Order Screenshot
                          </span>
                        </>
                      )}
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*"
                        onChange={handleNewOrderScreenshot}
                      />
                      {isAnalyzing && (
                        <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center gap-2">
                          <Loader2
                            size={28}
                            className="animate-spin motion-reduce:animate-none text-lime-600"
                          />
                          <span className="text-xs font-bold text-lime-600 animate-pulse motion-reduce:animate-none">
                            AI Extracting Order Details...
                          </span>
                          <span className="text-[9px] text-slate-400 font-medium">
                            Detecting Order ID, Amount, Product &amp; Seller
                          </span>
                        </div>
                      )}
                    </label>
                  </div>

                  {/* Sample Screenshot Guide */}
                  {!formScreenshot && <SampleScreenshotGuide type="order" />}

                  {/* [AI] Smart Extraction UI: Field Highlighting */}
                  {formScreenshot && (
                    <div className="space-y-3 animate-enter">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                            Order ID
                          </label>
                          <div className="relative">
                            <input
                              type="text"
                              value={extractedDetails.orderId}
                              onChange={(e) => {
                                if (orderIdLocked) return;
                                setExtractedDetails({
                                  ...extractedDetails,
                                  orderId: e.target.value,
                                });
                              }}
                              readOnly={orderIdLocked}
                              className={`w-full p-3 rounded-xl font-bold text-sm outline-none transition-all ${orderIdLocked ? 'bg-gray-50 border-gray-200 cursor-not-allowed opacity-80' : matchStatus.id === 'mismatch' ? 'bg-red-50 border-red-200 focus:ring-red-100' : 'bg-gray-50 border-gray-100 focus:ring-lime-100'}`}
                              placeholder="e.g. 404-..."
                            />
                            {matchStatus.id === 'mismatch' && (
                              <AlertTriangle
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-red-500"
                                size={16}
                              />
                            )}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                            Paid Amount
                          </label>
                          <div className="relative">
                            <input
                              type="number"
                              value={extractedDetails.amount}
                              onChange={(e) =>
                                setExtractedDetails({ ...extractedDetails, amount: e.target.value })
                              }
                              className={`w-full p-3 rounded-xl font-bold text-sm outline-none transition-all ${matchStatus.amount === 'match' ? 'bg-green-50 border-green-200 focus:ring-green-100' : matchStatus.amount === 'mismatch' ? 'bg-red-50 border-red-200 focus:ring-red-100' : 'bg-gray-50 border-gray-100 focus:ring-lime-100'}`}
                              placeholder="e.g. 1299"
                            />
                            {matchStatus.amount === 'match' && (
                              <Zap
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-green-500 fill-current"
                                size={16}
                              />
                            )}
                          </div>
                        </div>
                      </div>
                      {matchStatus.id === 'match' && matchStatus.amount === 'match' && (
                        <p className="text-[10px] text-green-600 font-bold bg-green-50 p-2 rounded-lg flex items-center gap-1.5">
                          <CheckCircle2 size={12} /> AI suggests this is a valid proof.
                        </p>
                      )}
                      {matchStatus.productName === 'mismatch' && (
                        <div className="bg-red-50 border-2 border-red-300 p-3 rounded-lg animate-enter">
                          <p className="text-[11px] text-red-700 font-bold flex items-center gap-1.5">
                            <AlertTriangle size={14} /> WRONG PRODUCT — The product in this screenshot does not match the selected deal.
                          </p>
                          <p className="text-[10px] text-red-600 mt-1">Please upload a screenshot of the correct order.</p>
                        </div>
                      )}
                      {matchStatus.productName === 'none' && extractedDetails.productName && (
                        <div className="bg-amber-50 border-2 border-amber-300 p-3 rounded-lg animate-enter">
                          <p className="text-[11px] text-amber-700 font-bold flex items-center gap-1.5">
                            <AlertTriangle size={14} /> Could not verify product name. Please upload a clearer screenshot.
                          </p>
                        </div>
                      )}
                      {matchStatus.productName === 'match' && (
                        <p className="text-[10px] text-green-600 font-bold bg-green-50 p-2 rounded-lg flex items-center gap-1.5">
                          <CheckCircle2 size={12} /> Product name matches the selected deal.
                        </p>
                      )}
                      {/* Guidance when AI could not extract anything */}
                      {!isAnalyzing && !extractedDetails.orderId && !extractedDetails.amount && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 animate-enter">
                          <p className="text-[10px] text-amber-700 font-bold flex items-center gap-1.5 mb-1">
                            <AlertTriangle size={12} /> Could not auto-detect details from this screenshot.
                          </p>
                          <p className="text-[9px] text-amber-600 leading-relaxed mb-1.5">
                            Please type your <strong>Order ID</strong> and <strong>Paid Amount</strong> manually in the fields above.
                          </p>
                          <details className="text-[9px] text-amber-600">
                            <summary className="font-bold cursor-pointer hover:text-amber-700">Tips for better detection</summary>
                            <ul className="list-disc pl-3 mt-1 space-y-0.5 leading-relaxed">
                              <li>Take a <strong>clear, full-screen screenshot</strong> of the order details page</li>
                              <li>Ensure <strong>Order ID</strong> and <strong>Total Amount</strong> are both visible</li>
                              <li><strong>Amazon:</strong> Go to Your Orders → View Order Details</li>
                              <li><strong>Flipkart:</strong> Go to My Orders → tap the order</li>
                              <li><strong>Myntra/Ajio:</strong> Go to Orders → Order Details</li>
                              <li>Avoid screenshots of delivery tracking or payment pages</li>
                              <li>Use good lighting and avoid dark mode if possible</li>
                            </ul>
                          </details>
                        </div>
                      )}
                      {/* Guidance when only one field is extracted */}
                      {!isAnalyzing && (!!extractedDetails.orderId !== !!extractedDetails.amount) && (
                        <p className="text-[9px] text-blue-600 font-medium bg-blue-50 p-2 rounded-lg flex items-center gap-1.5">
                          <AlertTriangle size={10} /> {extractedDetails.orderId ? 'Amount not detected — please enter the Paid Amount manually.' : 'Order ID not detected — please enter the Order ID manually.'}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Show AI-extracted metadata — editable so users can correct AI mistakes */}
                  {/* Always show after extraction completes so users can manually fill missing fields */}
                  {formScreenshot && !isAnalyzing && (extractedDetails.orderId || extractedDetails.amount) && (
                    <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 space-y-2 animate-enter">
                      <p className="text-[10px] font-bold text-blue-500 uppercase flex items-center gap-1">
                        <ScanLine size={10} /> AI Extracted Details
                      </p>
                      <div className="space-y-0.5">
                        <label className="text-[9px] font-bold text-slate-400 uppercase ml-0.5">Product Name</label>
                        <input
                          type="text"
                          value={extractedDetails.productName || ''}
                          readOnly
                          className={`w-full p-2 rounded-lg text-xs outline-none transition-all cursor-default ${matchStatus.productName === 'match' ? 'bg-green-50 border border-green-200 text-green-800' : matchStatus.productName === 'mismatch' ? 'bg-red-50 border border-red-300 text-red-700 font-bold' : 'bg-amber-50 border border-amber-200 text-amber-700'}`}
                          placeholder="Product name"
                        />
                        {selectedProduct && matchStatus.productName === 'mismatch' && (
                          <p className="text-[9px] text-red-500 mt-0.5 ml-0.5">
                            <strong>Expected:</strong> {selectedProduct.title}
                          </p>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <label className="text-[9px] font-bold text-slate-400 uppercase ml-0.5">Sold By</label>
                        <input
                          type="text"
                          value={extractedDetails.soldBy || ''}
                          onChange={(e) => setExtractedDetails({ ...extractedDetails, soldBy: e.target.value || undefined })}
                          className="w-full p-2 rounded-lg bg-white border border-blue-100 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-blue-100 transition-all"
                          placeholder="Seller name"
                        />
                      </div>
                      <div className="space-y-0.5">
                        <label className="text-[9px] font-bold text-slate-400 uppercase ml-0.5">Order Date</label>
                        <input
                          type="text"
                          value={extractedDetails.orderDate || ''}
                          onChange={(e) => setExtractedDetails({ ...extractedDetails, orderDate: e.target.value || undefined })}
                          className="w-full p-2 rounded-lg bg-white border border-blue-100 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-blue-100 transition-all"
                          placeholder="e.g. 15 January 2026"
                        />
                      </div>
                    </div>
                  )}

                  {/* Reviewer name — only for Rating/Review deals (Discount deals don't need it) */}
                  {formScreenshot && (selectedProduct?.dealType === 'Rating' || selectedProduct?.dealType === 'Review') && (
                    <div className="space-y-1 animate-enter">
                      <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                        Reviewer / Account Name <span className="text-red-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={reviewerNameInput}
                        onChange={(e) => {
                          const val = e.target.value;
                          setReviewerNameInput(val);
                          if (extractedDetails.accountName && val.trim()) {
                            const rnStatus = checkReviewerNameMatch(val, extractedDetails.accountName);
                            setMatchStatus((prev) => ({ ...prev, reviewerName: rnStatus }));
                          } else {
                            setMatchStatus((prev) => ({ ...prev, reviewerName: 'none' }));
                          }
                        }}
                        className={`w-full p-3 rounded-xl bg-gray-50 border font-bold text-sm outline-none focus:ring-2 transition-all ${
                          matchStatus.reviewerName === 'mismatch'
                            ? 'border-red-300 focus:ring-red-100'
                            : matchStatus.reviewerName === 'match'
                              ? 'border-green-300 focus:ring-green-100'
                              : 'border-gray-100 focus:ring-lime-100'
                        }`}
                        placeholder="e.g. Chetan on Amazon"
                        maxLength={200}
                      />
                      {matchStatus.reviewerName === 'mismatch' && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <AlertTriangle size={11} className="text-red-500 flex-shrink-0" />
                          <p className="text-[9px] font-bold text-red-600">
                            Account name mismatch — screenshot shows &quot;{extractedDetails.accountName}&quot;
                          </p>
                        </div>
                      )}
                      {matchStatus.reviewerName === 'match' && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <CheckCircle2 size={11} className="text-green-500 flex-shrink-0" />
                          <p className="text-[9px] font-bold text-green-600">
                            Account name matches screenshot
                          </p>
                        </div>
                      )}
                      <p className="text-[9px] text-zinc-400 ml-1">
                        Enter the name shown on the marketplace account used for this order. If you ordered from someone else's account (e.g. brother, friend), enter their name — your rating/review screenshots will be verified against this name.
                      </p>
                    </div>
                  )}

                  {/* For Rating/Review deals, rating/review proof is submitted AFTER mediator verifies order screenshot */}
                  {(selectedProduct?.dealType === 'Rating' || selectedProduct?.dealType === 'Review') && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 animate-enter">
                      <p className="text-[11px] font-bold text-amber-700 flex items-center gap-1.5">
                        <CalendarClock size={13} /> {selectedProduct.dealType === 'Rating' ? 'Rating screenshot' : 'Review link'} can be submitted after your order screenshot is verified by the mediator.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 pt-4 border-t border-gray-100">
              {(matchStatus.productName === 'mismatch' || matchStatus.productName === 'none') && formScreenshot && (
                <p className="text-[10px] text-red-600 font-bold text-center mb-2">
                  {matchStatus.productName === 'mismatch'
                    ? 'Submit blocked: product name does not match the deal.'
                    : 'Submit blocked: product name could not be verified.'}
                </p>
              )}
              {matchStatus.reviewerName === 'mismatch' && formScreenshot && (
                <p className="text-[10px] text-red-600 font-bold text-center mb-2">
                  Submit blocked: reviewer name does not match the account in screenshot.
                </p>
              )}
              <button
                onClick={submitNewOrder}
                disabled={
                  !selectedProduct ||
                  !formScreenshot ||
                  isUploading ||
                  matchStatus.productName === 'mismatch' ||
                  matchStatus.productName === 'none' ||
                  matchStatus.reviewerName === 'mismatch' ||
                  !extractedDetails.orderId ||
                  !extractedDetails.amount
                }
                className={`w-full py-4 font-bold rounded-2xl flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg ${
                  !selectedProduct || !formScreenshot || isUploading || matchStatus.productName === 'mismatch' || matchStatus.productName === 'none' || matchStatus.reviewerName === 'mismatch' || !extractedDetails.orderId || !extractedDetails.amount
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-black text-white hover:bg-lime-400 hover:text-black'
                }`}
              >
                {isUploading ? (
                  <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Check size={18} />
                )}
                {isUploading ? 'Submitting...' : 'Submit Claim'}
              </button>
            </div>
          </div>
        </div>
      )}

      {proofToView && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-fade-in"
          onClick={() => setProofToView(null)}
        >
          <div
            className="max-w-lg w-full bg-white p-4 rounded-2xl relative shadow-2xl max-h-[90dvh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setProofToView(null)}
              aria-label="Close"
              className="absolute -top-4 -right-4 bg-white text-black p-2 rounded-full shadow-lg hover:bg-red-500 hover:text-white transition-colors z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              <X size={20} />
            </button>
            <div className="mb-3">
              <h3 className="text-lg font-extrabold text-slate-900">Proofs</h3>
              <p className="text-xs text-slate-500 font-bold uppercase">
                Order {getPrimaryOrderId(proofToView)}
              </p>
              {proofToView.reviewerName && (
                <p className="text-[10px] mt-1 text-indigo-600 font-bold flex items-center gap-1">
                  Reviewer Name: {proofToView.reviewerName}
                </p>
              )}
            </div>
            <div className="space-y-4 max-h-[75dvh] overflow-y-auto scrollbar-styled pr-1">
              <div className="space-y-2">
                <div className="text-[10px] font-bold uppercase text-slate-400">Order Proof</div>
                {proofToView.screenshots?.order ? (
                  <ProofImage
                    orderId={proofToView.id}
                    proofType="order"
                    existingSrc={proofToView.screenshots.order !== 'exists' ? proofToView.screenshots.order : undefined}
                    alt="Order proof"
                  />
                ) : (
                  <div className="p-4 rounded-xl border border-dashed border-slate-200 text-xs text-slate-500 font-bold">
                    Order proof not submitted.
                  </div>
                )}
              </div>

              {proofToView.items?.[0]?.dealType === 'Rating' && (
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase text-slate-400 tracking-wide">Rating Proof</div>
                  {proofToView.screenshots?.rating ? (
                    <ProofImage
                      orderId={proofToView.id}
                      proofType="rating"
                      existingSrc={proofToView.screenshots.rating !== 'exists' ? proofToView.screenshots.rating : undefined}
                      alt="Rating proof"
                    />
                  ) : (
                    <div className="p-4 rounded-xl border border-dashed border-slate-200 text-xs text-slate-500 font-bold">
                      Rating proof not submitted.
                    </div>
                  )}
                </div>
              )}

              {proofToView.items?.[0]?.dealType === 'Review' && (
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase text-slate-400 tracking-wide">Review Link</div>
                  {proofToView.reviewLink ? (
                    <a
                      href={proofToView.reviewLink}
                      target="_blank"
                      rel="noreferrer"
                      className="block p-3 rounded-xl border border-blue-200 text-xs font-bold text-blue-600 bg-blue-50 break-all hover:bg-blue-100 transition-colors"
                    >
                      {proofToView.reviewLink}
                    </a>
                  ) : (
                    <div className="p-4 rounded-xl border border-dashed border-slate-200 text-xs text-slate-500 font-bold">
                      Review link not submitted.
                    </div>
                  )}
                </div>
              )}

              {/* Return Window Proof */}
              {(proofToView.items?.[0]?.dealType === 'Rating' || proofToView.items?.[0]?.dealType === 'Review') && (
              <div className="space-y-2">
                <div className="text-xs font-bold uppercase text-slate-400 tracking-wide">Return Window Proof</div>
                {(proofToView.screenshots as any)?.returnWindow ? (
                  <ProofImage
                    orderId={proofToView.id}
                    proofType="returnWindow"
                    existingSrc={(proofToView.screenshots as any).returnWindow !== 'exists' ? (proofToView.screenshots as any).returnWindow : undefined}
                    alt="Return window proof"
                  />
                ) : (
                  <div className="p-4 rounded-xl border border-dashed border-slate-200 text-xs text-slate-500 font-bold">
                    Return window proof not submitted.
                  </div>
                )}
                {/* AI Return Window Verification */}
                {proofToView.returnWindowAiVerification && (
                  <ReturnWindowVerificationBadge
                    data={proofToView.returnWindowAiVerification}
                    className="mt-2 bg-teal-50 rounded-xl border border-teal-100 p-3 space-y-1.5"
                  />
                )}
              </div>
              )}


            </div>
          </div>
        </div>
      )}

      {/* ADD REVIEW / RATING MODAL */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => {
            setSelectedOrder(null);
            setInputValue('');
            setRatingPreview(null);
            setRatingFile(null);
            setRatingVerification(null);
            setRwPreview(null);
            setRwFile(null);
            setRwVerification(null);
          }}
        >
          <div
            className="bg-white w-full max-w-sm rounded-[2rem] p-6 shadow-2xl animate-slide-up relative max-h-[90dvh] overflow-y-auto scrollbar-styled"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setSelectedOrder(null);
                setInputValue('');
                setRatingPreview(null);
                setRatingFile(null);
                setRatingVerification(null);
                setRwPreview(null);
                setRwFile(null);
                setRwVerification(null);
              }}
              aria-label="Close"
              className="absolute top-4 right-4 p-2 bg-gray-100 rounded-full hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 focus-visible:ring-offset-2 focus-visible:ring-offset-white z-10"
            >
              <X size={16} />
            </button>

            <h3 className="text-lg font-extrabold text-slate-900 mb-1">
              {uploadType === 'review' ? 'Submit Review Link' : uploadType === 'returnWindow' ? 'Upload Return Window' : uploadType === 'rating' ? 'Upload Rating Proof' : 'Upload Proof'}
            </h3>
            <p className="text-xs text-slate-500 font-bold uppercase mb-5">
              Order {getPrimaryOrderId(selectedOrder)}
            </p>

            {uploadType === 'review' ? (
              <div className="space-y-3">
                {/* Reviewer Name — display for identity consistency */}
                {selectedOrder?.reviewerName && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                    <p className="text-[10px] font-bold text-green-700 flex items-center gap-1.5">
                      <CheckCircle2 size={12} />
                      Reviewer name: <span className="text-green-800">"{selectedOrder.reviewerName}"</span>
                    </p>
                    <p className="text-[9px] text-green-600 mt-1">
                      Your review link must be from this marketplace account.
                    </p>
                  </div>
                )}
                <label className="text-[10px] font-bold text-slate-400 uppercase ml-1 block">
                  Review Link
                </label>
                <input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="https://..."
                  className="w-full p-3 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-sm outline-none focus:ring-2 focus:ring-blue-400"
                />
                <button
                  onClick={handleSubmitLink}
                  disabled={isUploading || !inputValue}
                  className="w-full py-3.5 bg-black text-white font-bold rounded-2xl hover:bg-blue-600 transition-all disabled:opacity-50"
                >
                  {isUploading ? 'Submitting...' : 'Submit'}
                </button>
              </div>
            ) : uploadType === 'rating' ? (
              /* Enhanced rating upload with AI pre-validation */
              <div className="space-y-4">
                {/* Reviewer Name — display only, set during order creation */}
                {selectedOrder?.reviewerName && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                    <p className="text-[10px] font-bold text-green-700 flex items-center gap-1.5">
                      <CheckCircle2 size={12} />
                      Reviewer name: <span className="text-green-800">"{selectedOrder.reviewerName}"</span>
                    </p>
                    <p className="text-[9px] text-green-600 mt-1">
                      Your rating screenshot must show this reviewer name to be accepted.
                    </p>
                  </div>
                )}

                <label
                  className={`w-full aspect-[2/1] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-all group overflow-hidden relative ${ratingPreview ? 'border-lime-200' : 'border-gray-200'}`}
                >
                  {ratingPreview ? (
                    <img loading="lazy" src={ratingPreview} className="w-full h-full object-cover opacity-80" alt="Rating preview" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <>
                      <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                        <ScanLine size={20} className="text-slate-400" />
                      </div>
                      <span className="text-xs font-bold text-slate-400">
                        Upload Rating Screenshot
                      </span>
                    </>
                  )}
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={handleRatingScreenshot}
                    disabled={isUploading || ratingAnalyzing}
                  />
                  {ratingAnalyzing && (
                    <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center">
                      <Loader2 size={24} className="animate-spin motion-reduce:animate-none text-lime-600 mb-2" />
                      <span className="text-xs font-bold text-lime-600 animate-pulse motion-reduce:animate-none">
                        AI Verifying Rating...
                      </span>
                    </div>
                  )}
                </label>

                {/* Sample Screenshot Guide */}
                {!ratingPreview && <SampleScreenshotGuide type="rating" />}

                {/* AI Verification Results */}
                {ratingVerification && (
                  <div className="space-y-2 animate-enter">
                    <div className="grid grid-cols-2 gap-2">
                      <div className={`p-2.5 rounded-xl text-center ${ratingVerification.accountNameMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">
                          {selectedOrder?.reviewerName ? 'Reviewer Name' : 'Account Name'}
                        </div>
                        <div className={`text-xs font-bold ${ratingVerification.accountNameMatch ? 'text-green-600' : 'text-red-600'}`}>
                          {ratingVerification.accountNameMatch ? '✓ Match' : '✗ Mismatch'}
                        </div>
                        {ratingVerification.detectedAccountName && (
                          <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                            Detected: {ratingVerification.detectedAccountName}
                          </div>
                        )}
                      </div>
                      <div className={`p-2.5 rounded-xl text-center ${ratingVerification.productNameMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Product Name</div>
                        <div className={`text-xs font-bold ${ratingVerification.productNameMatch ? 'text-green-600' : 'text-red-600'}`}>
                          {ratingVerification.productNameMatch ? '✓ Match' : '✗ Mismatch'}
                        </div>
                        {ratingVerification.detectedProductName && (
                          <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                            Found: {ratingVerification.detectedProductName}
                          </div>
                        )}
                      </div>
                    </div>

                    {ratingVerification.screenshotCropped && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Screenshot appears cropped or incomplete. Please upload a FULL screenshot showing the complete rating page including the account name header at the top.
                      </p>
                    )}
                    {ratingVerification.accountNameMatch && ratingVerification.productNameMatch && !ratingVerification.screenshotCropped && (
                      <p className="text-[10px] text-green-600 font-bold bg-green-50 p-2 rounded-lg flex items-center gap-1.5">
                        <CheckCircle2 size={12} /> Rating screenshot verified. Ready to submit.
                      </p>
                    )}
                    {!ratingVerification.accountNameMatch && !ratingVerification.productNameMatch && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        {selectedOrder?.reviewerName
                          ? `Reviewer name "${selectedOrder.reviewerName}" and product do not match. Upload the correct rating screenshot from the correct marketplace account.`
                          : 'Account name & product do not match. Upload the correct rating screenshot.'}
                      </p>
                    )}
                    {!ratingVerification.accountNameMatch && ratingVerification.productNameMatch && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        {selectedOrder?.reviewerName
                          ? `Reviewer name "${selectedOrder.reviewerName}" not found in screenshot. ${ratingVerification.detectedAccountName ? `Found "${ratingVerification.detectedAccountName}" instead.` : ''} Please upload a screenshot from the correct account.`
                          : 'Account name mismatch — please ensure the rating was posted from the correct marketplace account.'}
                      </p>
                    )}
                    {ratingVerification.accountNameMatch && !ratingVerification.productNameMatch && (
                      <p className="text-[10px] text-amber-600 font-bold bg-amber-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Product does not match this order. Please check the screenshot.
                      </p>
                    )}
                    {ratingVerification.discrepancyNote && (
                      <p className="text-[10px] text-slate-500 italic px-1">
                        {ratingVerification.discrepancyNote}
                      </p>
                    )}
                  </div>
                )}

                {/* Show retry hint when AI verification failed */}
                {ratingFile && !ratingAnalyzing && !ratingVerification && (
                  <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                    <AlertTriangle size={12} /> AI verification failed. Please re-upload the screenshot to try again.
                  </p>
                )}

                <button
                  onClick={submitRatingScreenshot}
                  disabled={
                    isUploading ||
                    ratingAnalyzing ||
                    !ratingFile ||
                    // Block submit until AI verification succeeds
                    !ratingVerification ||
                    // Block submit when screenshot is cropped/incomplete
                    !!(ratingVerification && ratingVerification.screenshotCropped) ||
                    // Block submit when reviewer name doesn't match or product name doesn't match
                    !!(ratingVerification && !ratingVerification.accountNameMatch && selectedOrder?.reviewerName) ||
                    !!(ratingVerification && !ratingVerification.productNameMatch)
                  }
                  className="w-full py-3.5 bg-black text-white font-bold rounded-2xl hover:bg-zinc-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isUploading ? 'Submitting...' : ratingAnalyzing ? 'Verifying...' : 'Submit Rating Proof'}
                </button>
              </div>
            ) : uploadType === 'returnWindow' ? (
              /* Enhanced return window upload with AI pre-validation */
              <div className="space-y-4">
                {/* Reviewer Name — display for identity consistency */}
                {selectedOrder?.reviewerName && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                    <p className="text-[10px] font-bold text-green-700 flex items-center gap-1.5">
                      <CheckCircle2 size={12} />
                      Reviewer name: <span className="text-green-800">"{selectedOrder.reviewerName}"</span>
                    </p>
                    <p className="text-[9px] text-green-600 mt-1">
                      Your return window screenshot must show this name to be accepted.
                    </p>
                  </div>
                )}

                <label
                  className={`w-full aspect-[2/1] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-all group overflow-hidden relative ${rwPreview ? 'border-lime-200' : 'border-gray-200'}`}
                >
                  {rwPreview ? (
                    <img loading="lazy" src={rwPreview} className="w-full h-full object-cover opacity-80" alt="Return window preview" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <>
                      <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                        <CalendarClock size={20} className="text-slate-400" />
                      </div>
                      <span className="text-xs font-bold text-slate-400">
                        Upload Return Window Screenshot
                      </span>
                    </>
                  )}
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={handleReturnWindowScreenshot}
                    disabled={isUploading || rwAnalyzing}
                  />
                  {rwAnalyzing && (
                    <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center">
                      <Loader2 size={24} className="animate-spin motion-reduce:animate-none text-lime-600 mb-2" />
                      <span className="text-xs font-bold text-lime-600 animate-pulse motion-reduce:animate-none">
                        AI Verifying Return Window...
                      </span>
                    </div>
                  )}
                </label>

                {/* Sample Screenshot Guide */}
                {!rwPreview && <SampleScreenshotGuide type="returnWindow" />}

                {/* AI Verification Results */}
                {rwVerification && (
                  <div className="space-y-2 animate-enter">
                    <div className="grid grid-cols-3 gap-2">
                      <div className={`p-2.5 rounded-xl text-center ${rwVerification.orderIdMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Order ID</div>
                        <div className={`text-xs font-bold ${rwVerification.orderIdMatch ? 'text-green-600' : 'text-red-600'}`}>
                          {rwVerification.orderIdMatch ? '✓ Match' : '✗ Mismatch'}
                        </div>
                      </div>
                      <div className={`p-2.5 rounded-xl text-center ${rwVerification.productNameMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Product</div>
                        <div className={`text-xs font-bold ${rwVerification.productNameMatch ? 'text-green-600' : 'text-red-600'}`}>
                          {rwVerification.productNameMatch ? '✓ Match' : '✗ Mismatch'}
                        </div>
                      </div>
                      <div className={`p-2.5 rounded-xl text-center ${rwVerification.returnWindowClosed ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Return Window</div>
                        <div className={`text-xs font-bold ${rwVerification.returnWindowClosed ? 'text-green-600' : 'text-red-600'}`}>
                          {rwVerification.returnWindowClosed ? '✓ Closed' : '✗ Still Open'}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className={`p-2.5 rounded-xl text-center ${rwVerification.amountMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Amount</div>
                        <div className={`text-xs font-bold ${rwVerification.amountMatch ? 'text-green-600' : 'text-red-600'}`}>
                          {rwVerification.amountMatch ? '✓ Match' : '✗ Mismatch'}
                        </div>
                      </div>
                      {selectedOrder?.soldBy && (
                      <div className={`p-2.5 rounded-xl text-center ${rwVerification.soldByMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                        <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Seller</div>
                        <div className={`text-xs font-bold ${rwVerification.soldByMatch ? 'text-green-600' : 'text-red-600'}`}>
                          {rwVerification.soldByMatch ? '✓ Match' : '✗ Mismatch'}
                        </div>
                      </div>
                      )}
                      {selectedOrder?.reviewerName && (
                        <div className={`p-2.5 rounded-xl text-center ${rwVerification.reviewerNameMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                          <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Reviewer</div>
                          <div className={`text-xs font-bold ${rwVerification.reviewerNameMatch ? 'text-green-600' : 'text-red-600'}`}>
                            {rwVerification.reviewerNameMatch ? '✓ Match' : '✗ Mismatch'}
                          </div>
                        </div>
                      )}
                    </div>

                    {rwVerification.screenshotCropped && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Screenshot appears cropped or incomplete. Please upload a FULL screenshot showing the complete order page including the page header.
                      </p>
                    )}
                    {rwVerification.orderIdMatch && rwVerification.productNameMatch && rwVerification.returnWindowClosed && rwVerification.amountMatch && !rwVerification.screenshotCropped && (!selectedOrder?.soldBy || rwVerification.soldByMatch) && (!selectedOrder?.reviewerName || rwVerification.reviewerNameMatch) && (
                      <p className="text-[10px] text-green-600 font-bold bg-green-50 p-2 rounded-lg flex items-center gap-1.5">
                        <CheckCircle2 size={12} /> Return window screenshot verified. Ready to submit.
                      </p>
                    )}
                    {!rwVerification.returnWindowClosed && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Return window is still open. Please wait until it closes before uploading.
                        {rwVerification.detectedReturnWindow && ` (Detected: ${rwVerification.detectedReturnWindow})`}
                      </p>
                    )}
                    {!rwVerification.orderIdMatch && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Order ID does not match. Please upload the return window screenshot for this specific order.
                      </p>
                    )}
                    {!rwVerification.productNameMatch && rwVerification.orderIdMatch && (
                      <p className="text-[10px] text-amber-600 font-bold bg-amber-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Product name does not match this order. Please check the screenshot.
                      </p>
                    )}
                    {!rwVerification.reviewerNameMatch && selectedOrder?.reviewerName && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Reviewer name "{selectedOrder.reviewerName}" not found in screenshot.{rwVerification.detectedAccountName ? ` Found "${rwVerification.detectedAccountName}" instead.` : ''}
                      </p>
                    )}
                    {!rwVerification.amountMatch && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Amount does not match this order. Please check the screenshot.
                      </p>
                    )}
                    {!rwVerification.soldByMatch && selectedOrder?.soldBy && (
                      <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        Seller name does not match. Expected &quot;{selectedOrder.soldBy}&quot;.
                      </p>
                    )}
                    {rwVerification.discrepancyNote && (
                      <p className="text-[10px] text-slate-500 italic px-1">
                        {rwVerification.discrepancyNote}
                      </p>
                    )}
                  </div>
                )}

                {/* Show retry hint when AI verification failed */}
                {rwFile && !rwAnalyzing && !rwVerification && (
                  <p className="text-[10px] text-red-600 font-bold bg-red-50 p-2 rounded-lg flex items-center gap-1.5">
                    <AlertTriangle size={12} /> AI verification failed. Please re-upload the screenshot to try again.
                  </p>
                )}

                <button
                  onClick={submitReturnWindowScreenshot}
                  disabled={
                    isUploading ||
                    rwAnalyzing ||
                    !rwFile ||
                    // Block submit until AI verification succeeds
                    !rwVerification ||
                    // Block submit when screenshot is cropped/incomplete
                    !!rwVerification.screenshotCropped ||
                    // Block submit when critical checks fail
                    !rwVerification.orderIdMatch ||
                    !rwVerification.productNameMatch ||
                    !rwVerification.returnWindowClosed ||
                    !rwVerification.amountMatch ||
                    (!rwVerification.soldByMatch && !!selectedOrder?.soldBy) ||
                    (!rwVerification.reviewerNameMatch && !!selectedOrder?.reviewerName)
                  }
                  className="w-full py-3.5 bg-black text-white font-bold rounded-2xl hover:bg-zinc-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isUploading ? 'Submitting...' : rwAnalyzing ? 'Verifying...' : 'Submit Return Window Proof'}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="text-[10px] font-bold text-slate-400 uppercase ml-1 block">
                  Proof
                </label>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-2.5">
                  <p className="text-[10px] text-blue-700 font-bold flex items-center gap-1.5">
                    <CheckCircle2 size={12} /> AI will verify Order ID, Amount, and Product Name before accepting.
                  </p>
                </div>
                <label className="block w-full rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center cursor-pointer hover:border-slate-300">
                  <div className="text-sm font-bold text-slate-700">Choose an image</div>
                  <div className="text-[11px] text-slate-400 font-bold mt-1">PNG/JPG</div>
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={handleFileUpload}
                    disabled={isUploading}
                  />
                </label>
                {isUploading && (
                  <div className="text-xs font-bold text-slate-500 flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> Uploading...
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
