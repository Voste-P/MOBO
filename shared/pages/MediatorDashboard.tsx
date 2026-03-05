import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { api, asArray } from '../services/api';
import { exportToGoogleSheet } from '../utils/exportToSheets';
import { subscribeRealtime } from '../services/realtime';
import { normalizeMobileTo10Digits } from '../utils/mobiles';
import { formatCurrency } from '../utils/formatCurrency';
import { getPrimaryOrderId } from '../utils/orderHelpers';
import { csvSafe, downloadCsv as downloadCsvFile } from '../utils/csvHelpers';
import { formatErrorMessage } from '../utils/errors';
import { ProxiedImage } from '../components/ProxiedImage';
import { User, Campaign, Order, Product, Ticket } from '../types';
import {
  LayoutGrid,
  Tag,
  Users,
  Wallet,
  ArrowUpRight,
  X,
  Check,
  Copy,
  CheckCircle2,
  ChevronRight,
  Bell,
  Star,
  CreditCard,
  ShoppingBag,
  FileText,
  ExternalLink,
  ShieldCheck,
  RefreshCcw,
  ArrowRightLeft,
  QrCode,
  User as UserIcon,
  LogOut,
  Save,
  Camera,
  CalendarClock,
  HelpCircle,
  AlertTriangle,
  Sparkles,
  Search,
  Download,
  Package,
  FileSpreadsheet,
} from 'lucide-react';

import { EmptyState, Spinner } from '../components/ui';
import { ProofImage } from '../components/ProofImage';
import { RatingVerificationBadge, ReturnWindowVerificationBadge } from '../components/AiVerificationBadge';
import { MobileTabBar } from '../components/MobileTabBar';
import { RaiseTicketModal } from '../components/RaiseTicketModal';
import { FeedbackCard } from '../components/FeedbackCard';

// --- UTILS ---
// formatCurrency, getPrimaryOrderId, csvSafe, downloadCsv, urlToBase64 imported from shared/utils

const downloadCsv = (filename: string, headers: string[], rows: string[][]) => {
  const csv = [headers.map(h => csvSafe(h)).join(','), ...rows.map((r) => r.map(v => csvSafe(v)).join(','))].join('\n');
  downloadCsvFile(filename, csv);
};

const matchesSearch = (query: string, ...fields: (string | undefined)[]) => {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f && f.toLowerCase().includes(q));
};

const formatRelativeTime = (iso?: string) => {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const deltaMs = Date.now() - t;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

// --- COMPONENTS ---

// --- VIEWS ---

const InboxView = ({ orders, pendingUsers, tickets, loading, onRefresh, onViewProof, onGoToUnpublished, unpublishedCount }: any) => {
  // Verification queue is workflow-driven.
  // Orders can remain UNDER_REVIEW even after purchase verification if review/rating is still pending.
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [ticketFilter, setTicketFilter] = useState<'All' | 'Open' | 'Resolved' | 'Rejected'>('All');

  const actionRequiredOrders = useMemo(() =>
    orders.filter((o: Order) => String(o.workflowStatus || '') === 'UNDER_REVIEW')
      .filter((o: Order) => matchesSearch(searchQuery, o.items[0]?.title, o.buyerName, getPrimaryOrderId(o))),
    [orders, searchQuery]
  );
  const coolingOrders = useMemo(() =>
    orders.filter((o: Order) => o.affiliateStatus === 'Pending_Cooling')
      .filter((o: Order) => matchesSearch(searchQuery, o.items[0]?.title, o.buyerName, getPrimaryOrderId(o))),
    [orders, searchQuery]
  );

  // [PERF] Memoize disputed order IDs
  const disputedOrderIds = useMemo(() => new Set(
    tickets.filter((t: Ticket) => t.status === 'Open').map((t: Ticket) => t.orderId)
  ), [tickets]);

  const [viewMode, setViewMode] = useState<'todo' | 'cooling'>('todo');
  const [sheetsExporting, setSheetsExporting] = useState(false);

  // [PERF] Memoize all earnings/stats calculations
  const { todayEarnings, totalDeals, totalEarnings, totalOrderValue, settledOrders, pendingOrders } = useMemo(() => {
    const todayStr = new Date().toDateString();
    return {
      todayEarnings: orders
        .filter((o: Order) => {
          if (new Date(o.createdAt).toDateString() !== todayStr) return false;
          const status = String(o.affiliateStatus || '');
          return status === 'Approved_Settled' || status === 'Pending_Cooling';
        })
        .reduce((acc: number, o: Order) => acc + (o.items[0]?.commission || 0), 0),
      totalDeals: orders.length,
      totalEarnings: orders
        .filter((o: Order) => {
          const status = String(o.affiliateStatus || '');
          return status === 'Approved_Settled' || status === 'Pending_Cooling';
        })
        .reduce((acc: number, o: Order) => acc + (o.items[0]?.commission || 0), 0),
      totalOrderValue: orders.reduce((acc: number, o: Order) => acc + (o.total || 0), 0),
      settledOrders: orders.filter((o: Order) => String(o.affiliateStatus || '') === 'Approved_Settled'),
      pendingOrders: orders.filter((o: Order) => {
        const s = String(o.affiliateStatus || '');
        return s === 'Pending_Cooling' || s === 'Pending_Verification';
      }),
    };
  }, [orders]);

  const getDealTypeBadge = (dealType: string) => {
    switch (dealType) {
      case 'Rating':
        return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'Review':
        return 'bg-purple-100 text-purple-700 border-purple-200';
      default:
        return 'bg-blue-100 text-blue-700 border-blue-200';
    }
  };

  return (
    <div className="space-y-6 animate-enter">
      {/* Header Stats */}
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide px-1 snap-x">
        <div className="min-w-[150px] bg-[#18181B] p-4 rounded-[1.5rem] shadow-xl relative overflow-hidden snap-center flex-1">
          <div className="absolute top-0 right-0 w-24 h-24 bg-[#CCF381]/10 rounded-full blur-2xl -mr-6 -mt-6"></div>
          <div className="relative z-10">
            <p className="text-zinc-500 text-[10px] font-black uppercase tracking-widest mb-1">
              Today's Profit
            </p>
            <h2 className="text-3xl font-black text-[#CCF381] tracking-tighter leading-none">
              {formatCurrency(todayEarnings)}
            </h2>
          </div>
        </div>

        <div className="min-w-[120px] bg-white border border-zinc-100 p-4 rounded-[1.5rem] shadow-sm relative overflow-hidden snap-center">
          <p className="text-zinc-400 text-[10px] font-black uppercase tracking-widest mb-1">
            Total Deals
          </p>
          <h2 className="text-3xl font-black text-zinc-900 tracking-tighter leading-none">
            {totalDeals}
          </h2>
        </div>

        <div
          className="min-w-[130px] bg-white border border-zinc-100 p-4 rounded-[1.5rem] shadow-sm relative overflow-hidden snap-center cursor-pointer hover:border-lime-200 hover:shadow-md transition-all active:scale-95"
          onClick={onGoToUnpublished}
        >
          <p className="text-zinc-400 text-[10px] font-black uppercase tracking-widest mb-1">
            Unpublished
          </p>
          <h2 className="text-3xl font-black text-zinc-900 tracking-tighter leading-none">
            {unpublishedCount ?? 0}
          </h2>
          <p className="text-[9px] text-lime-600 font-bold mt-1">Tap to publish →</p>
        </div>
      </div>

      {/* Finance Summary Bar */}
      <div className="bg-white border border-zinc-100 rounded-[1.5rem] p-4 shadow-sm">
        <h3 className="text-xs font-black uppercase text-zinc-400 tracking-widest mb-3">Finance Overview</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-zinc-50 rounded-xl p-3 text-center">
            <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Total Earnings</p>
            <p className="text-lg font-black text-lime-600">{formatCurrency(totalEarnings)}</p>
          </div>
          <div className="bg-zinc-50 rounded-xl p-3 text-center">
            <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Order Value</p>
            <p className="text-lg font-black text-zinc-900">{formatCurrency(totalOrderValue)}</p>
          </div>
          <div className="bg-zinc-50 rounded-xl p-3 text-center">
            <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Settled</p>
            <p className="text-lg font-black text-green-600">{settledOrders.length}</p>
          </div>
          <div className="bg-zinc-50 rounded-xl p-3 text-center">
            <p className="text-[10px] font-bold text-zinc-400 uppercase mb-1">Pending</p>
            <p className="text-lg font-black text-orange-500">{pendingOrders.length}</p>
          </div>
        </div>
      </div>

      {/* New Joiners */}
      {pendingUsers.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3 px-1">
            <h3 className="font-bold text-base text-zinc-900 tracking-tight">New Joiners</h3>
            <span className="bg-orange-100 text-orange-700 text-[9px] font-bold px-2 py-0.5 rounded-full">
              {pendingUsers.length} requests
            </span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide px-1 snap-x">
            {pendingUsers.map((u: User) => (
              <div
                key={u.id}
                className="min-w-[220px] bg-white p-3 rounded-[1.2rem] border border-zinc-100 shadow-sm flex items-center justify-between snap-center"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-orange-100 text-orange-600 rounded-[0.8rem] flex items-center justify-center font-black text-sm shadow-inner overflow-hidden">
                    {u.avatar ? (
                      <ProxiedImage
                        src={u.avatar}
                        alt={u.name ? `${u.name} avatar` : 'Avatar'}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      (u.name || '?').charAt(0)
                    )}
                  </div>
                  <div>
                    <h4 className="font-bold text-zinc-900 text-xs line-clamp-1">{u.name || 'Unknown'}</h4>
                    <p className="text-[10px] text-zinc-400 font-mono tracking-wide">{u.mobile}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Approve ${u.name}`}
                    title="Approve"
                    onClick={() =>
                      api.ops
                        .approveUser(u.id)
                        .then(onRefresh)
                        .catch((e: any) => toast.error(String(e?.message || 'Failed to approve user')))
                    }
                    className="w-8 h-8 rounded-lg bg-zinc-900 text-white flex items-center justify-center hover:bg-[#CCF381] hover:text-black transition-all shadow-md active:scale-90"
                  >
                    <Check size={14} strokeWidth={3} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Reject ${u.name}`}
                    title="Reject"
                    onClick={() =>
                      api.ops
                        .rejectUser(u.id)
                        .then(onRefresh)
                        .catch((e: any) => toast.error(String(e?.message || 'Failed to reject user')))
                    }
                    className="w-8 h-8 rounded-lg bg-zinc-50 text-zinc-400 flex items-center justify-center hover:bg-red-50 hover:text-red-500 transition-all active:scale-90"
                  >
                    <X size={14} strokeWidth={3} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Search + Export */}
      <div className="flex gap-2 items-center">
        <div className="flex-1 relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search orders..."
            className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-zinc-100 bg-white text-xs font-medium focus:border-zinc-300 focus:ring-2 focus:ring-zinc-100 outline-none"
          />
        </div>
        <button
          type="button"
          aria-label="Export orders CSV"
          title="Export orders CSV"
          onClick={() => {
            const allOrders = orders as Order[];
            if (!allOrders.length) { toast.error('No orders to export'); return; }
            const mediatorHeaders = [
              'External Order ID', 'Date', 'Time', 'Product', 'Platform', 'Brand', 'Deal Type',
              'Unit Price (₹)', 'Quantity', 'Total (₹)', 'Commission (₹)', 'Settlement Date',
              'Agency Name', 'Buyer Name', 'Buyer Mobile', 'Reviewer Name',
              'Workflow Status', 'Affiliate Status', 'Payment Status',
              'Sold By', 'Order Date', 'Extracted Product',
              'Internal Ref',
            ];
            downloadCsv(
              `mediator-orders-${new Date().toISOString().slice(0, 10)}.csv`,
              mediatorHeaders,
              allOrders.map((o) => {
                const d = new Date(o.createdAt);
                const item = o.items?.[0];
                return [
                  getPrimaryOrderId(o),
                  d.toLocaleDateString(),
                  d.toLocaleTimeString(),
                  item?.title || '',
                  item?.platform || '',
                  item?.brandName || '',
                  item?.dealType || 'Discount',
                  String(item?.priceAtPurchase ?? 0),
                  String(item?.quantity || 1),
                  String(o.total || 0),
                  String(item?.commission || 0),
                  (o as any).expectedSettlementDate ? new Date((o as any).expectedSettlementDate).toLocaleDateString() : '',
                  o.agencyName || 'Direct',
                  o.buyerName || '',
                  o.buyerMobile || '',
                  (o as any).reviewerName || '',
                  o.workflowStatus || '',
                  o.affiliateStatus || '',
                  o.paymentStatus || '',
                  o.soldBy || '',
                  o.orderDate ? new Date(o.orderDate).toLocaleDateString() : '',
                  o.extractedProductName || '',
                  o.id,
                ];
              })
            );
            toast.success('Orders exported');
          }}
          className="p-2.5 rounded-xl border border-zinc-100 bg-white hover:bg-zinc-50 transition-colors"
        >
          <Download size={14} className="text-zinc-600" />
        </button>
        <button
          type="button"
          aria-label="Export to Google Sheets"
          title="Export to Google Sheets"
          disabled={sheetsExporting}
          onClick={() => {
            const allOrders = orders as Order[];
            if (!allOrders.length) { toast.error('No orders to export'); return; }
            exportToGoogleSheet({
              title: `Mediator Orders - ${new Date().toISOString().slice(0, 10)}`,
              headers: [
                'External Order ID', 'Date', 'Time', 'Product', 'Platform', 'Brand', 'Deal Type',
                'Unit Price (₹)', 'Quantity', 'Total (₹)', 'Commission (₹)', 'Settlement Date',
                'Agency Name', 'Buyer Name', 'Buyer Mobile', 'Reviewer Name',
                'Workflow Status', 'Affiliate Status', 'Payment Status',
                'Sold By', 'Order Date', 'Extracted Product', 'Internal Ref',
              ],
              rows: allOrders.map((o) => {
                const d = new Date(o.createdAt);
                const item = o.items?.[0];
                return [
                  getPrimaryOrderId(o),
                  d.toLocaleDateString(),
                  d.toLocaleTimeString(),
                  item?.title || '',
                  item?.platform || '',
                  item?.brandName || '',
                  item?.dealType || 'Discount',
                  item?.priceAtPurchase ?? 0,
                  item?.quantity || 1,
                  o.total || 0,
                  item?.commission || 0,
                  (o as any).expectedSettlementDate ? new Date((o as any).expectedSettlementDate).toLocaleDateString() : '',
                  o.agencyName || 'Direct',
                  o.buyerName || '',
                  o.buyerMobile || '',
                  (o as any).reviewerName || '',
                  o.workflowStatus || '',
                  o.affiliateStatus || '',
                  o.paymentStatus || '',
                  o.soldBy || '',
                  o.orderDate ? new Date(o.orderDate).toLocaleDateString() : '',
                  o.extractedProductName || '',
                  o.id,
                ] as (string | number)[];
              }),
              sheetName: 'Orders',
              onStart: () => setSheetsExporting(true),
              onEnd: () => setSheetsExporting(false),
              onSuccess: () => toast.success('Exported to Google Sheets!'),
              onError: (msg) => toast.error(msg),
            });
          }}
          className="p-2.5 rounded-xl border border-green-100 bg-white hover:bg-green-50 transition-colors disabled:opacity-50"
        >
          <FileSpreadsheet size={14} className="text-green-600" />
        </button>
      </div>

      {/* Order Verification Section */}
      <section>
        <div className="flex gap-2 mb-4 bg-zinc-100 p-1 rounded-xl">
          <button
            type="button"
            aria-pressed={viewMode === 'todo'}
            onClick={() => setViewMode('todo')}
            className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${viewMode === 'todo' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            Verify ({actionRequiredOrders.length})
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'cooling'}
            onClick={() => setViewMode('cooling')}
            className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${viewMode === 'cooling' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            Cooling Period ({coolingOrders.length})
          </button>
        </div>

        {(viewMode === 'todo' ? actionRequiredOrders : coolingOrders).length === 0 ? (
          loading ? (
            <EmptyState
              title="Loading orders"
              description="Fetching the latest verification queue."
              icon={<Spinner className="w-5 h-5 text-zinc-400" />}
            />
          ) : (
            <EmptyState
              title={viewMode === 'todo' ? 'No orders to verify' : 'No orders in cooling'}
              description={
                viewMode === 'todo'
                  ? 'New verified purchases will appear here for review.'
                  : 'These orders are waiting out the cooling period.'
              }
              icon={
                viewMode === 'todo' ? (
                  <CheckCircle2 size={22} className="text-zinc-400" />
                ) : (
                  <CalendarClock size={22} className="text-zinc-400" />
                )
              }
            />
          )
        ) : (
          <div className="space-y-3">
            {(viewMode === 'todo' ? actionRequiredOrders : coolingOrders).map((o: Order) => {
              const dealType = o.items?.[0]?.dealType || 'Discount';
              const settleDate = o.expectedSettlementDate
                ? new Date(o.expectedSettlementDate).toDateString()
                : 'N/A';
              const isDisputed = disputedOrderIds.has(o.id);
              const purchaseVerified = !!o.verification?.orderVerified;
              const missingProofs = o.requirements?.missingProofs ?? [];
              const missingVerifications = o.requirements?.missingVerifications ?? [];

              const stepLabel =
                !purchaseVerified
                  ? 'Needs purchase verification'
                  : missingProofs.length > 0
                    ? `Waiting on buyer: ${missingProofs.join(' + ')}`
                    : missingVerifications.length > 0
                      ? `Awaiting approval: ${missingVerifications.join(' + ')}`
                      : 'Ready';

              return (
                <div
                  key={o.id}
                  className={`bg-white p-2 rounded-[1.5rem] border shadow-sm relative overflow-hidden group hover:shadow-md transition-all duration-300 ${isDisputed ? 'border-red-200 ring-2 ring-red-100' : 'border-zinc-100'}`}
                >
                  {isDisputed && (
                    <div className="absolute top-0 right-0 bg-red-500 text-white text-[9px] font-bold px-2 py-1 rounded-bl-xl z-20 flex items-center gap-1">
                      <AlertTriangle size={10} /> DISPUTED
                    </div>
                  )}
                  <div className="p-2 pb-0 flex gap-3 mb-3">
                    <div className="w-14 h-14 bg-[#F4F4F5] rounded-[1rem] p-1.5 flex-shrink-0 relative overflow-hidden">
                      <ProxiedImage
                        src={o.items?.[0]?.image}
                        alt={o.items?.[0]?.title || 'Order item'}
                        className="w-full h-full object-contain mix-blend-multiply relative z-10"
                      />
                    </div>
                    <div className="min-w-0 flex-1 py-0.5">
                      <div className="flex justify-between items-start">
                        <h4 className="font-bold text-zinc-900 text-sm line-clamp-1 pr-2">
                          {o.items?.[0]?.title}
                        </h4>
                        <span
                          className={`text-[9px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap uppercase border ${getDealTypeBadge(dealType)}`}
                        >
                          {dealType === 'Discount' ? 'Purchase' : dealType}
                        </span>
                      </div>
                      {viewMode === 'todo' && (
                        <div className="mt-1 text-[10px] font-bold text-zinc-500">
                          {stepLabel}
                        </div>
                      )}
                      <div className="mt-1 flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <span className="font-semibold text-zinc-400">Buyer:</span>
                          <span className="font-bold text-zinc-900 truncate max-w-[80px]">
                            {o.buyerName}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-[11px]">
                          <span className="font-black text-zinc-900">
                            {formatCurrency(o.total)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {viewMode === 'todo' ? (
                    <div className="grid grid-cols-1 p-1 pt-0">
                      <button
                        type="button"
                        onClick={() => !isDisputed && onViewProof(o)}
                        disabled={isDisputed}
                        className={`py-3 rounded-[1rem] font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 ${
                          isDisputed
                            ? 'bg-red-50 text-red-400 cursor-not-allowed'
                            : 'bg-[#18181B] text-white hover:bg-[#CCF381] hover:text-black hover:shadow-md'
                        }`}
                      >
                        {isDisputed ? (
                          <>
                            <ShieldCheck size={16} /> Locked by Dispute
                          </>
                        ) : (
                          <>
                            <ShieldCheck size={16} /> {purchaseVerified ? 'Review Steps' : 'Verify Purchase'}
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="bg-zinc-50 p-2 mx-1 mb-1 rounded-xl flex justify-between items-center px-3">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide flex items-center gap-1">
                        <CalendarClock size={12} /> Unlocks
                      </span>
                      <span className="text-xs font-bold text-zinc-900">{settleDate}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Tickets */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="font-bold text-base text-zinc-900 tracking-tight">Tickets</h3>
          <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
            {Array.isArray(tickets) ? tickets.length : 0}
          </span>
        </div>
        {/* Status filter tabs */}
        {tickets && tickets.length > 0 && (
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            {(['All', 'Open', 'Resolved', 'Rejected'] as const).map(f => {
              const count = f === 'All' ? tickets.length : tickets.filter((t: Ticket) => String(t.status) === f).length;
              return (
                <button key={f} type="button" onClick={() => setTicketFilter(f)}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition-all ${
                    ticketFilter === f
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                      : 'bg-white text-zinc-600 border-zinc-200 hover:border-indigo-300'
                  }`}>
                  {f} ({count})
                </button>
              );
            })}
          </div>
        )}
        {(!tickets || tickets.length === 0) ? (
          <EmptyState
            title="No tickets"
            description="Support tickets will appear here."
            icon={<HelpCircle size={22} className="text-zinc-400" />}
          />
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto scrollbar-styled">
            {tickets.filter((t: Ticket) => ticketFilter === 'All' || String(t.status) === ticketFilter).map((t: Ticket) => (
              <div
                key={t.id}
                className="rounded-xl border border-zinc-100 bg-white px-3 py-3 shadow-sm space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-zinc-900 truncate">{String(t.issueType || 'Ticket')}</span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                        String(t.status) === 'Resolved' ? 'bg-emerald-50 text-emerald-600' :
                        String(t.status) === 'Rejected' ? 'bg-red-50 text-red-600' :
                        'bg-amber-50 text-amber-600'
                      }`}>{String(t.status || 'Open')}</span>
                    </div>
                    {t.priority && <div className="text-[9px] text-zinc-400 mt-0.5">Priority: {String(t.priority)}</div>}
                  </div>
                  <span className="text-[9px] text-zinc-400 shrink-0">{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : ''}</span>
                </div>
                {t.description && (
                  <div className="text-[10px] text-zinc-600 bg-zinc-50 rounded-lg px-2 py-1.5 line-clamp-3">
                    &ldquo;{String(t.description)}&rdquo;
                  </div>
                )}
                {(t as any).userName && (
                  <div className="text-[9px] text-zinc-400">From: {String((t as any).userName)} ({String((t as any).userRole || '')})</div>
                )}
                {(t as any).resolutionNote && (
                  <div className="text-[10px] text-green-700 bg-green-50 rounded-lg px-2 py-1.5">
                    <span className="font-bold">Resolution:</span> {String((t as any).resolutionNote)}
                  </div>
                )}
                {(String(t.status) === 'Resolved' || String(t.status) === 'Rejected') && ((t as any).resolvedByName || (t as any).resolvedAt) && (
                  <div className="text-[9px] text-zinc-400">
                    {String(t.status) === 'Resolved' ? 'Resolved' : 'Rejected'}
                    {(t as any).resolvedByName ? ` by ${String((t as any).resolvedByName)}` : ''}
                    {(t as any).resolvedAt ? ` on ${new Date(String((t as any).resolvedAt)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}
                  </div>
                )}
                <div className="flex items-center gap-1.5 justify-end">
                  {String(t.status || '').toLowerCase() === 'open' && (
                    <>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const note = window.prompt('Resolution note (optional):');
                            await api.tickets.update(t.id, 'Resolved', note || undefined);
                            toast.success('Ticket resolved.');
                            onRefresh();
                          } catch (err: any) {
                            toast.error(formatErrorMessage(err, 'Failed to resolve ticket.'));
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100"
                      >
                        ✓ Resolve
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const note = window.prompt('Rejection reason (optional):');
                            await api.tickets.update(t.id, 'Rejected', note || undefined);
                            toast.success('Ticket rejected.');
                            onRefresh();
                          } catch (err: any) {
                            toast.error(formatErrorMessage(err, 'Failed to reject ticket.'));
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-red-50 border border-red-200 text-red-600 hover:bg-red-100"
                      >
                        ✗ Reject
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.tickets.escalate(t.id);
                            toast.success('Ticket escalated to agency.');
                            onRefresh();
                          } catch (err: any) {
                            toast.error(formatErrorMessage(err, 'Failed to escalate ticket.'));
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-violet-50 border border-violet-200 text-violet-700 hover:bg-violet-100"
                      >
                        ↑ Escalate
                      </button>
                    </>
                  )}
                  {String(t.status || '').toLowerCase() !== 'open' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.tickets.delete(t.id);
                          toast.success('Ticket deleted.');
                          onRefresh();
                        } catch (err: any) {
                          toast.error(formatErrorMessage(err, 'Failed to delete ticket.'));
                        }
                      }}
                      className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-zinc-50 border border-zinc-200 text-zinc-600 hover:text-red-600 hover:border-red-200"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const MarketView = ({ campaigns, deals, loading, user, onRefresh, onPublish }: any) => {
  const { toast } = useToast();
  const { confirm, ConfirmDialogElement } = useConfirm();
  const [marketSearch, setMarketSearch] = useState('');
  const dealByCampaignId = useMemo(() => {
    const m = new Map<string, Product>();
    (deals || []).forEach((d: Product) => {
      if (d?.campaignId) m.set(String(d.campaignId), d);
    });
    return m;
  }, [deals]);

  const campaignById = useMemo(() => {
    const m = new Map<string, Campaign>();
    (campaigns || []).forEach((c: Campaign) => m.set(String(c.id), c));
    return m;
  }, [campaigns]);

  const unpublishedCampaigns = useMemo(() => {
    return (campaigns || []).filter((c: Campaign) => !dealByCampaignId.has(String(c.id)))
      .filter((c: Campaign) => matchesSearch(marketSearch, c.title, c.platform, c.brand));
  }, [campaigns, dealByCampaignId, marketSearch]);

  const filteredDeals = useMemo(() => {
    if (!Array.isArray(deals)) return [];
    return deals.filter((d: Product) => matchesSearch(marketSearch, d.title, d.platform));
  }, [deals, marketSearch]);

  const [mode, setMode] = useState<'published' | 'unpublished'>('unpublished');

  return (
    <div className="space-y-5 animate-enter">
      {ConfirmDialogElement}
      <div className="bg-[#18181B] p-5 rounded-[1.5rem] shadow-xl text-white relative overflow-hidden">
        <div className="absolute top-[-50%] right-[-10%] w-40 h-40 bg-[#CCF381] rounded-full blur-[60px] opacity-20 animate-pulse"></div>
        <div className="relative z-10">
          <h2 className="text-xl font-black mb-1 tracking-tight">Inventory Deck</h2>
          <p className="text-zinc-400 text-xs font-medium">
            Published deals are separated from unpublished inventory.
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={marketSearch}
          onChange={(e) => setMarketSearch(e.target.value)}
          placeholder="Search deals & campaigns..."
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-zinc-100 bg-white text-xs font-medium focus:border-zinc-300 focus:ring-2 focus:ring-zinc-100 outline-none"
        />
      </div>

      <div className="bg-white rounded-[1.5rem] border border-zinc-100 shadow-sm p-1">
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            aria-pressed={mode === 'published'}
            onClick={() => setMode('published')}
            className={`px-4 py-3 rounded-[1.2rem] font-black text-xs transition-all flex items-center justify-center gap-2 ${
              mode === 'published'
                ? 'bg-zinc-900 text-white shadow-md'
                : 'bg-transparent text-zinc-500 hover:bg-zinc-50'
            }`}
          >
            Published
            <span
              className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                mode === 'published' ? 'bg-white/15 text-white' : 'bg-zinc-100 text-zinc-600'
              }`}
            >
              {Array.isArray(deals) ? deals.length : 0}
            </span>
          </button>
          <button
            type="button"
            aria-pressed={mode === 'unpublished'}
            onClick={() => setMode('unpublished')}
            className={`px-4 py-3 rounded-[1.2rem] font-black text-xs transition-all flex items-center justify-center gap-2 ${
              mode === 'unpublished'
                ? 'bg-zinc-900 text-white shadow-md'
                : 'bg-transparent text-zinc-500 hover:bg-zinc-50'
            }`}
          >
            Unpublished
            <span
              className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                mode === 'unpublished' ? 'bg-white/15 text-white' : 'bg-zinc-100 text-zinc-600'
              }`}
            >
              {unpublishedCampaigns.length}
            </span>
          </button>
        </div>
      </div>

      {mode === 'published' ? (
        <div>
          <div className="flex items-center justify-between px-1 mb-3">
            <h3 className="font-bold text-base text-zinc-900 tracking-tight">Published Deals</h3>
            <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">
              {filteredDeals.length}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4">
            {filteredDeals.length === 0 ? (
              <div className="bg-white rounded-[1.5rem] border border-zinc-100 p-4">
                {loading ? (
                  <EmptyState
                    title="Loading deals"
                    description="Loading your published inventory."
                    icon={<Spinner className="w-5 h-5 text-zinc-400" />}
                    className="bg-transparent border-0 py-10"
                  />
                ) : (
                  <EmptyState
                    title="No Published Deals"
                    description="Publish inventory to make it available to buyers."
                    icon={<Tag size={22} className="text-zinc-400" />}
                    className="bg-transparent border-0 py-10"
                  />
                )}
              </div>
            ) : (
              filteredDeals.map((d: Product) => (
                <div
                  key={String(d.id)}
                  className="bg-white p-4 rounded-[1.5rem] border border-zinc-100 shadow-sm flex flex-col relative overflow-hidden"
                >
                  <div className="flex gap-4 mb-4">
                    <div className="w-16 h-16 bg-[#F4F4F5] rounded-[1rem] p-2 flex-shrink-0">
                        <ProxiedImage
                          src={d.image}
                          alt={d.title}
                          className="w-full h-full object-contain mix-blend-multiply"
                        />
                    </div>
                    <div className="flex-1 min-w-0 py-0.5">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest border border-zinc-100 px-1.5 py-0.5 rounded-md">
                          {d.platform}
                        </span>
                        <span className="bg-emerald-500/10 text-emerald-700 text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wide">
                          Published
                        </span>
                      </div>
                      <h4 className="font-bold text-zinc-900 text-base leading-tight line-clamp-1 mb-1">
                        {d.title}
                      </h4>
                      {d.campaignId && (
                        <span
                          className="text-[8px] text-zinc-400 font-mono cursor-pointer hover:text-zinc-600 transition-colors mb-1 block"
                          title="Click to copy Campaign ID"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(String(d.campaignId));
                            toast.success('Campaign ID copied');
                          }}
                        >
                          ID: {String(d.campaignId).slice(-8)}
                        </span>
                      )}
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1">
                          <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                            Price
                          </p>
                          <p className="text-sm font-black text-zinc-900">{formatCurrency(d.price)}</p>
                        </div>
                        {typeof d.commission === 'number' && (
                          <div className="flex items-center gap-1">
                            <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                              Commission
                            </p>
                            <p className={`text-sm font-black ${d.commission < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                              {d.commission < 0 ? `−${formatCurrency(Math.abs(d.commission))}` : formatCurrency(d.commission)}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      const campaign = d.campaignId ? campaignById.get(String(d.campaignId)) : null;
                      if (campaign) {
                        onPublish(campaign);
                      } else {
                        toast.error('Campaign data not found for this deal');
                      }
                    }}
                    className="w-full py-3 bg-[#18181B] text-white rounded-[1rem] font-bold text-xs shadow-md hover:bg-[#CCF381] hover:text-black transition-all active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    <ArrowUpRight size={14} strokeWidth={2.5} /> Edit Deal
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between px-1 mb-3">
            <h3 className="font-bold text-base text-zinc-900 tracking-tight">Unpublished Inventory</h3>
            <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">
              {unpublishedCampaigns.length}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {unpublishedCampaigns.length === 0 ? (
              <div className="bg-white rounded-[1.5rem] border border-zinc-100 p-4">
                {loading ? (
                  <EmptyState
                    title="Loading inventory"
                    description="Fetching campaigns and assignments."
                    icon={<Spinner className="w-5 h-5 text-zinc-400" />}
                    className="bg-transparent border-0 py-10"
                  />
                ) : (
                  <EmptyState
                    title="No Unpublished Inventory"
                    description="Everything in your deck is already published."
                    icon={<Tag size={22} className="text-zinc-400" />}
                    className="bg-transparent border-0 py-10"
                  />
                )}
              </div>
            ) : (
              unpublishedCampaigns.map((c: Campaign) => (
                <div
                  key={c.id}
                  className="bg-white p-4 rounded-[1.5rem] border border-zinc-100 shadow-sm flex flex-col relative overflow-hidden hover:shadow-lg transition-all duration-300"
                >
                  <div className="flex gap-4 mb-4">
                    <div className="w-16 h-16 bg-[#F4F4F5] rounded-[1rem] p-2 flex-shrink-0">
                        <ProxiedImage
                          src={c.image}
                          alt={c.title}
                          className="w-full h-full object-contain mix-blend-multiply"
                        />
                    </div>
                    <div className="flex-1 min-w-0 py-0.5">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest border border-zinc-100 px-1.5 py-0.5 rounded-md">
                          {c.platform}
                        </span>
                        <span className="bg-[#CCF381]/20 text-[#5f7a28] text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wide">
                          {c.assignments[user.mediatorCode!] || 0} Slots
                        </span>
                      </div>
                      <h4 className="font-bold text-zinc-900 text-base leading-tight line-clamp-1 mb-1">
                        {c.title}
                      </h4>
                      <span
                        className="text-[8px] text-zinc-400 font-mono cursor-pointer hover:text-zinc-600 transition-colors mb-1 block"
                        title="Click to copy Campaign ID"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(String(c.id));
                          toast.success('Campaign ID copied');
                        }}
                      >
                        ID: {String(c.id).slice(-8)}
                      </span>
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                          Cost
                        </p>
                        <p className="text-sm font-black text-zinc-900">{formatCurrency(c.price)}</p>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onPublish(c)}
                      className="w-full py-3 bg-[#18181B] text-white rounded-[1rem] font-bold text-xs hover:bg-[#CCF381] hover:text-black transition-all shadow-md active:scale-95 flex items-center justify-center gap-1.5"
                    >
                      <ArrowUpRight size={14} strokeWidth={2.5} /> Configure & Publish
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          if (!(await confirm({ message: 'Delete this unpublished campaign?', confirmLabel: 'Delete', variant: 'destructive' }))) return;
                          await api.ops.deleteCampaign(String(c.id));
                          toast.success('Campaign deleted.');
                          onRefresh?.();
                        } catch (err) {
                          toast.error(formatErrorMessage(err, 'Failed to delete campaign'));
                        }
                      }}
                      className="w-full py-3 bg-red-50 text-red-600 rounded-[1rem] font-bold text-xs border border-red-200 hover:bg-red-100 transition-all shadow-sm active:scale-95"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const SquadView = ({ user, pendingUsers, verifiedUsers, loading, orders: _orders, onRefresh: _onRefresh, onSelectUser }: any) => {
  const { toast } = useToast();
  const [squadSearch, setSquadSearch] = useState('');
  const filteredVerified = useMemo(() =>
    verifiedUsers.filter((u: User) => matchesSearch(squadSearch, u.name, u.mobile)),
    [verifiedUsers, squadSearch]
  );
  const _filteredPending = useMemo(() =>
    pendingUsers.filter((u: User) => matchesSearch(squadSearch, u.name, u.mobile)),
    [pendingUsers, squadSearch]
  );
  return (
    <div className="space-y-5 animate-enter">
      <div
        className="bg-[#4F46E5] p-5 rounded-[1.5rem] shadow-xl shadow-indigo-500/20 text-white relative overflow-hidden group active:scale-[0.98] transition-transform cursor-pointer"
        onClick={() => {
          navigator.clipboard.writeText(user.mediatorCode!);
          toast.success('Code copied');
        }}
      >
        <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-white rounded-full blur-[60px] opacity-20 group-hover:opacity-30 transition-opacity"></div>
        <div className="relative z-10 flex flex-col items-center text-center">
          <p className="text-indigo-200 text-[10px] font-black uppercase tracking-widest mb-1">
            Your Invite Code
          </p>
          <h2 className="text-3xl font-black tracking-widest font-mono mb-3">
            {user.mediatorCode}
          </h2>
          <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-xl text-[10px] font-bold flex items-center gap-1.5 hover:bg-white/20 transition-colors border border-white/10">
            <Copy size={12} /> Tap to Copy
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white p-4 rounded-[1.2rem] border border-zinc-100 shadow-sm text-center hover:shadow-md transition-shadow">
          <p className="text-2xl font-black text-zinc-900 mb-0.5">{verifiedUsers.length}</p>
          <p className="text-[9px] text-zinc-400 font-black uppercase tracking-widest">
            Active Buyers
          </p>
        </div>
        <div className="bg-white p-4 rounded-[1.2rem] border border-zinc-100 shadow-sm text-center hover:shadow-md transition-shadow">
          <p className="text-2xl font-black text-zinc-900 mb-0.5">{pendingUsers.length}</p>
          <p className="text-[9px] text-zinc-400 font-black uppercase tracking-widest">Pending</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={squadSearch}
          onChange={(e) => setSquadSearch(e.target.value)}
          placeholder="Search buyers..."
          className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-zinc-100 bg-white text-xs font-medium focus:border-zinc-300 focus:ring-2 focus:ring-zinc-100 outline-none"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="font-bold text-base text-zinc-900 tracking-tight">Active Roster</h3>
        </div>
        <div className="bg-white rounded-[1.5rem] border border-zinc-100 shadow-sm overflow-hidden min-h-[160px]">
          {loading ? (
            <div className="p-4">
              <EmptyState
                title="Loading buyers"
                description="Fetching your active roster."
                icon={<Spinner className="w-5 h-5 text-zinc-400" />}
                className="bg-transparent border-0 py-10"
              />
            </div>
          ) : verifiedUsers.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No active buyers yet"
                description="Share your invite code to onboard buyers."
                icon={<Users size={22} className="text-zinc-400" />}
                className="bg-transparent border-0 py-10"
              />
            </div>
          ) : filteredVerified.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No matching buyers"
                description="Try a different search term."
                icon={<Search size={22} className="text-zinc-400" />}
                className="bg-transparent border-0 py-10"
              />
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {filteredVerified.map((u: User) => (
                <div
                  key={u.id}
                  onClick={() => onSelectUser(u)}
                  className="p-3 flex items-center justify-between hover:bg-zinc-50 transition-colors cursor-pointer active:bg-zinc-100"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-zinc-100 rounded-[0.8rem] flex items-center justify-center font-black text-zinc-500 text-sm overflow-hidden">
                      {u.avatar ? (
                        <ProxiedImage
                          src={u.avatar}
                          alt={u.name ? `${u.name} avatar` : 'Avatar'}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        (u.name || '?').charAt(0)
                      )}
                    </div>
                    <div>
                      <p className="font-bold text-xs text-zinc-900">{u.name || 'Unknown'}</p>
                      <p className="text-[10px] text-zinc-400 font-mono">{u.mobile}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-[10px] font-bold text-zinc-400">Wallet</p>
                      <p className="text-xs font-black text-zinc-900">
                        {formatCurrency(u.walletBalance || 0)}
                      </p>
                    </div>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center border border-zinc-100 bg-white text-zinc-400">
                      <ArrowRightLeft size={14} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const MediatorProfileView = () => {
  const { user, updateUser, logout } = useAuth();
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(user?.name || '');
  const [mobile, setMobile] = useState(user?.mobile || '');
  const [upiId, setUpiId] = useState(user?.upiId || '');
  const [bankDetails] = useState({
    accountNumber: user?.bankDetails?.accountNumber || '',
    ifsc: user?.bankDetails?.ifsc || '',
    bankName: user?.bankDetails?.bankName || '',
    holderName: user?.bankDetails?.holderName || '',
  });
  const [avatar, setAvatar] = useState(user?.avatar);
  const [qrCode, setQrCode] = useState(user?.qrCode);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qrInputRef = useRef<HTMLInputElement>(null);

  const handleSave = async () => {
    setLoading(true);
    try {
      await updateUser({
        name,
        mobile,
        upiId,
        bankDetails,
        avatar,
        qrCode,
      });
      setIsEditing(false);
      toast.success('Profile updated');
    } catch (e) {
      toast.error(formatErrorMessage(e, 'Update failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'avatar' | 'qr') => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        toast.error('Image must be under 2 MB');
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        if (type === 'avatar') setAvatar(reader.result as string);
        else setQrCode(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="animate-enter">
      <div className="flex flex-col items-center pt-6 pb-8 bg-white rounded-b-[2.5rem] shadow-sm mb-6 border border-zinc-100">
        <div
          className="relative mb-4 group cursor-pointer"
          onClick={() => isEditing && fileInputRef.current?.click()}
        >
          <div className="w-24 h-24 rounded-full bg-zinc-100 border-4 border-white shadow-lg flex items-center justify-center overflow-hidden">
            {avatar ? (
              <ProxiedImage
                src={avatar}
                alt={user?.name ? `${user.name} avatar` : 'Avatar'}
                className="w-full h-full object-cover"
              />
            ) : (
              <UserIcon size={32} className="text-zinc-300" />
            )}
          </div>
          {isEditing && (
            <div className="absolute bottom-0 right-0 bg-black text-white p-2 rounded-full border border-white shadow-md">
              <Camera size={14} />
            </div>
          )}
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            onChange={(e) => handleImageUpload(e, 'avatar')}
          />
        </div>
        <h2 className="text-xl font-black text-zinc-900">{user?.name}</h2>
        <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mt-1">
          Mediator  {user?.mediatorCode}
        </p>
      </div>

      <div className="px-4 space-y-6">
        <div className="bg-white p-6 rounded-[2rem] border border-zinc-100 shadow-sm space-y-4">
          <div className="flex justify-between items-center mb-2">
            <h3 className="font-bold text-zinc-900 flex items-center gap-2">
              <UserIcon size={16} /> Personal Info
            </h3>
            <button
              type="button"
              onClick={() => setIsEditing(!isEditing)}
              className="text-xs font-bold text-lime-600 uppercase hover:underline"
            >
              {isEditing ? 'Cancel' : 'Edit'}
            </button>
          </div>
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase ml-1 block mb-1">
              Full Name
            </label>
            <input
              type="text"
              disabled={!isEditing}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full p-3 bg-zinc-50 rounded-xl font-bold text-sm outline-none focus:ring-2 focus:ring-lime-400 disabled:opacity-70 disabled:bg-transparent disabled:border disabled:border-zinc-100"
            />
          </div>
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase ml-1 block mb-1">
              Mobile Number
            </label>
            <input
              type="tel"
              disabled={!isEditing}
              inputMode="numeric"
              maxLength={10}
              pattern="[0-9]{10}"
              value={mobile}
              onChange={(e) => setMobile(normalizeMobileTo10Digits(e.target.value))}
              className="w-full p-3 bg-zinc-50 rounded-xl font-bold text-sm outline-none focus:ring-2 focus:ring-lime-400 disabled:opacity-70 disabled:bg-transparent disabled:border disabled:border-zinc-100"
            />
          </div>
        </div>

        <div className="bg-white p-6 rounded-[2rem] border border-zinc-100 shadow-sm space-y-4">
          <h3 className="font-bold text-zinc-900 flex items-center gap-2 mb-2">
            <Wallet size={16} /> Banking & Payments
          </h3>
          <div>
            <label className="text-[10px] font-bold text-zinc-400 uppercase ml-1 block mb-1">
              UPI ID
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                disabled={!isEditing}
                value={upiId}
                onChange={(e) => setUpiId(e.target.value)}
                className="w-full p-3 bg-zinc-50 rounded-xl font-bold text-sm outline-none focus:ring-2 focus:ring-lime-400 disabled:opacity-70 disabled:bg-transparent disabled:border disabled:border-zinc-100"
                placeholder="user@upi"
              />
            </div>
          </div>
          <div
            onClick={() => isEditing && qrInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-4 flex flex-col items-center justify-center text-center transition-colors ${isEditing ? 'cursor-pointer hover:border-lime-400 hover:bg-lime-50' : 'border-zinc-100'}`}
          >
            {qrCode ? (
              <div className="relative">
                <ProxiedImage
                  src={qrCode}
                  alt="Payment QR"
                  className="h-32 w-32 object-contain rounded-lg"
                />
                {isEditing && (
                  <div className="absolute inset-0 bg-black/20 flex items-center justify-center text-white font-bold text-xs rounded-lg">
                    Change
                  </div>
                )}
              </div>
            ) : (
              <div className="py-4">
                <QrCode size={32} className="text-zinc-300 mx-auto mb-2" />
                <p className="text-xs font-bold text-zinc-400">Upload Payment QR</p>
              </div>
            )}
            <input
              type="file"
              ref={qrInputRef}
              className="hidden"
              accept="image/*"
              onChange={(e) => handleImageUpload(e, 'qr')}
            />
          </div>
        </div>

        {isEditing ? (
          <button
            type="button"
            onClick={handleSave}
            disabled={loading}
            className="w-full py-4 bg-lime-400 text-black font-extrabold rounded-2xl shadow-lg hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-2"
          >
            {loading ? (
              'Saving...'
            ) : (
              <>
                <Save size={18} /> Save Changes
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={logout}
            className="w-full py-4 bg-zinc-900 text-white font-bold rounded-2xl shadow-lg hover:bg-red-600 transition-colors flex items-center justify-center gap-2"
          >
            <LogOut size={18} /> Logout
          </button>
        )}

        {/* Feedback Section */}
        <FeedbackCard role="mediator" />
      </div>
    </div>
  );
};

const LedgerModal = ({ buyer, orders, loading, onClose, onRefresh }: any) => {
  const { toast } = useToast();
  const { confirm, ConfirmDialogElement } = useConfirm();
  const [viewMode, setViewMode] = useState<'pending' | 'settled'>('pending');
  const [settleId, setSettleId] = useState<string | null>(null);
  const [utr, setUtr] = useState('');
  const [showQr, setShowQr] = useState(false);

  const pendingOrders = orders
    .filter((o: any) => o.paymentStatus === 'Pending' || o.affiliateStatus === 'Pending_Cooling')
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const settledOrders = orders
    .filter((o: any) => o.paymentStatus === 'Paid')
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const totalLiability = pendingOrders.reduce((acc: any, o: any) => acc + o.total, 0);
  const totalPaid = settledOrders.reduce((acc: any, o: any) => acc + o.total, 0);

  const handleSettle = async () => {
    if (!settleId) return;
    if (!(await confirm({ message: 'Confirm settlement? This will move funds to buyer and mediator wallets.', title: 'Settle Payment', confirmLabel: 'Settle', variant: 'warning' }))) return;
    try {
      await api.ops.settleOrderPayment(settleId, utr.trim() || undefined, 'external');
      setSettleId(null);
      setUtr('');
      onRefresh();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to settle'));
    }
  };

  const handleRevert = async (orderId: string) => {
    if (await confirm({ message: 'Undo this settlement? Funds will be reversed.', title: 'Undo Settlement', confirmLabel: 'Undo', variant: 'destructive' })) {
      try {
        await api.ops.unsettleOrderPayment(orderId);
        onRefresh();
      } catch (err) {
        toast.error(formatErrorMessage(err, 'Failed to revert settlement'));
      }
    }
  };

  return (
    <div
      className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-md flex items-end animate-fade-in"
      onClick={onClose}
    >
      {ConfirmDialogElement}
      <div
        className="bg-[#F8F9FA] w-full rounded-t-[2.5rem] h-[92%] shadow-2xl animate-slide-up relative flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-none p-5 bg-[#18181B] rounded-t-[2.5rem] text-white pb-8">
          <div className="w-12 h-1.5 bg-white/20 rounded-full mx-auto mb-6"></div>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[0.8rem] bg-white/10 flex items-center justify-center font-bold text-sm overflow-hidden">
                {buyer.avatar ? (
                  <ProxiedImage
                    src={buyer.avatar}
                    alt={buyer.name ? `${buyer.name} avatar` : 'Avatar'}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  (buyer?.name || '?').charAt(0)
                )}
              </div>
              <div>
                <h3 className="text-xl font-black leading-none">{buyer?.name || 'Unknown'}</h3>
                <p className="text-[10px] text-zinc-400 font-mono mt-1 opacity-80">
                  {buyer.mobile}
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close ledger"
              onClick={onClose}
              className="p-2 bg-white/10 rounded-full hover:bg-white/20 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#CCF381] p-4 rounded-[1.5rem] text-black shadow-lg">
              <p className="text-[9px] font-black uppercase tracking-widest opacity-60 mb-1">
                Total Payable
              </p>
              <h2 className="text-3xl font-black tracking-tighter leading-none">
                {formatCurrency(totalLiability)}
              </h2>
            </div>
            <div className="bg-white/5 border border-white/10 p-4 rounded-[1.5rem]">
              <p className="text-[9px] font-black uppercase tracking-widest text-zinc-400 mb-1">
                Total Settled
              </p>
              <h2 className="text-2xl font-black tracking-tighter leading-none text-white">
                {formatCurrency(totalPaid)}
              </h2>
            </div>
          </div>
        </div>

        <div className="flex-none px-5 -mt-6 relative z-10">
          <div className="bg-white p-4 rounded-[1.5rem] shadow-lg border border-zinc-100 flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0">
                <CreditCard size={20} />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] font-bold text-zinc-400 uppercase">UPI Address</p>
                <p className="font-bold text-zinc-900 text-sm truncate">
                  {buyer.upiId || 'Not Linked'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {buyer.qrCode && (
                <button
                  type="button"
                  aria-label="Show payment QR"
                  onClick={() => setShowQr(true)}
                  className="p-2 hover:bg-indigo-50 text-indigo-400 hover:text-indigo-600 rounded-lg transition-colors"
                >
                  <QrCode size={18} />
                </button>
              )}
              <button
                type="button"
                aria-label="Copy UPI address"
                onClick={() => {
                  navigator.clipboard.writeText(buyer.upiId || '');
                  toast.success('Copied');
                }}
                className="p-2 hover:bg-zinc-50 rounded-lg text-zinc-400 hover:text-zinc-900 transition-colors"
              >
                <Copy size={18} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-0 pt-6">
          <div className="px-5 mb-4 flex items-center gap-2">
            <button
              type="button"
              aria-pressed={viewMode === 'pending'}
              onClick={() => setViewMode('pending')}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${viewMode === 'pending' ? 'bg-black text-white shadow-md' : 'bg-white text-zinc-500 border border-zinc-200'}`}
            >
              Unsettled ({pendingOrders.length})
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'settled'}
              onClick={() => setViewMode('settled')}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${viewMode === 'settled' ? 'bg-black text-white shadow-md' : 'bg-white text-zinc-500 border border-zinc-200'}`}
            >
              History ({settledOrders.length})
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 pb-6 space-y-3 scrollbar-styled">
            {(viewMode === 'pending' ? pendingOrders : settledOrders).length === 0 ? (
              loading ? (
                <EmptyState
                  title="Loading settlements"
                  description="Fetching the latest payment status."
                  icon={<Spinner className="w-5 h-5 text-zinc-400" />}
                  className="bg-transparent border-zinc-200/60"
                />
              ) : (
                <EmptyState
                  title={
                    viewMode === 'pending' ? 'Nothing to settle yet' : 'No settlement history yet'
                  }
                  description={
                    viewMode === 'pending'
                      ? 'When orders are verified, they will show up here for settlement.'
                      : 'Completed settlements will appear here.'
                  }
                  icon={<FileText size={22} className="text-zinc-400" />}
                  className="bg-transparent border-zinc-200/60"
                />
              )
            ) : (
              (viewMode === 'pending' ? pendingOrders : settledOrders).map((o: any) => (
                <div
                  key={o.id}
                  className="bg-white p-4 rounded-[1.5rem] border border-zinc-100 shadow-sm flex flex-col group transition-all hover:shadow-md"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-zinc-50 rounded-[0.8rem] p-1.5 flex-shrink-0">
                        <ProxiedImage
                          src={o.items?.[0]?.image}
                          alt={o.items?.[0]?.title || 'Order item'}
                          className="w-full h-full object-contain mix-blend-multiply"
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-zinc-400">
                            {getPrimaryOrderId(o)}
                          </span>
                          <span className="text-[9px] font-bold uppercase bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded">
                            {o.items?.[0]?.dealType}
                          </span>
                        </div>
                        <p className="text-xs font-bold text-zinc-900 line-clamp-1">
                          {o.items?.[0]?.title}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-black text-zinc-900">{formatCurrency(o.total)}</p>
                      <p className="text-[9px] font-bold text-zinc-400">
                        {new Date(o.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  <div className="pt-3 mt-1 border-t border-zinc-50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${viewMode === 'pending' ? 'bg-orange-500' : 'bg-green-500'}`}
                      ></span>
                      <span className="text-[10px] font-bold uppercase text-zinc-500">
                        {viewMode === 'pending' ? 'Processing' : 'Settled'}
                      </span>
                    </div>

                    {viewMode === 'pending' && (
                      <button
                        type="button"
                        onClick={() => setSettleId(o.id)}
                        className="px-4 py-2 bg-black text-white rounded-xl text-[10px] font-bold hover:bg-zinc-800 transition-colors active:scale-95 flex items-center gap-1"
                      >
                        Settle <ChevronRight size={12} />
                      </button>
                    )}
                    {viewMode === 'settled' && (
                      <button
                        type="button"
                        onClick={() => handleRevert(o.id)}
                        className="text-[10px] font-bold text-zinc-400 hover:text-red-500 flex items-center gap-1 transition-colors"
                      >
                        <RefreshCcw size={10} /> Revert
                      </button>
                    )}
                  </div>

                  {settleId === o.id && (
                    <div className="mt-3 p-3 bg-zinc-50 rounded-xl animate-enter">
                      <input
                        autoFocus
                        type="text"
                        placeholder="Enter UTR / Ref ID (Optional)"
                        value={utr}
                        onChange={(e) => setUtr(e.target.value)}
                        className="w-full bg-white border border-zinc-200 p-2.5 rounded-lg text-xs font-bold outline-none focus:border-black mb-2"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setSettleId(null)}
                          className="flex-1 py-2 bg-white border border-zinc-200 rounded-lg text-[10px] font-bold hover:bg-zinc-100"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleSettle}
                          className="flex-1 py-2 bg-[#CCF381] text-black rounded-lg text-[10px] font-black hover:brightness-90 shadow-sm"
                        >
                          Confirm Payment
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showQr && buyer.qrCode && (
        <div
          className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in"
          onClick={() => setShowQr(false)}
        >
          <div
            className="bg-white p-6 rounded-[2rem] shadow-2xl relative w-full max-w-[280px] flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close QR modal"
              onClick={() => setShowQr(false)}
              className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-900"
            >
              <X size={20} />
            </button>
            <h3 className="font-bold text-lg text-zinc-900 mb-4">Payment QR</h3>
            <div className="p-2 border-2 border-dashed border-zinc-200 rounded-xl mb-4">
              <ProxiedImage src={buyer.qrCode} alt="Payment QR" className="w-48 h-48 object-contain" />
            </div>
            <p className="text-center text-xs font-bold text-zinc-500">{buyer.name}</p>
            <p className="text-center text-[10px] text-zinc-400 font-mono">{buyer.upiId}</p>
          </div>
        </div>
      )}
    </div>
  );
};

// --- MAIN LAYOUT ---

export const MediatorDashboard: React.FC = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const {
    notifications: inboxNotifications,
    unreadCount,
    markAllRead,
    removeNotification,
    refresh: refreshNotifications,
  } = useNotification();
  const [activeTab, setActiveTab] = useState<'inbox' | 'market' | 'squad' | 'profile'>('inbox');
  const [showNotifications, setShowNotifications] = useState(false);

  const [orders, setOrders] = useState<Order[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [deals, setDeals] = useState<Product[]>([]);
  const [pendingUsers, setPendingUsers] = useState<User[]>([]);
  const [verifiedUsers, setVerifiedUsers] = useState<User[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  // Modals
  const [proofModal, setProofModal] = useState<Order | null>(null);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectType, setRejectType] = useState<'order' | 'review' | 'rating' | 'returnWindow'>('order');
  const [dealBuilder, setDealBuilder] = useState<Campaign | null>(null);
  const [commission, setCommission] = useState('');
  const [selectedBuyer, setSelectedBuyer] = useState<User | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);

  // Check if dealBuilder's campaign already has a published deal (edit mode)
  const isEditingPublishedDeal = useMemo(() => {
    if (!dealBuilder) return false;
    return deals.some((d: Product) => String(d.campaignId) === String(dealBuilder.id));
  }, [dealBuilder, deals]);

  // Pre-fill commission when opening deal builder.
  // If editing a published deal, use the deal's current commission.
  // Otherwise use agency's suggested commission.
  useEffect(() => {
    if (dealBuilder) {
      const existingDeal = deals.find((d: Product) => String(d.campaignId) === String(dealBuilder.id));
      if (existingDeal && typeof existingDeal.commission === 'number') {
        setCommission(String(existingDeal.commission));
      } else {
        const agencyComm = dealBuilder.assignmentCommission ?? 0;
        setCommission(agencyComm ? String(agencyComm) : '');
      }
    } else {
      setCommission('');
    }
  }, [dealBuilder, deals]);

  // AI Analysis — now reads stored data from order, no Gemini calls needed

  useEffect(() => {
    loadData();
  }, [user, selectedBuyer]);

  useEffect(() => {
    if (!showNotifications) return;
    refreshNotifications();
  }, [showNotifications, refreshNotifications]);

  const loadData = async (opts?: unknown) => {
    if (!user) return;
    if (loadingRef.current) return;
    const silent =
      !!opts &&
      typeof opts === 'object' &&
      Object.prototype.hasOwnProperty.call(opts, 'silent') &&
      Boolean((opts as any).silent);

    loadingRef.current = true;
    setLoading(true);
    try {
      const [ords, camps, publishedDeals, pend, ver, tix] = await Promise.all([
        api.ops.getMediatorOrders(user.mediatorCode || ''),
        api.ops.getCampaigns(user.mediatorCode || ''),
        api.ops.getDeals(user.mediatorCode || ''),
        api.ops.getPendingUsers(user.mediatorCode || ''),
        api.ops.getVerifiedUsers(user.mediatorCode || ''),
        api.tickets.getAll(),
      ]);
      const safeOrds = asArray<Order>(ords);
      const safeCamps = asArray<Campaign>(camps);
      const safeDeals = asArray(publishedDeals);
      const safePend = asArray<User>(pend);
      const safeVer = asArray<User>(ver);
      const safeTix = asArray<Ticket>(tix);

      setOrders(safeOrds);
      setCampaigns(safeCamps);
      setDeals(safeDeals);
      setPendingUsers(safePend);
      setVerifiedUsers(safeVer);
      setTickets(safeTix.filter((t: Ticket) => t.issueType !== 'Feedback'));

      // Keep the open proof-verification modal in sync with realtime order updates
      // (e.g., buyer uploaded a new proof while the modal is open).
      setProofModal((prev) => {
        if (!prev) return prev;
        const updated = safeOrds.find((o: Order) => o.id === prev.id);
        return updated || null;
      });

      // Keep the open buyer/ledger view in sync with realtime profile updates
      // (e.g., UPI/QR updates emitted via `users.changed`).
      setSelectedBuyer((prev) => {
        if (!prev) return prev;
        const updated = [...safePend, ...safeVer].find((u: any) => u?.id === (prev as any).id);
        if (!updated) return prev;
        const changed =
          updated.name !== (prev as any).name ||
          updated.mobile !== (prev as any).mobile ||
          updated.upiId !== (prev as any).upiId ||
          updated.qrCode !== (prev as any).qrCode;
        return changed ? updated : prev;
      });
    } catch (e) {
      console.error(e);
      if (!silent) {
        const msg = (e as any)?.message ? String((e as any).message) : 'Failed to refresh dashboard.';
        toast.error(msg);
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  // Realtime: refresh queue/dashboard when backend state changes.
  useEffect(() => {
    if (!user) return;
    let timer: any = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        loadData({ silent: true });
        if (showNotifications) refreshNotifications();
      }, 600);
    };
    const unsub = subscribeRealtime((msg) => {
      if (
        msg.type === 'orders.changed' ||
        msg.type === 'users.changed' ||
        msg.type === 'wallets.changed' ||
        msg.type === 'deals.changed' ||
        msg.type === 'notifications.changed' ||
        msg.type === 'tickets.changed'
      )
        schedule();
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user, showNotifications, refreshNotifications]);

  const handlePublish = async () => {
    if (!dealBuilder || !user?.mediatorCode) return;
    try {
      const commissionValue = Math.trunc(Number(commission || 0));
      await api.ops.publishDeal(dealBuilder.id, commissionValue, user.mediatorCode);
      setDealBuilder(null);
      setCommission('');
      toast.success('Deal saved');
      loadData();
    } catch (e) {
      console.error(e);
      const msg = (e as any)?.message ? String((e as any).message) : 'Failed to publish deal.';
      toast.error(msg);
    }
  };

  const hasNotifications = unreadCount > 0;

  const unpublishedCount = useMemo(() => {
    const dealCampaignIds = new Set((deals || []).map((d: Product) => String(d.campaignId)));
    return (campaigns || []).filter((c: Campaign) => !dealCampaignIds.has(String(c.id))).length;
  }, [campaigns, deals]);

  return (
    <div className="flex flex-col h-[100dvh] min-h-0 bg-[#FAFAFA] font-sans relative overflow-hidden text-zinc-900 select-none">
      {/* Top Bar */}
      <div className="pt-safe-top pt-6 px-4 pb-2 bg-[#FAFAFA] z-30 flex justify-between items-center sticky top-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[0.8rem] bg-[#18181B] text-white flex items-center justify-center font-black text-lg shadow-lg border-2 border-white overflow-hidden">
            {user?.avatar ? (
              <ProxiedImage
                src={user.avatar}
                alt={user?.name ? `${user.name} avatar` : 'Avatar'}
                className="w-full h-full object-cover"
              />
            ) : (
              (user?.name || '?').charAt(0)
            )}
          </div>
          <div>
            <h1 className="text-lg font-black text-[#18181B] leading-none tracking-tight">
              {user?.name || 'Unknown'}
            </h1>
            <div className="mt-1 flex items-center gap-2">
              <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-[#CCF381] rounded-full animate-pulse shadow-[0_0_6px_#CCF381]"></span>{' '}
                {user?.mediatorCode}
              </p>
            </div>
          </div>
        </div>

        <div className="relative flex items-center gap-2">
          <button
            type="button"
            aria-label="Raise a ticket"
            onClick={() => setTicketOpen(true)}
            className="w-10 h-10 rounded-[0.8rem] bg-white border border-orange-200 flex items-center justify-center text-orange-500 hover:bg-orange-50 transition-all active:scale-95 shadow-md"
          >
            <AlertTriangle size={18} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            aria-label="Open notifications"
            onClick={() => setShowNotifications(!showNotifications)}
            className="w-10 h-10 rounded-[0.8rem] bg-white border border-zinc-100 flex items-center justify-center text-zinc-600 hover:bg-zinc-50 transition-all active:scale-95 shadow-md relative"
          >
            <Bell size={18} strokeWidth={2.5} />
            {hasNotifications && (
              <span className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white animate-pulse"></span>
            )}
          </button>

          {showNotifications && (
            <>
              <div
                className="fixed inset-0 z-40 bg-transparent"
                onClick={() => setShowNotifications(false)}
              ></div>
              <div className="absolute right-0 top-12 w-72 bg-white rounded-[1.5rem] shadow-2xl border border-zinc-100 p-4 z-50 animate-enter origin-top-right">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-black text-sm text-zinc-900">Notifications</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => markAllRead()}
                      className="text-[10px] font-black uppercase tracking-wider text-zinc-500 hover:text-zinc-900"
                      type="button"
                    >
                      Mark all read
                    </button>
                    <button
                      aria-label="Close notifications"
                      onClick={() => setShowNotifications(false)}
                      className="p-1 bg-zinc-50 rounded-full hover:bg-zinc-100"
                      type="button"
                    >
                      <X size={14} className="text-zinc-400" />
                    </button>
                  </div>
                </div>
                <div className="space-y-2 max-h-[250px] overflow-y-auto scrollbar-styled">
                  {inboxNotifications.length === 0 && (
                    <div className="text-center py-6">
                      <p className="text-zinc-300 font-bold text-xs">All caught up!</p>
                    </div>
                  )}
                  {inboxNotifications.map((n: any) => (
                    <div
                      key={n.id}
                      onClick={() => {
                        const id = String(n.id || '');
                        if (id.startsWith('pending-users:') || id.startsWith('pending-orders:')) {
                          setActiveTab('inbox');
                        }
                        setShowNotifications(false);
                      }}
                      className="p-3 bg-zinc-50 rounded-[1rem] hover:bg-zinc-100 transition-colors cursor-pointer flex gap-3 items-start relative overflow-hidden group"
                    >
                      <div
                        className={`w-1.5 h-full absolute left-0 top-0 bottom-0 ${n.type === 'alert' ? 'bg-red-500' : n.type === 'success' ? 'bg-emerald-500' : 'bg-blue-500'}`}
                      ></div>
                      <div className="flex-1 pl-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-black text-zinc-900 leading-tight mb-0.5 truncate">
                              {n.title || 'Notification'}
                            </p>
                            <p className="text-[10px] text-zinc-600 leading-tight">
                              {n.message}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-400 hover:text-zinc-900"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeNotification(String(n.id));
                            }}
                            aria-label="Dismiss notification"
                            title="Dismiss"
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <p className="text-[9px] text-zinc-400 font-bold uppercase tracking-wide mt-1">
                          {n.read ? 'Read' : 'New'} · {n.createdAt ? `${formatRelativeTime(n.createdAt)}` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 scrollbar-styled pb-[calc(7.5rem+env(safe-area-inset-bottom))]">
        {activeTab === 'inbox' && (
          <InboxView
            orders={orders}
            pendingUsers={pendingUsers}
            tickets={tickets}
            loading={loading}
            onRefresh={loadData}
            unpublishedCount={unpublishedCount}
            onGoToUnpublished={() => setActiveTab('market')}
            onViewProof={(order: Order) => {
              setProofModal(order);
            }}
          />
        )}
        {activeTab === 'market' && (
          <MarketView
            campaigns={campaigns}
            deals={deals}
            loading={loading}
            user={user}
            onRefresh={loadData}
            onPublish={setDealBuilder}
          />
        )}
        {activeTab === 'squad' && (
          <SquadView
            user={user}
            pendingUsers={pendingUsers}
            verifiedUsers={verifiedUsers}
            orders={orders}
            loading={loading}
            onRefresh={loadData}
            onSelectUser={setSelectedBuyer}
          />
        )}
        {activeTab === 'profile' && <MediatorProfileView />}
      </div>

      <div className="fixed left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-[360px] bottom-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <MobileTabBar
          items={[
            {
              id: 'inbox',
              label: 'Home',
              ariaLabel: 'Home',
              icon: <LayoutGrid size={22} strokeWidth={activeTab === 'inbox' ? 2.5 : 2} />,
              badge: unreadCount,
            },
            {
              id: 'market',
              label: 'Market',
              ariaLabel: 'Market',
              icon: <Tag size={22} strokeWidth={activeTab === 'market' ? 2.5 : 2} />,
            },
            {
              id: 'squad',
              label: 'Squad',
              ariaLabel: 'Squad',
              icon: <Users size={22} strokeWidth={activeTab === 'squad' ? 2.5 : 2} />,
            },
            {
              id: 'profile',
              label: 'Profile',
              ariaLabel: 'Profile',
              icon: <UserIcon size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} />,
            },
          ]}
          activeId={activeTab}
          onChange={(id) => {
            setActiveTab(id as any);
            setShowNotifications(false);
          }}
          variant="darkGlass"
          showLabels={false}
        />
      </div>

      {/* VERIFICATION MODAL */}
      {proofModal && (
        <div
          className="absolute inset-0 z-50 bg-black/95 flex flex-col animate-enter backdrop-blur-sm overflow-hidden"
          onClick={() => {}}
        >
          <div className="flex justify-between items-center p-5 text-white pt-safe-top border-b border-white/10 bg-[#18181B] z-10 sticky top-0">
            <div>
              <h3 className="font-bold text-base">Verification Station</h3>
              <div className="flex items-center gap-2 text-[10px] text-zinc-400 font-mono mt-0.5">
                <span>{proofModal.buyerName}</span>
                <span></span>
                <span>{getPrimaryOrderId(proofModal)}</span>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close verification modal"
              onClick={() => setProofModal(null)}
              className="w-9 h-9 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-styled pb-28">
            {/* 1. ORDER MATCHING SECTION */}
            <div className="bg-zinc-900/50 rounded-2xl border border-zinc-800 p-4">
              <h4 className="text-xs font-bold text-zinc-500 uppercase mb-3 flex items-center gap-2">
                <ShoppingBag size={14} /> Match Order ID
              </h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-black/40 p-3 rounded-xl border border-white/5">
                  <p className="text-[9px] text-zinc-500 font-bold uppercase mb-1">
                    Platform ID (User Entered)
                  </p>
                  <p className="text-sm font-mono font-bold text-white tracking-wide break-all">
                    {proofModal.externalOrderId || 'Not Provided'}
                  </p>
                </div>
                <div className="bg-black/40 p-3 rounded-xl border border-white/5">
                  <p className="text-[9px] text-zinc-500 font-bold uppercase mb-1">
                    Expected Price
                  </p>
                  <p className="text-sm font-bold text-lime-400">{formatCurrency(proofModal.total)}</p>
                </div>
              </div>

              {/* AI-Extracted Metadata */}
              {(proofModal.soldBy || proofModal.orderDate || proofModal.extractedProductName || proofModal.reviewerName) && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
                  {proofModal.reviewerName && (
                    <div className="bg-black/40 p-2.5 rounded-xl border border-indigo-500/20">
                      <p className="text-[9px] text-indigo-400 font-bold uppercase mb-1">Reviewer Name</p>
                      <p className="text-[11px] font-bold text-indigo-200">{proofModal.reviewerName}</p>
                    </div>
                  )}
                  {proofModal.extractedProductName && (
                    <div className="bg-black/40 p-2.5 rounded-xl border border-white/5">
                      <p className="text-[9px] text-zinc-500 font-bold uppercase mb-1">Product Name</p>
                      <p className="text-[11px] font-bold text-zinc-200 line-clamp-2">{proofModal.extractedProductName}</p>
                    </div>
                  )}
                  {proofModal.soldBy && proofModal.soldBy !== 'null' && proofModal.soldBy !== 'undefined' && (
                    <div className="bg-black/40 p-2.5 rounded-xl border border-white/5">
                      <p className="text-[9px] text-zinc-500 font-bold uppercase mb-1">Sold By</p>
                      <p className="text-[11px] font-bold text-zinc-200">{proofModal.soldBy}</p>
                    </div>
                  )}
                  {(() => {
                    const d = proofModal.orderDate ? new Date(proofModal.orderDate) : null;
                    return d && !isNaN(d.getTime()) && d.getFullYear() > 2020 ? (
                      <div className="bg-black/40 p-2.5 rounded-xl border border-white/5">
                        <p className="text-[9px] text-zinc-500 font-bold uppercase mb-1">Order Date</p>
                        <p className="text-[11px] font-bold text-zinc-200">{d.toLocaleDateString()}</p>
                      </div>
                    ) : null;
                  })()}
                </div>
              )}

              {proofModal.screenshots?.order ? (
                <div className="mt-4">
                  <p className="text-[10px] text-zinc-500 font-bold uppercase mb-2">
                    Order Screenshot
                  </p>
                  <ProofImage
                    orderId={proofModal.id}
                    proofType="order"
                    existingSrc={proofModal.screenshots.order !== 'exists' ? proofModal.screenshots.order : undefined}
                    className="w-full rounded-xl border border-white/10"
                    alt="Order Proof"
                  />

                  {/* AI VERIFICATION RESULTS (stored from buyer's proof submission) */}
                  {proofModal.orderAiVerification && (
                  <div className="bg-indigo-500/10 p-4 rounded-xl border border-indigo-500/20 mt-4 relative overflow-hidden">
                    <div className="flex justify-between items-center mb-3 relative z-10">
                      <h4 className="font-bold text-indigo-300 flex items-center gap-2 text-xs uppercase tracking-widest">
                        <Sparkles size={14} className="text-indigo-400" /> AI Verification
                      </h4>
                    </div>

                      <div className="space-y-3 animate-fade-in">
                        {(() => {
                          const aiData = proofModal.orderAiVerification;
                          const n = Number(aiData?.confidenceScore);
                          const score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
                          return (
                            <>
                              <div className="flex gap-2">
                                <div
                                  className={`flex-1 p-2 rounded-lg border ${aiData?.orderIdMatch ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}
                                >
                                  <p
                                    className={`text-[9px] font-bold uppercase ${aiData?.orderIdMatch ? 'text-green-400' : 'text-red-400'}`}
                                  >
                                    Order ID
                                  </p>
                                  <p className="text-xs font-bold text-white">
                                    {aiData?.orderIdMatch ? 'Matched' : 'Mismatch'}
                                  </p>
                                  {aiData?.detectedOrderId && (
                                    <p className="text-[9px] text-zinc-400 mt-0.5 font-mono break-all">
                                      Detected: {aiData.detectedOrderId}
                                    </p>
                                  )}
                                </div>
                                <div
                                  className={`flex-1 p-2 rounded-lg border ${aiData?.amountMatch ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}
                                >
                                  <p
                                    className={`text-[9px] font-bold uppercase ${aiData?.amountMatch ? 'text-green-400' : 'text-red-400'}`}
                                  >
                                    Amount
                                  </p>
                                  <p className="text-xs font-bold text-white">
                                    {aiData?.amountMatch ? 'Matched' : 'Mismatch'}
                                  </p>
                                  {aiData?.detectedAmount != null && (
                                    <p className="text-[9px] text-zinc-400 mt-0.5 font-mono">
                                      Detected: {formatCurrency(aiData.detectedAmount)}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="bg-black/30 p-2 rounded-lg">
                                <p className="text-[10px] text-zinc-400 leading-relaxed">
                                  {aiData?.discrepancyNote ||
                                    'Verified. Details match expected values.'}
                                </p>
                              </div>
                              <div className="flex justify-between items-center pt-1">
                                <span className="text-[9px] text-indigo-300 font-bold uppercase">
                                  Confidence Score
                                </span>
                                <div className="flex items-center gap-2">
                                  <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${score > 80 ? 'bg-green-500' : score > 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                      style={{ width: `${score}%` }}
                                    ></div>
                                  </div>
                                  <span className="text-xs font-bold text-white">{score}%</span>
                                </div>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                  </div>
                  )}
                </div>
              ) : (
                <div className="mt-4 p-4 text-center border border-dashed border-zinc-700 rounded-xl text-zinc-500 text-xs">
                  No Order Screenshot Uploaded
                </div>
              )}
            </div>

            {/* STEP PROGRESS BAR — shows mediator what stage the order is at */}
            {(proofModal.requirements?.required?.length ?? 0) > 0 && (
              <div className="bg-zinc-800/80 rounded-2xl border border-zinc-700/50 p-4 mt-1">
                <h4 className="text-[10px] font-black text-zinc-400 uppercase tracking-wider mb-3">Verification Progress</h4>
                <div className="flex items-center gap-1">
                  <div className="flex items-center gap-1.5">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black ${
                      proofModal.verification?.orderVerified ? 'bg-green-500 text-white' : 'bg-zinc-600 text-zinc-300'
                    }`}>
                      {proofModal.verification?.orderVerified ? '✓' : '1'}
                    </div>
                    <span className={`text-[9px] font-bold ${proofModal.verification?.orderVerified ? 'text-green-400' : 'text-zinc-400'}`}>Buy</span>
                  </div>
                  <div className={`flex-1 h-0.5 rounded ${proofModal.verification?.orderVerified ? 'bg-green-500' : 'bg-zinc-700'}`} />
                  {proofModal.requirements?.required?.includes('review') && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black ${
                          proofModal.verification?.reviewVerified ? 'bg-green-500 text-white'
                            : proofModal.requirements?.missingProofs?.includes('review') ? 'bg-amber-500 text-amber-900'
                            : proofModal.verification?.orderVerified ? 'bg-purple-500 text-white'
                            : 'bg-zinc-600 text-zinc-400'
                        }`}>
                          {proofModal.verification?.reviewVerified ? '✓' : '2'}
                        </div>
                        <span className={`text-[10px] font-bold ${
                          proofModal.verification?.reviewVerified ? 'text-green-400'
                            : proofModal.requirements?.missingProofs?.includes('review') ? 'text-amber-400'
                            : 'text-zinc-400'
                        }`}>Review{proofModal.requirements?.missingProofs?.includes('review') ? ' !' : ''}</span>
                      </div>
                      <div className={`flex-1 h-0.5 rounded ${proofModal.verification?.reviewVerified ? 'bg-green-500' : 'bg-zinc-700'}`} />
                    </>
                  )}
                  {proofModal.requirements?.required?.includes('rating') && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black ${
                          proofModal.verification?.ratingVerified ? 'bg-green-500 text-white'
                            : proofModal.requirements?.missingProofs?.includes('rating') ? 'bg-amber-500 text-amber-900'
                            : proofModal.verification?.orderVerified ? 'bg-purple-500 text-white'
                            : 'bg-zinc-600 text-zinc-400'
                        }`}>
                          {proofModal.verification?.ratingVerified ? '✓' : proofModal.requirements?.required?.includes('review') ? '3' : '2'}
                        </div>
                        <span className={`text-[10px] font-bold ${
                          proofModal.verification?.ratingVerified ? 'text-green-400'
                            : proofModal.requirements?.missingProofs?.includes('rating') ? 'text-amber-400'
                            : 'text-zinc-400'
                        }`}>Rate{proofModal.requirements?.missingProofs?.includes('rating') ? ' !' : ''}</span>
                      </div>
                      <div className={`flex-1 h-0.5 rounded ${proofModal.verification?.ratingVerified ? 'bg-green-500' : 'bg-zinc-700'}`} />
                    </>
                  )}
                  {(proofModal.requirements?.required as string[] ?? []).includes('returnWindow') && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black ${
                          proofModal.verification?.returnWindowVerified ? 'bg-green-500 text-white'
                            : (proofModal.requirements?.missingProofs as string[] ?? []).includes('returnWindow') ? 'bg-amber-500 text-amber-900'
                            : proofModal.verification?.orderVerified ? 'bg-purple-500 text-white'
                            : 'bg-zinc-600 text-zinc-400'
                        }`}>
                          {proofModal.verification?.returnWindowVerified ? '✓' :
                            ((proofModal.requirements?.required?.includes('review') && proofModal.requirements?.required?.includes('rating')) ? '4' :
                             (proofModal.requirements?.required?.includes('review') || proofModal.requirements?.required?.includes('rating')) ? '3' : '2')}
                        </div>
                        <span className={`text-[10px] font-bold ${
                          proofModal.verification?.returnWindowVerified ? 'text-green-400'
                            : (proofModal.requirements?.missingProofs as string[] ?? []).includes('returnWindow') ? 'text-amber-400'
                            : 'text-zinc-400'
                        }`}>Return{(proofModal.requirements?.missingProofs as string[] ?? []).includes('returnWindow') ? ' !' : ''}</span>
                      </div>
                      <div className={`flex-1 h-0.5 rounded ${proofModal.verification?.returnWindowVerified ? 'bg-green-500' : 'bg-zinc-700'}`} />
                    </>
                  )}
                  <div className="flex items-center gap-1.5">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black ${
                      proofModal.affiliateStatus === 'Pending_Cooling' ? 'bg-green-500 text-white' : 'bg-zinc-600 text-zinc-400'
                    }`}>
                      {proofModal.affiliateStatus === 'Pending_Cooling' ? '✓' : '⚡'}
                    </div>
                    <span className={`text-[10px] font-bold ${proofModal.affiliateStatus === 'Pending_Cooling' ? 'text-green-400' : 'text-zinc-500'}`}>Done</span>
                  </div>
                </div>
              </div>
            )}

            {/* 2. DEAL SPECIFIC PROOFS */}
            {proofModal.items?.[0]?.dealType === 'Rating' && (
              <div className="bg-orange-950/20 rounded-2xl border border-orange-500/20 p-4">
                <h4 className="text-xs font-bold text-orange-400 uppercase mb-3 flex items-center gap-2">
                  <Star size={14} /> 5-Star Rating Check
                </h4>
                {proofModal.screenshots?.rating ? (
                  <ProofImage
                    orderId={proofModal.id}
                    proofType="rating"
                    existingSrc={proofModal.screenshots.rating !== 'exists' ? proofModal.screenshots.rating : undefined}
                    className="w-full rounded-xl border border-orange-500/20"
                    alt="Rating Proof"
                  />
                ) : (
                  <div className="p-4 text-center border border-dashed border-orange-900/50 rounded-xl text-orange-400/50 text-xs">
                    Rating Screenshot Missing
                  </div>
                )}
                {/* AI rating verification results */}
                {proofModal.ratingAiVerification && (
                  <RatingVerificationBadge
                    data={proofModal.ratingAiVerification}
                    theme="dark"
                    className="mt-3 space-y-1 text-[10px]"
                  />
                )}
              </div>
            )}

            {proofModal.items?.[0]?.dealType === 'Review' && (
              <div className="bg-purple-950/20 rounded-2xl border border-purple-500/20 p-4">
                <h4 className="text-xs font-bold text-purple-400 uppercase mb-3 flex items-center gap-2">
                  <FileText size={14} /> Text Review Check
                </h4>
                {proofModal.reviewLink ? (
                  <a
                    href={proofModal.reviewLink}
                    target="_blank" rel="noreferrer"
                    className="flex items-center justify-between p-4 bg-purple-900/20 border border-purple-500/30 rounded-xl hover:bg-purple-900/40 transition-colors group"
                  >
                    <span className="text-xs font-bold text-purple-300 truncate pr-4">
                      {proofModal.reviewLink}
                    </span>
                    <ExternalLink
                      size={14}
                      className="text-purple-400 group-hover:scale-110 transition-transform"
                    />
                  </a>
                ) : (
                  <div className="p-4 text-center border border-dashed border-purple-900/50 rounded-xl text-purple-400/50 text-xs">
                    Review Link Missing
                  </div>
                )}
              </div>
            )}

            {/* Return Window Proof */}
            {(proofModal.requirements?.required as string[] ?? []).includes('returnWindow') && (
              <div className="bg-teal-950/20 rounded-2xl border border-teal-500/20 p-4">
                <h4 className="text-xs font-bold text-teal-400 uppercase mb-3 flex items-center gap-2">
                  <Package size={14} /> Return Window Check
                </h4>
                {proofModal.screenshots?.returnWindow ? (
                  <ProofImage
                    orderId={proofModal.id}
                    proofType="returnWindow"
                    existingSrc={proofModal.screenshots.returnWindow !== 'exists' ? proofModal.screenshots.returnWindow : undefined}
                    className="w-full rounded-xl border border-teal-500/20"
                    alt="Return Window Proof"
                  />
                ) : (
                  <div className="p-4 text-center border border-dashed border-teal-900/50 rounded-xl text-teal-400/50 text-xs">
                    Return Window Screenshot Missing
                  </div>
                )}
                <p className="text-[10px] text-zinc-500 mt-2">
                  Cooling Period: {proofModal.returnWindowDays ?? 10} days
                </p>
                {/* AI Return Window Verification */}
                {proofModal.returnWindowAiVerification && (
                  <ReturnWindowVerificationBadge
                    data={proofModal.returnWindowAiVerification}
                    theme="dark"
                    className="mt-3 bg-teal-950/30 rounded-xl border border-teal-500/20 p-3 space-y-1.5"
                  />
                )}
              </div>
            )}
          </div>

          {/* ACTION BAR */}
          <div className="absolute bottom-0 left-0 w-full p-4 bg-[#18181B] border-t border-white/10 z-20 flex gap-3">
            <button
              onClick={() => setProofModal(null)}
              className="flex-1 py-4 bg-white/10 text-white font-bold text-sm rounded-[1.2rem] hover:bg-white/20 transition-colors"
            >
              Later
            </button>
            {proofModal?.requirements?.missingProofs?.length ? (
              <button
                onClick={async () => {
                  try {
                    const missing = proofModal?.requirements?.missingProofs ?? [];
                    if (!missing.length) return;
                    await Promise.all(
                      missing.map((type) =>
                        api.ops.requestMissingProof(
                          proofModal.id,
                          type,
                          `Please upload your ${type} proof to complete cashback.`
                        )
                      )
                    );
                    toast.success('Buyer notified to upload missing proof.');
                    await loadData();
                  } catch (err) {
                    toast.error(formatErrorMessage(err, 'Failed to request missing proof'));
                  }
                }}
                className="flex-1 py-4 bg-amber-500/20 text-amber-200 font-bold text-sm rounded-[1.2rem] hover:bg-amber-500/30 transition-colors"
              >
                Request Proof
              </button>
            ) : null}
            <button
              onClick={() => {
                if (!proofModal) return;
                const mv = proofModal.requirements?.missingVerifications ?? [];
                const nextType: 'order' | 'review' | 'rating' | 'returnWindow' = !proofModal.verification?.orderVerified
                  ? 'order'
                  : mv.includes('review')
                      ? 'review'
                      : mv.includes('rating')
                        ? 'rating'
                        : (mv as string[]).includes('returnWindow')
                          ? 'returnWindow'
                          : 'order';
                setRejectType(nextType);
                setRejectReason('');
                setRejectModalOpen(true);
              }}
              className="flex-1 py-4 bg-red-500/20 text-red-200 font-bold text-sm rounded-[1.2rem] hover:bg-red-500/30 transition-colors"
            >
              Reject
            </button>
            {!proofModal?.verification?.orderVerified ? (
              <button
                onClick={async () => {
                  try {
                    const resp = await api.ops.verifyOrderClaim(proofModal.id);
                    const missingProofs: Array<'review' | 'rating' | 'returnWindow'> =
                      (resp?.missingProofs as any) || [];
                    const missingVerifications: Array<'review' | 'rating' | 'returnWindow'> =
                      (resp?.missingVerifications as any) || [];

                    if (resp?.approved) {
                      toast.success('Order approved! Cashback is now in cooling period. ✓');
                      setProofModal(null);
                    } else if (missingProofs.length) {
                      toast.info(`Purchase verified ✓ Buyer needs to upload: ${missingProofs.join(' + ')} proof.`);
                    } else if (missingVerifications.length) {
                      toast.info(`Purchase verified ✓ You can now verify: ${missingVerifications.join(' + ')} proof.`);
                    } else {
                      toast.success('Purchase verified.');
                    }

                    await loadData();
                    // Keep modal open with refreshed order if more steps needed
                    if (!resp?.approved && resp?.order) {
                      setProofModal(resp.order);
                    } else if (!resp?.approved) {
                      setProofModal(null);
                    }
                  } catch (err) {
                    toast.error(formatErrorMessage(err, 'Failed to verify purchase'));
                  }
                }}
                className="flex-[2] py-4 bg-[#CCF381] text-black font-black text-sm rounded-[1.2rem] shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                <CheckCircle2 size={18} strokeWidth={3} /> Verify Purchase
              </button>
            ) : (
              <>
                {/* ── Primary: Verify Deal (all steps at once) ── */}
                {(proofModal?.requirements?.missingVerifications as string[] ?? []).length > 0 && (
                  <button
                    onClick={async () => {
                      try {
                        const resp = await api.ops.verifyAllSteps(proofModal.id);

                        if (resp?.approved) {
                          toast.success('Deal verified ✓ Cashback is now in cooling period!');
                          setProofModal(null);
                        } else {
                          toast.success('Deal verified ✓');
                        }

                        await loadData();
                        if (!resp?.approved && resp?.order) {
                          setProofModal(resp.order);
                        } else if (!resp?.approved) {
                          setProofModal(null);
                        }
                      } catch (err) {
                        toast.error(formatErrorMessage(err, 'Failed to verify deal'));
                      }
                    }}
                    disabled={!!(proofModal?.requirements?.missingProofs as string[] ?? []).length}
                    className="flex-[2] py-4 bg-[#CCF381] text-black font-black text-sm rounded-[1.2rem] shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:hover:scale-100"
                    title={
                      (proofModal?.requirements?.missingProofs as string[] ?? []).length
                        ? `Buyer hasn't uploaded: ${(proofModal?.requirements?.missingProofs as string[] ?? []).join(', ')}`
                        : 'Verify all remaining steps at once'
                    }
                  >
                    <ShieldCheck size={18} strokeWidth={3} /> Verify Deal
                  </button>
                )}

                {!proofModal?.requirements?.required?.length && !(proofModal?.requirements?.missingVerifications as string[] ?? []).length && (
                  <button
                    disabled
                    className="flex-[2] py-4 bg-white/10 text-white font-black text-sm rounded-[1.2rem] opacity-60 flex items-center justify-center gap-2"
                  >
                    <CheckCircle2 size={18} strokeWidth={3} /> Verified
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {rejectModalOpen && proofModal && (
        <div
          className="absolute inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setRejectModalOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-[#18181B] border border-white/10 p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-bold text-base">Reject Proof</h4>
              <button
                aria-label="Close reject modal"
                onClick={() => setRejectModalOpen(false)}
                className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-zinc-400 mb-4">
              Provide a clear reason so the buyer can re-upload correctly.
            </p>
            <label className="text-[10px] font-bold text-zinc-400 uppercase">Proof Type</label>
            <select
              value={rejectType}
              onChange={(e) => setRejectType(e.target.value as 'order' | 'review' | 'rating' | 'returnWindow')}
              className="mt-2 w-full rounded-xl bg-black/40 border border-white/10 p-3 text-sm font-bold"
            >
              <option value="order">Order Proof</option>
              <option value="review">Review Proof</option>
              <option value="rating">Rating Proof</option>
              <option value="returnWindow">Return Window Proof</option>
            </select>

            <label className="text-[10px] font-bold text-zinc-400 uppercase mt-4 block">
              Rejection Reason
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="mt-2 w-full rounded-xl bg-black/40 border border-white/10 p-3 text-sm font-bold text-white h-24 resize-none"
              placeholder="Example: Order ID is not visible"
            />

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setRejectModalOpen(false)}
                className="flex-1 py-3 rounded-xl bg-white/10 text-white font-bold"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    if (!rejectReason.trim() || rejectReason.trim().length < 5) {
                      toast.error('Rejection reason must be at least 5 characters.');
                      return;
                    }
                    await api.ops.rejectOrderProof(proofModal.id, rejectType, rejectReason.trim());
                    toast.success('Proof rejected and buyer notified.');
                    setRejectModalOpen(false);
                    setProofModal(null);
                    await loadData();
                  } catch (err) {
                    toast.error(formatErrorMessage(err, 'Failed to reject proof'));
                  }
                }}
                className="flex-1 py-3 rounded-xl bg-red-500 text-white font-bold"
              >
                Reject Now
              </button>
            </div>
          </div>
        </div>
      )}

      {dealBuilder && (
        <div
          className="absolute inset-0 z-50 bg-black/60 backdrop-blur-md flex items-end animate-fade-in"
          onClick={() => setDealBuilder(null)}
        >
          <div
            className="bg-white w-full rounded-t-[2rem] p-5 shadow-2xl animate-slide-up relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-1 bg-zinc-200 rounded-full mx-auto mb-6"></div>
            <div className="flex gap-4 mb-6">
              <div className="w-16 h-16 rounded-[1rem] bg-zinc-50 p-2 border border-zinc-100 flex items-center justify-center">
                <ProxiedImage
                  src={dealBuilder.image}
                  alt={dealBuilder.title || 'Deal'}
                  className="w-full h-full object-contain mix-blend-multiply"
                />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-black text-zinc-900 leading-tight line-clamp-2 mb-1">
                  {dealBuilder.title}
                </h3>
                <span className="text-[9px] font-bold bg-zinc-100 text-zinc-500 px-2 py-0.5 rounded-full uppercase tracking-wider">
                  {dealBuilder.platform}
                </span>
              </div>
              {/* Agency commission badge — visible at top-right of deal card */}
              <div className="flex-shrink-0 bg-blue-50 border-2 border-blue-300 rounded-[1rem] px-3 py-2 flex flex-col items-center justify-center shadow-sm">
                <p className="text-[8px] font-bold text-blue-500 uppercase tracking-wider">Agency Commission</p>
                <p className="text-lg font-black text-blue-700">₹{(dealBuilder as any).assignmentPayout ?? dealBuilder.payout ?? 0}</p>
                <p className="text-[7px] text-blue-400 font-semibold">from agency</p>
              </div>
            </div>
            <div className="bg-zinc-50 p-4 rounded-[1.5rem] border border-zinc-100 mb-6 flex items-center justify-between relative overflow-hidden">
              <div className="relative z-10">
                <p className="text-[9px] text-zinc-400 font-black uppercase tracking-widest mb-1">
                  Base Price
                </p>
                <p className="text-2xl font-black text-zinc-900">
                  {formatCurrency(dealBuilder.price + (dealBuilder.assignmentCommission || 0))}
                </p>
              </div>
              <div className="text-zinc-300 relative z-10">
                <ChevronRight size={24} />
              </div>
              <div className="text-right relative z-10">
                <p className="text-[9px] text-zinc-400 font-black uppercase tracking-widest mb-1">
                  Final Price
                </p>
                <p className="text-2xl font-black text-[#65a30d]">
                  {formatCurrency(
                    dealBuilder.price +
                      (dealBuilder.assignmentCommission || 0) +
                      (parseInt(commission) || 0)
                  )}
                </p>
              </div>
            </div>
            {/* Net earnings breakdown */}
            {(() => {
              // Agency commission = what agency pays mediator per deal
              const agencyComm = (dealBuilder as any).assignmentPayout ?? dealBuilder.payout ?? 0;
              // Your commission = what mediator adds to the deal price (can be negative)
              const buyerComm = parseInt(commission) || 0;
              // Net earnings = agency commission + your commission
              // Example: agency pays ₹10, mediator adds ₹5 buyer commission → net = ₹15
              // Example: agency pays ₹10, mediator adds -₹5 (discount) → net = ₹5
              const net = agencyComm + buyerComm;
              return (
                <div className={`p-3 rounded-[1rem] border mb-4 text-center ${net < 0 ? 'bg-red-50 border-red-200' : net === 0 ? 'bg-zinc-50 border-zinc-100' : 'bg-green-50 border-green-200'}`}>
                  <p className="text-[9px] font-black uppercase tracking-widest text-zinc-400 mb-0.5">Your Net Earnings</p>
                  <p className={`text-xl font-black ${net < 0 ? 'text-red-600' : net === 0 ? 'text-zinc-500' : 'text-green-700'}`}>
                    {net < 0 ? `−₹${Math.abs(net)}` : formatCurrency(net)}
                  </p>
                  {net < 0 && <p className="text-[9px] text-red-500 mt-1">You absorb ₹{Math.abs(net)} loss on this deal</p>}
                  <p className="text-[8px] text-zinc-400 mt-1">
                    Agency ₹{agencyComm} {buyerComm >= 0 ? '+' : '−'} Your Commission ₹{Math.abs(buyerComm)} = ₹{net}
                  </p>
                </div>
              );
            })()}
            <div className="space-y-3 mb-6">
              <label className="text-[10px] font-black text-zinc-900 uppercase ml-2 block tracking-wide">
                Your commission (₹)
              </label>
              <input
                type="number"
                autoFocus
                value={commission}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '' || raw === '-') {
                    setCommission(raw);
                    return;
                  }
                  const n = Math.trunc(Number(raw));
                  setCommission(String(n));
                }}
                className="w-full bg-white border-2 border-zinc-100 rounded-[1.5rem] p-4 text-2xl font-black text-center focus:border-[#CCF381] focus:ring-4 focus:ring-[#CCF381]/20 outline-none transition-all placeholder:text-zinc-200"
                placeholder="0"
              />
              <p className="text-[9px] text-zinc-400 text-center">Use negative value to give buyers a discount from your commission</p>
            </div>
            <button
              onClick={handlePublish}
              disabled={!user?.mediatorCode}
              className="w-full py-4 bg-[#18181B] text-white rounded-[1.5rem] font-black text-base shadow-xl hover:bg-[#CCF381] hover:text-black transition-all disabled:opacity-50 disabled:scale-100 active:scale-95 flex items-center justify-center gap-2"
            >
              {isEditingPublishedDeal ? 'Update Deal' : 'Publish Deal'} <Tag size={16} strokeWidth={3} className="fill-current" />
            </button>
          </div>
        </div>
      )}

      {selectedBuyer && (
        <LedgerModal
          buyer={selectedBuyer}
          orders={orders.filter((o) => o.userId === selectedBuyer.id)}
          loading={loading}
          onClose={() => setSelectedBuyer(null)}
          onRefresh={loadData}
        />
      )}
      <RaiseTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} />
    </div>
  );
};
