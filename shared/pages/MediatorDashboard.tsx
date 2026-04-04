import React, { useState, useEffect, useMemo, useRef, useCallback, Suspense } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { PullToRefreshIndicator } from '../components/PullToRefreshIndicator';
import { api, asArray, invalidateGetCache } from '../services/api';
import { subscribeRealtime } from '../services/realtime';
import { useRealtimeConnection } from '../hooks/useRealtimeConnection';
import { normalizeMobileTo10Digits, maskMobile } from '../utils/mobiles';
import { formatCurrency } from '../utils/formatCurrency';
import { getPrimaryOrderId } from '../utils/orderHelpers';
import { csvSafe, downloadCsv as downloadCsvFile } from '../utils/csvHelpers';
import { formatErrorMessage } from '../utils/errors';
import { ProxiedImage } from '../components/ProxiedImage';
import { BetaLock } from '../components/BetaLock';
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
} from 'lucide-react';

import { EmptyState, Spinner, Pagination } from '../components/ui';
import { ProofImage } from '../components/ProofImage';
import { RatingVerificationBadge, ReturnWindowVerificationBadge } from '../components/AiVerificationBadge';
import { MobileTabBar } from '../components/MobileTabBar';
import { FeedbackCard } from '../components/FeedbackCard';
import { lazyRetry } from '../utils/lazyRetry';

// Lazy-load modals (only needed on user interaction)
const RaiseTicketModal = lazyRetry(() =>
  import('../components/RaiseTicketModal').then(m => ({ default: m.RaiseTicketModal }))
);
const TicketDetailModal = lazyRetry(() => import('../components/TicketDetailModal'));

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

interface InboxViewProps {
  orders: Order[];
  pendingUsers: User[];
  tickets: Ticket[];
  loading: boolean;
  onRefresh: (keys?: string[]) => void;
  onViewProof: (order: Order) => void;
  onGoToUnpublished: () => void;
  unpublishedCount: number;
  setPendingUsers?: React.Dispatch<React.SetStateAction<User[]>>;
}

const InboxView = ({ orders, pendingUsers, tickets, loading, onRefresh, onViewProof, onGoToUnpublished, unpublishedCount, setPendingUsers }: InboxViewProps) => {
  // Verification queue is workflow-driven.
  // Orders can remain UNDER_REVIEW even after purchase verification if review/rating is still pending.
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [ticketFilter, setTicketFilter] = useState<'All' | 'Open' | 'Resolved' | 'Rejected'>('All');
  const [ticketSearch, setTicketSearch] = useState('');
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  const actionRequiredOrders = useMemo(() =>
    orders.filter((o: Order) => String(o.workflowStatus || '') === 'UNDER_REVIEW')
      .filter((o: Order) => matchesSearch(searchQuery, o.items[0]?.title, o.buyerName, o.reviewerName, getPrimaryOrderId(o))),
    [orders, searchQuery]
  );
  const coolingOrders = useMemo(() =>
    orders.filter((o: Order) => o.affiliateStatus === 'Pending_Cooling')
      .filter((o: Order) => matchesSearch(searchQuery, o.items[0]?.title, o.buyerName, o.reviewerName, getPrimaryOrderId(o))),
    [orders, searchQuery]
  );

  // [PERF] Memoize disputed order IDs
  const disputedOrderIds = useMemo(() => new Set(
    tickets.filter((t: Ticket) => t.status === 'Open').map((t: Ticket) => t.orderId)
  ), [tickets]);

  const [viewMode, setViewMode] = useState<'todo' | 'cooling'>('todo');
  const [orderPage, setOrderPage] = useState(1);
  const ORDERS_PER_PAGE = 20;

  const currentOrders = viewMode === 'todo' ? actionRequiredOrders : coolingOrders;
  const totalOrderPages = Math.ceil(currentOrders.length / ORDERS_PER_PAGE);
  const paginatedOrders = useMemo(() => {
    const safePage = Math.min(orderPage, Math.max(1, totalOrderPages));
    return currentOrders.slice((safePage - 1) * ORDERS_PER_PAGE, safePage * ORDERS_PER_PAGE);
  }, [currentOrders, orderPage, totalOrderPages]);

  // Reset order page on view mode change
  useEffect(() => { setOrderPage(1); }, [viewMode]);
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
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-styled px-1 snap-x">
        <div className="min-w-[150px] bg-mobo-dark-900 p-4 rounded-[1.5rem] shadow-xl relative overflow-hidden snap-center flex-1">
          <div className="absolute top-0 right-0 w-24 h-24 bg-mobo-accent/10 rounded-full blur-2xl -mr-6 -mt-6"></div>
          <div className="relative z-10">
            <p className="text-zinc-500 text-[10px] font-black uppercase tracking-widest mb-1">
              Today's Profit
            </p>
            <h2 className="text-3xl font-black text-mobo-accent tracking-tighter leading-none">
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
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-styled px-1 snap-x">
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
                    <p className="text-[10px] text-zinc-400 font-mono tracking-wide">{maskMobile(u.mobile)}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={`Approve ${u.name}`}
                    title="Approve"
                    onClick={async () => {
                      try {
                        await api.ops.approveUser(u.id);
                        if (setPendingUsers) setPendingUsers(prev => prev.filter(p => p.id !== u.id));
                        onRefresh(['pending', 'verified']);
                      } catch (e: any) { toast.error(formatErrorMessage(e, 'Failed to approve user')); }
                    }}
                    className="w-10 h-10 rounded-lg bg-zinc-900 text-white flex items-center justify-center hover:bg-mobo-accent hover:text-black transition-all shadow-md active:scale-90"
                  >
                    <Check size={14} strokeWidth={3} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Reject ${u.name}`}
                    title="Reject"
                    onClick={async () => {
                      try {
                        await api.ops.rejectUser(u.id);
                        if (setPendingUsers) setPendingUsers(prev => prev.filter(p => p.id !== u.id));
                        onRefresh(['pending']);
                      } catch (e: any) { toast.error(formatErrorMessage(e, 'Failed to reject user')); }
                    }}
                    className="w-10 h-10 rounded-lg bg-zinc-50 text-zinc-400 flex items-center justify-center hover:bg-red-50 hover:text-red-500 transition-all active:scale-90"
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
              'UTR/Reference', 'Payment Mode',
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
                  d.toLocaleDateString('en-GB'),
                  d.toLocaleTimeString('en-GB'),
                  item?.title || '',
                  item?.platform || '',
                  item?.brandName || '',
                  item?.dealType || 'Discount',
                  String(item?.priceAtPurchase ?? 0),
                  String(item?.quantity || 1),
                  String(o.total || 0),
                  String(item?.commission || 0),
                  o.expectedSettlementDate ? new Date(o.expectedSettlementDate).toLocaleDateString('en-GB') : '',
                  o.agencyName || 'Direct',
                  o.buyerName || '',
                  o.buyerMobile || '',
                  o.reviewerName || '',
                  o.workflowStatus || '',
                  o.affiliateStatus || '',
                  o.paymentStatus || '',
                  o.soldBy || '',
                  o.orderDate ? new Date(o.orderDate).toLocaleDateString('en-GB') : '',
                  o.extractedProductName || '',
                  o.settlementRef || '',
                  o.settlementMode || '',
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
      </div>

      {/* Order Verification Section */}
      <section>
        <div className="flex gap-2 mb-4 bg-zinc-100 p-1 rounded-xl">
          <button
            type="button"
            aria-pressed={viewMode === 'todo' ? "true" : "false"}
            onClick={() => setViewMode('todo')}
            className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${viewMode === 'todo' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            Verify ({actionRequiredOrders.length})
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'cooling' ? "true" : "false"}
            onClick={() => setViewMode('cooling')}
            className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${viewMode === 'cooling' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            Cooling Period ({coolingOrders.length})
          </button>
        </div>

        {(viewMode === 'todo' ? actionRequiredOrders : coolingOrders).length === 0 ? (
          loading ? (
            <div className="space-y-3 py-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-white rounded-2xl p-4 shadow-sm border border-zinc-100 animate-pulse" style={{ animationDelay: `${i * 100}ms` }}>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-zinc-200 flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-zinc-200 rounded w-3/4" />
                      <div className="h-3 bg-zinc-100 rounded w-1/2" />
                    </div>
                    <div className="h-6 w-14 bg-zinc-100 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
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
          <>
          <div className="space-y-3">
            {paginatedOrders.map((o: Order) => {
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
                    <div className="w-14 h-14 bg-mobo-dark-100 rounded-[1rem] p-1.5 flex-shrink-0 relative overflow-hidden">
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
                          <span className="font-bold text-zinc-900 truncate max-w-[120px]">
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
                            : 'bg-mobo-dark-900 text-white hover:bg-mobo-accent hover:text-black hover:shadow-md'
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
          {totalOrderPages > 1 && (
            <Pagination
              page={orderPage}
              totalPages={totalOrderPages}
              total={currentOrders.length}
              limit={ORDERS_PER_PAGE}
              onPageChange={setOrderPage}
              className="mt-3 rounded-xl border border-zinc-100"
            />
          )}
        </>
        )}
      </section>

      {/* Tickets */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h3 className="font-bold text-base text-zinc-900 tracking-tight">Tickets</h3>
          <div className="flex items-center gap-2">
            {tickets && tickets.length > 0 && (
              <button type="button" onClick={() => {
                const supportTickets = tickets.filter((t: Ticket) => t.issueType !== 'Feedback');
                if (!supportTickets.length) { toast.error('No tickets to export'); return; }
                const headers = ['Ticket ID', 'Status', 'Issue Type', 'Description', 'User', 'Role', 'Target Role', 'Order ID', 'Resolution Note', 'Resolved By', 'Resolved At', 'Created At'];
                const rows = supportTickets.map((t: Ticket) => [
                  t.id.slice(-8), String(t.status), String(t.issueType), String(t.description || ''),
                  String(t.userName || ''), String(t.role || ''), String(t.targetRole || ''), String(t.orderId || ''),
                  String(t.resolutionNote || ''), String(t.resolvedByName || ''),
                  t.resolvedAt ? new Date(t.resolvedAt).toLocaleDateString('en-GB') : '',
                  t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : '',
                ]);
                downloadCsv(`mediator-tickets-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
                toast.success(`Exported ${supportTickets.length} tickets`);
              }} className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                Export CSV
              </button>
            )}
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
              {Array.isArray(tickets) ? tickets.length : 0}
            </span>
          </div>
        </div>
        {/* Status filter tabs */}
        {tickets && tickets.length > 0 && (
          <>
          {/* Search */}
          <div className="mb-2">
            <input type="text" placeholder="Search tickets..." value={ticketSearch} onChange={e => setTicketSearch(e.target.value)}
              className="w-full px-3 py-1.5 text-[11px] rounded-lg border border-zinc-200 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          </div>
          <div className="flex items-center gap-1.5 mb-2 flex-wrap">
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
          </>
        )}
        {(!tickets || tickets.length === 0) ? (
          <EmptyState
            title="No tickets"
            description="Support tickets will appear here."
            icon={<HelpCircle size={22} className="text-zinc-400" />}
          />
        ) : (
          <div className="space-y-2 max-h-[60dvh] overflow-y-auto scrollbar-styled">
            {tickets.filter((t: Ticket) => {
              if (ticketFilter !== 'All' && String(t.status) !== ticketFilter) return false;
              if (ticketSearch.trim()) {
                const q = ticketSearch.trim().toLowerCase();
                return (String(t.issueType || '').toLowerCase().includes(q) ||
                  String(t.description || '').toLowerCase().includes(q) ||
                  String(t.userName || '').toLowerCase().includes(q) ||
                  String(t.orderId || '').toLowerCase().includes(q) ||
                  t.id.toLowerCase().includes(q));
              }
              return true;
            }).map((t: Ticket) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTicket(t); } }}
                className="rounded-xl border border-zinc-100 bg-white px-3 py-3 shadow-sm space-y-2 cursor-pointer hover:border-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                onClick={() => setSelectedTicket(t)}
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
                  </div>
                  <span className="text-[9px] text-zinc-400 shrink-0">{t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : ''}</span>
                </div>
                {t.description && (
                  <div className="text-[10px] text-zinc-600 bg-zinc-50 rounded-lg px-2 py-1.5 line-clamp-3">
                    &ldquo;{String(t.description)}&rdquo;
                  </div>
                )}
                {t.userName && (
                  <div className="text-[9px] text-zinc-400">From: {String(t.userName)} ({String(t.userRole || '')})</div>
                )}
                {(t.externalOrderId || t.orderId) && (
                  <div className="text-[9px] text-zinc-400"><span className="font-bold">Order:</span> {String(t.externalOrderId || t.orderId)}</div>
                )}
                {t.resolutionNote && (
                  <div className="text-[10px] text-green-700 bg-green-50 rounded-lg px-2 py-1.5">
                    <span className="font-bold">Resolution:</span> {String(t.resolutionNote)}
                  </div>
                )}
                {(String(t.status) === 'Resolved' || String(t.status) === 'Rejected') && (t.resolvedByName || t.resolvedAt) && (
                  <div className="text-[9px] text-zinc-400">
                    {String(t.status) === 'Resolved' ? 'Resolved' : 'Rejected'}
                    {t.resolvedByName ? ` by ${String(t.resolvedByName)}` : ''}
                    {t.resolvedAt ? ` on ${new Date(String(t.resolvedAt)).toLocaleDateString('en-GB')}` : ''}
                  </div>
                )}
                <div className="flex items-center gap-1.5 justify-end">
                  {String(t.status || '').toLowerCase() === 'open' && (
                    <>
                      {resolvingTicketId === t.id ? (
                        <div className="w-full space-y-1.5">
                          <textarea
                            value={resolutionNote}
                            onChange={e => setResolutionNote(e.target.value)}
                            placeholder="Add a resolution/rejection note (optional)..."
                            className="w-full px-2 py-1.5 text-[10px] rounded-lg border border-zinc-200 bg-zinc-50 focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-none"
                            rows={2}
                            maxLength={2000}
                          />
                          <div className="flex items-center gap-1.5">
                            <button type="button" onClick={async () => {
                              try {
                                await api.tickets.update(t.id, 'Resolved', resolutionNote || undefined);
                                toast.success('Ticket resolved.');
                                setResolvingTicketId(null); setResolutionNote('');
                                onRefresh(['tickets']);
                              } catch (err) { toast.error(formatErrorMessage(err, 'Failed to resolve.')); }
                            }} className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100">
                              ✓ Resolve
                            </button>
                            <button type="button" onClick={async () => {
                              try {
                                await api.tickets.update(t.id, 'Rejected', resolutionNote || undefined);
                                toast.success('Ticket rejected.');
                                setResolvingTicketId(null); setResolutionNote('');
                                onRefresh(['tickets']);
                              } catch (err) { toast.error(formatErrorMessage(err, 'Failed to reject.')); }
                            }} className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-red-50 border border-red-200 text-red-600 hover:bg-red-100">
                              ✗ Reject
                            </button>
                            <button type="button" onClick={() => { setResolvingTicketId(null); setResolutionNote(''); }}
                              className="px-2 py-1 rounded-lg text-[10px] font-bold text-zinc-400 hover:text-zinc-600">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button type="button" onClick={() => { setResolvingTicketId(t.id); setResolutionNote(''); }}
                            className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100">
                            ✓ Resolve / Reject
                          </button>

                        </>
                      )}
                    </>
                  )}
                  {String(t.status || '').toLowerCase() !== 'open' && (
                    <>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.tickets.update(t.id, 'Open');
                            toast.success('Ticket reopened.');
                            onRefresh(['tickets']);
                          } catch (err) {
                            toast.error(formatErrorMessage(err, 'Failed to reopen ticket.'));
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100"
                      >
                        Reopen
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await api.tickets.delete(t.id);
                            toast.success('Ticket deleted.');
                            onRefresh(['tickets']);
                          } catch (err) {
                            toast.error(formatErrorMessage(err, 'Failed to delete ticket.'));
                          }
                        }}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-zinc-50 border border-zinc-200 text-zinc-600 hover:text-red-600 hover:border-red-200"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"><Spinner /></div>}>
        <TicketDetailModal
          open={!!selectedTicket}
          onClose={() => setSelectedTicket(null)}
          ticket={selectedTicket}
          onRefresh={onRefresh}
        />
      </Suspense>
    </div>
  );
};

const MarketView = ({ campaigns, deals, loading, user, onRefresh, onPublish, setCampaigns }: any) => {
  const { toast } = useToast();
  const { confirm, ConfirmDialogElement } = useConfirm();
  const [marketSearch, setMarketSearch] = useState('');
  const [marketPage, setMarketPage] = useState(1);
  const MARKET_PER_PAGE = 20;
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

  const currentMarketItems = mode === 'published' ? filteredDeals : unpublishedCampaigns;
  const totalMarketPages = Math.ceil(currentMarketItems.length / MARKET_PER_PAGE);
  const paginatedMarketItems = useMemo(() => {
    const safePage = Math.min(marketPage, Math.max(1, totalMarketPages));
    return currentMarketItems.slice((safePage - 1) * MARKET_PER_PAGE, safePage * MARKET_PER_PAGE);
  }, [currentMarketItems, marketPage, totalMarketPages]);

  useEffect(() => { setMarketPage(1); }, [mode, marketSearch]);

  return (
    <div className="space-y-5 animate-enter">
      {ConfirmDialogElement}
      <div className="bg-mobo-dark-900 p-5 rounded-[1.5rem] shadow-xl text-white relative overflow-hidden">
        <div className="absolute top-[-50%] right-[-10%] w-40 h-40 bg-mobo-accent rounded-full blur-[60px] opacity-20 animate-pulse"></div>
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
            aria-pressed={mode === 'published' ? "true" : "false"}
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
            aria-pressed={mode === 'unpublished' ? "true" : "false"}
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
              (paginatedMarketItems as Product[]).map((d: Product) => (
                <div
                  key={String(d.id)}
                  className="bg-white p-4 rounded-[1.5rem] border border-zinc-100 shadow-sm flex flex-col relative overflow-hidden"
                >
                  <div className="flex gap-4 mb-4">
                    <div className="w-16 h-16 bg-mobo-dark-100 rounded-[1rem] p-2 flex-shrink-0">
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
                    className="w-full py-3 bg-mobo-dark-900 text-white rounded-[1rem] font-bold text-xs shadow-md hover:bg-mobo-accent hover:text-black transition-all active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    <ArrowUpRight size={14} strokeWidth={2.5} /> Edit Deal
                  </button>
                </div>
              ))
            )}
          </div>
          {totalMarketPages > 1 && (
            <Pagination
              page={marketPage}
              totalPages={totalMarketPages}
              total={filteredDeals.length}
              limit={MARKET_PER_PAGE}
              onPageChange={setMarketPage}
              className="mt-3 rounded-xl border border-zinc-100"
            />
          )}
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
              (paginatedMarketItems as Campaign[]).map((c: Campaign) => (
                <div
                  key={c.id}
                  className="bg-white p-4 rounded-[1.5rem] border border-zinc-100 shadow-sm flex flex-col relative overflow-hidden hover:shadow-lg transition-all duration-300"
                >
                  <div className="flex gap-4 mb-4">
                    <div className="w-16 h-16 bg-mobo-dark-100 rounded-[1rem] p-2 flex-shrink-0">
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
                        {c.openToAll ? (
                          <span className="bg-emerald-50 text-emerald-700 text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wide border border-emerald-200">
                            🌐 Open to All · {c.totalSlots - c.usedSlots} left
                          </span>
                        ) : (
                          <span className="bg-mobo-accent/20 text-lime-700 text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wide">
                            {(user.mediatorCode ? c.assignments[(user.mediatorCode || '').toLowerCase()] : 0) || 0} Slots
                          </span>
                        )}
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

                  <div className={`grid gap-2 ${String(c.brandId || '') === String(user.id || '') ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    <button
                      type="button"
                      onClick={() => onPublish(c)}
                      className="w-full py-3 bg-mobo-dark-900 text-white rounded-[1rem] font-bold text-xs hover:bg-mobo-accent hover:text-black transition-all shadow-md active:scale-95 flex items-center justify-center gap-1.5"
                    >
                      <ArrowUpRight size={14} strokeWidth={2.5} /> Configure & Publish
                    </button>
                    {String(c.brandId || '') === String(user.id || '') && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          if (!(await confirm({ message: 'Delete this unpublished campaign?', confirmLabel: 'Delete', variant: 'destructive' }))) return;
                          await api.ops.deleteCampaign(String(c.id));
                          if (setCampaigns) setCampaigns((prev: any[]) => prev.filter((camp: any) => camp.id !== c.id));
                          toast.success('Campaign deleted.');
                          onRefresh?.(['campaigns', 'deals']);
                        } catch (err) {
                          toast.error(formatErrorMessage(err, 'Failed to delete campaign'));
                        }
                      }}
                      className="w-full py-3 bg-red-50 text-red-600 rounded-[1rem] font-bold text-xs border border-red-200 hover:bg-red-100 transition-all shadow-sm active:scale-95"
                    >
                      Delete
                    </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          {totalMarketPages > 1 && (
            <Pagination
              page={marketPage}
              totalPages={totalMarketPages}
              total={unpublishedCampaigns.length}
              limit={MARKET_PER_PAGE}
              onPageChange={setMarketPage}
              className="mt-3 rounded-xl border border-zinc-100"
            />
          )}
        </div>
      )}
    </div>
  );
};

interface SquadViewProps {
  user: User;
  pendingUsers: User[];
  verifiedUsers: User[];
  loading: boolean;
  orders: Order[];
  onRefresh: (keys?: string[]) => void;
  onSelectUser: (u: User) => void;
}

const SquadView = ({ user, pendingUsers, verifiedUsers, loading, orders: _orders, onRefresh: _onRefresh, onSelectUser }: SquadViewProps) => {
  const { toast } = useToast();
  const [squadSearch, setSquadSearch] = useState('');
  const [squadPage, setSquadPage] = useState(1);
  const SQUAD_PER_PAGE = 25;
  const filteredVerified = useMemo(() =>
    verifiedUsers.filter((u: User) => matchesSearch(squadSearch, u.name, u.mobile)),
    [verifiedUsers, squadSearch]
  );
  const totalSquadPages = Math.ceil(filteredVerified.length / SQUAD_PER_PAGE);
  const paginatedSquad = useMemo(() => {
    const safePage = Math.min(squadPage, Math.max(1, totalSquadPages));
    return filteredVerified.slice((safePage - 1) * SQUAD_PER_PAGE, safePage * SQUAD_PER_PAGE);
  }, [filteredVerified, squadPage, totalSquadPages]);

  useEffect(() => { setSquadPage(1); }, [squadSearch]);

  const _filteredPending = useMemo(() =>
    pendingUsers.filter((u: User) => matchesSearch(squadSearch, u.name, u.mobile)),
    [pendingUsers, squadSearch]
  );
  return (
    <div className="space-y-5 animate-enter">
      <div
        className="bg-indigo-600 p-5 rounded-[1.5rem] shadow-xl shadow-indigo-500/20 text-white relative overflow-hidden group active:scale-[0.98] transition-transform cursor-pointer"
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
              {paginatedSquad.map((u: User) => (
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
                      <p className="text-[10px] text-zinc-400 font-mono">{maskMobile(u.mobile)}</p>
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
          {totalSquadPages > 1 && (
            <Pagination
              page={squadPage}
              totalPages={totalSquadPages}
              total={filteredVerified.length}
              limit={SQUAD_PER_PAGE}
              onPageChange={setSquadPage}
              className="mt-3 rounded-xl border border-zinc-100"
            />
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
            aria-label="Upload profile photo"
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
              aria-label="Full Name"
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
              value={isEditing ? mobile : maskMobile(mobile)}
              onChange={(e) => setMobile(normalizeMobileTo10Digits(e.target.value))}
              aria-label="Mobile Number"
              className="w-full p-3 bg-zinc-50 rounded-xl font-bold text-sm outline-none focus:ring-2 focus:ring-lime-400 disabled:opacity-70 disabled:bg-transparent disabled:border disabled:border-zinc-100"
            />
          </div>
        </div>

        <BetaLock>
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
              aria-label="Upload payment QR code"
              onChange={(e) => handleImageUpload(e, 'qr')}
            />
          </div>
        </div>
        </BetaLock>

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
      onRefresh(['orders']);
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to settle'));
    }
  };

  const handleRevert = async (orderId: string) => {
    if (await confirm({ message: 'Undo this settlement? Funds will be reversed.', title: 'Undo Settlement', confirmLabel: 'Undo', variant: 'destructive' })) {
      try {
        await api.ops.unsettleOrderPayment(orderId);
        onRefresh(['orders']);
      } catch (err) {
        toast.error(formatErrorMessage(err, 'Failed to revert settlement'));
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-modal bg-black/60 backdrop-blur-md flex items-end animate-fade-in"
      onClick={onClose}
    >
      {ConfirmDialogElement}
      <div
        className="bg-slate-50 w-full rounded-t-[2.5rem] max-h-[92%] h-[92%] shadow-2xl animate-slide-up relative flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-none p-5 bg-mobo-dark-900 rounded-t-[2.5rem] text-white pb-8">
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
                  {maskMobile(buyer.mobile)}
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
            <div className="bg-mobo-accent p-4 rounded-[1.5rem] text-black shadow-lg">
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
              aria-pressed={viewMode === 'pending' ? "true" : "false"}
              onClick={() => setViewMode('pending')}
              className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${viewMode === 'pending' ? 'bg-black text-white shadow-md' : 'bg-white text-zinc-500 border border-zinc-200'}`}
            >
              Unsettled ({pendingOrders.length})
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'settled' ? "true" : "false"}
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
                        {new Date(o.createdAt).toLocaleDateString('en-GB')}
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

                    <BetaLock>
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
                      <div className="flex items-center gap-3">
                        {o.settlementRef && (
                          <span className="text-[10px] font-mono font-bold text-zinc-400" title="UTR / Reference">
                            UTR: {o.settlementRef}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRevert(o.id)}
                          className="text-[10px] font-bold text-zinc-400 hover:text-red-500 flex items-center gap-1 transition-colors"
                        >
                          <RefreshCcw size={10} /> Revert
                        </button>
                      </div>
                    )}
                    </BetaLock>
                  </div>

                  {settleId === o.id && (
                    <BetaLock>
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
                          className="flex-1 py-2 bg-mobo-accent text-black rounded-lg text-[10px] font-black hover:brightness-90 shadow-sm"
                        >
                          Confirm Payment
                        </button>
                      </div>
                    </div>
                    </BetaLock>
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
  useRealtimeConnection();
  const {
    notifications: inboxNotifications,
    unreadCount,
    markAllRead,
    removeNotification,
    refresh: refreshNotifications,
  } = useNotification();
  const [activeTab, setActiveTab] = useState<'inbox' | 'market' | 'squad' | 'profile'>('inbox');
  const [_slideDir, setSlideDir] = useState<'left' | 'right'>('right');
  const prevTabIdx = useRef(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const showNotificationsRef = useRef(showNotifications);
  useEffect(() => { showNotificationsRef.current = showNotifications; }, [showNotifications]);

  const TAB_ORDER = ['inbox', 'market', 'squad', 'profile'] as const;

  const handleTabChange = (tab: typeof activeTab) => {
    const newIdx = TAB_ORDER.indexOf(tab);
    const oldIdx = TAB_ORDER.indexOf(activeTab);
    setSlideDir(newIdx > oldIdx ? 'left' : 'right');
    prevTabIdx.current = oldIdx;
    setActiveTab(tab);
  };

  const swipeHandlers = useSwipeTabs({
    tabs: TAB_ORDER as unknown as string[],
    activeTab,
    onChangeTab: (t) => handleTabChange(t as typeof activeTab),
  });

  const mediatorTabItems = useMemo(() => [
    { id: 'inbox', label: 'Home', ariaLabel: 'Home', icon: <LayoutGrid size={22} strokeWidth={activeTab === 'inbox' ? 2.5 : 2} />, badge: unreadCount },
    { id: 'market', label: 'Market', ariaLabel: 'Market', icon: <Tag size={22} strokeWidth={activeTab === 'market' ? 2.5 : 2} /> },
    { id: 'squad', label: 'Squad', ariaLabel: 'Squad', icon: <Users size={22} strokeWidth={activeTab === 'squad' ? 2.5 : 2} /> },
    { id: 'profile', label: 'Profile', ariaLabel: 'Profile', icon: <UserIcon size={22} strokeWidth={activeTab === 'profile' ? 2.5 : 2} /> },
  ], [activeTab, unreadCount]);

  const [orders, setOrders] = useState<Order[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [deals, setDeals] = useState<Product[]>([]);
  const [pendingUsers, setPendingUsers] = useState<User[]>([]);
  const [verifiedUsers, setVerifiedUsers] = useState<User[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);

  // Modals
  const [proofModal, setProofModal] = useState<Order | null>(null);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectType, setRejectType] = useState<'order' | 'review' | 'rating' | 'returnWindow'>('order');
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [actionNote, setActionNote] = useState('');
  const [actionReason, setActionReason] = useState('');
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

  const loadedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const lastFetchedAt = useRef<Record<string, number>>({});
  const fetchSeqRef = useRef(0);
  const fetchAbortRef = useRef<AbortController | null>(null);

  const tabDataNeeds = useMemo<string[]>(() => {
    switch (activeTab) {
      case 'inbox': return ['orders', 'campaigns', 'deals', 'pending', 'tickets'];
      case 'market': return ['campaigns', 'deals'];
      case 'squad': return ['pending', 'verified'];
      case 'profile': return [];
      default: return [];
    }
  }, [activeTab]);

  // Keep a ref so loadData callback stays stable across tab switches
  const tabDataNeedsRef = useRef(tabDataNeeds);
  tabDataNeedsRef.current = tabDataNeeds;

  const loadData = useCallback(async (opts?: { force?: boolean; silent?: boolean; keys?: string[] }) => {
    if (!user) return;
    const force = opts?.force ?? false;
    const silent = !!opts?.silent;
    const invalidateKeys = opts?.keys;

    if (invalidateKeys) {
      for (const k of invalidateKeys) loadedRef.current.delete(k);
    }

    const currentNeeds = tabDataNeedsRef.current;
    if (force && !invalidateKeys) {
      for (const k of currentNeeds) loadedRef.current.delete(k);
      invalidateGetCache('/ops');
      invalidateGetCache('/tickets');
    }
    const now = Date.now();
    const needed = currentNeeds.filter((k) => {
      if (inFlightRef.current.has(k)) return false;
      if (!loadedRef.current.has(k)) return true;
      return (now - (lastFetchedAt.current[k] || 0)) > 30_000;
    });
    if (needed.length === 0) return;

    for (const k of needed) { loadedRef.current.delete(k); inFlightRef.current.add(k); }
    setLoading(true);
    // Abort any previous in-flight batch and start fresh
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const seq = ++fetchSeqRef.current;
    try {
      const promises: Promise<any>[] = [];
      const keys: string[] = [];

      if (needed.includes('orders')) { promises.push(api.ops.getMediatorOrders(user.mediatorCode || '')); keys.push('orders'); }
      if (needed.includes('campaigns')) { promises.push(api.ops.getCampaigns(user.mediatorCode || '')); keys.push('campaigns'); }
      if (needed.includes('deals')) { promises.push(api.ops.getDeals(user.mediatorCode || '')); keys.push('deals'); }
      if (needed.includes('pending')) { promises.push(api.ops.getPendingUsers(user.mediatorCode || '')); keys.push('pending'); }
      if (needed.includes('verified')) { promises.push(api.ops.getVerifiedUsers(user.mediatorCode || '')); keys.push('verified'); }
      if (needed.includes('tickets')) { promises.push(api.tickets.getAll()); keys.push('tickets'); }

      const settled = await Promise.allSettled(promises);

      // Discard stale results if a newer fetch was started (rapid tab switch) or if aborted
      if (fetchSeqRef.current !== seq || controller.signal.aborted) return;

      const now = Date.now();
      keys.forEach((key, i) => {
        const result = settled[i];
        if (result.status !== 'fulfilled') {
          if (process.env.NODE_ENV !== 'production') console.warn(`[MediatorDashboard] fetch '${key}' failed`, result.reason);
          return;
        }
        loadedRef.current.add(key);
        lastFetchedAt.current[key] = now;
        switch (key) {
          case 'orders': {
            const safeOrds = asArray<Order>(result.value);
            setOrders(safeOrds);
            setProofModal((prev) => {
              if (!prev) return prev;
              const updated = safeOrds.find((o: Order) => o.id === prev.id);
              return updated || null;
            });
            break;
          }
          case 'campaigns': setCampaigns(asArray<Campaign>(result.value)); break;
          case 'deals': setDeals(asArray(result.value)); break;
          case 'pending': {
            const safePend = asArray<User>(result.value);
            setPendingUsers(safePend);
            setSelectedBuyer((prev) => {
              if (!prev) return prev;
              const updated = safePend.find((u) => u?.id === prev.id);
              if (!updated) return prev;
              return updated.name !== prev.name || updated.mobile !== prev.mobile || updated.upiId !== prev.upiId || updated.qrCode !== prev.qrCode ? updated : prev;
            });
            break;
          }
          case 'verified': {
            const safeVer = asArray<User>(result.value);
            setVerifiedUsers(safeVer);
            setSelectedBuyer((prev) => {
              if (!prev) return prev;
              const updated = safeVer.find((u) => u?.id === prev.id);
              if (!updated) return prev;
              return updated.name !== prev.name || updated.mobile !== prev.mobile || updated.upiId !== prev.upiId || updated.qrCode !== prev.qrCode ? updated : prev;
            });
            break;
          }
          case 'tickets': setTickets(asArray<Ticket>(result.value).filter((t: Ticket) => t.issueType !== 'Feedback')); break;
        }
      });
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') console.error(e);
      if (!silent) {
        const msg = (e as Error)?.message ? String((e as Error).message) : 'Failed to refresh dashboard.';
        toast.error(msg.includes('fetch') || msg.includes('network') ? 'Network error. Please check your connection.' : msg);
      }
    } finally {
      for (const k of needed) inFlightRef.current.delete(k);
      if (inFlightRef.current.size === 0) setLoading(false);
    }
  }, [user?.id]);

  // Trigger data load on tab change — only fetches keys not already cached
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    const tabChanged = prevTabRef.current !== activeTab;
    prevTabRef.current = activeTab;
    // silent: true on tab switch suppresses spinner; no force so shared keys stay cached
    loadData(tabChanged ? { silent: true } : undefined);
    return () => { fetchAbortRef.current?.abort(); };
  }, [loadData, activeTab]);

  useEffect(() => {
    if (!showNotifications) return;
    refreshNotifications();
  }, [showNotifications, refreshNotifications]);

  // Realtime: only invalidate data keys relevant to the SSE event, then refetch
  useEffect(() => {
    if (!user?.id) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const eventToKeys: Record<string, string[]> = {
      'orders.changed': ['orders'],
      'deals.changed': ['campaigns', 'deals'],
      'users.changed': ['pending', 'verified'],
      'tickets.changed': ['tickets'],
      'notifications.changed': [],
    };
    const schedule = (keysToInvalidate: string[]) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Skip keys that were just fetched by an explicit refresh (prevents double-fetch)
        const now = Date.now();
        const stale = keysToInvalidate.filter(k => (now - (lastFetchedAt.current[k] || 0)) > 2000);
        if (stale.length === 0) {
          if (showNotificationsRef.current) refreshNotifications();
          return;
        }
        // Always invalidate globally so other tabs see fresh data on next visit
        for (const k of stale) loadedRef.current.delete(k);
        // Only re-fetch if current tab actually needs these keys
        const relevant = stale.filter(k => tabDataNeedsRef.current.includes(k));
        if (relevant.length > 0) loadData({ silent: true });
        if (showNotificationsRef.current) refreshNotifications();
      }, 800);
    };
    const unsub = subscribeRealtime((msg) => {
      if (msg.type === 'notifications.changed') {
        if (showNotificationsRef.current) refreshNotifications();
        return;
      }
      const keys = eventToKeys[msg.type];
      if (keys && keys.length > 0) schedule(keys);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user?.id, refreshNotifications, loadData]);

  const refreshData = useCallback((keys?: string[]) => {
    if (keys) return loadData({ keys });
    return loadData({ force: true });
  }, [loadData]);

  const handlePublish = async () => {
    if (!dealBuilder || !user?.mediatorCode) return;
    try {
      const commissionValue = Math.trunc(Number(commission || 0));
      await api.ops.publishDeal(dealBuilder.id, commissionValue, user.mediatorCode);
      setDealBuilder(null);
      setCommission('');
      toast.success('Deal saved');
      loadData({ keys: ['campaigns', 'deals'] });
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') console.error(e);
      const msg = (e as Error)?.message ? String((e as Error).message) : 'Failed to publish deal.';
      toast.error(msg);
    }
  };

  const hasNotifications = unreadCount > 0;

  const handlePullRefresh = useCallback(async () => {
    await loadData({ force: true });
  }, [loadData]);
  const { handlers: pullHandlers, pullDistance, isRefreshing: isPullRefreshing } = usePullToRefresh({ onRefresh: handlePullRefresh });

  const unpublishedCount = useMemo(() => {
    const dealCampaignIds = new Set((deals || []).map((d: Product) => String(d.campaignId)));
    return (campaigns || []).filter((c: Campaign) => !dealCampaignIds.has(String(c.id))).length;
  }, [campaigns, deals]);

  return (
    <div className="flex flex-col h-[100dvh] min-h-0 bg-mobo-dark-50 font-sans relative overflow-hidden text-zinc-900 select-none">
      {/* Top Bar */}
      <div className="pt-safe-top pt-6 px-4 pb-2 bg-mobo-dark-50 z-30 flex justify-between items-center sticky top-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[0.8rem] bg-mobo-dark-900 text-white flex items-center justify-center font-black text-lg shadow-lg border-2 border-white overflow-hidden">
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
            <h1 className="text-lg font-black text-mobo-dark-900 leading-none tracking-tight">
              {user?.name || 'Unknown'}
            </h1>
            <div className="mt-1 flex items-center gap-2">
              <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-mobo-accent rounded-full animate-pulse shadow-[0_0_6px_theme(colors.mobo.accent)]"></span>{' '}
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

      <div
        className="flex-1 min-h-0 overflow-y-auto p-4 scrollbar-styled overscroll-none pb-[calc(7.5rem+env(safe-area-inset-bottom))]"
        {...swipeHandlers}
        onTouchStart={(e) => { swipeHandlers.onTouchStart(e); pullHandlers.onTouchStart(e); }}
        onTouchMove={pullHandlers.onTouchMove}
        onTouchEnd={(e) => { swipeHandlers.onTouchEnd(e); pullHandlers.onTouchEnd(); }}
      >
        <PullToRefreshIndicator distance={pullDistance} isRefreshing={isPullRefreshing} />
        <div>
        {activeTab === 'inbox' && (
          <InboxView
            orders={orders}
            pendingUsers={pendingUsers}
            tickets={tickets}
            loading={loading}
            onRefresh={refreshData}
            unpublishedCount={unpublishedCount}
            setPendingUsers={setPendingUsers}
            onGoToUnpublished={() => handleTabChange('market')}
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
            onRefresh={refreshData}
            onPublish={setDealBuilder}
            setCampaigns={setCampaigns}
          />
        )}
        {activeTab === 'squad' && user && (
          <SquadView
            user={user}
            pendingUsers={pendingUsers}
            verifiedUsers={verifiedUsers}
            orders={orders}
            loading={loading}
            onRefresh={refreshData}
            onSelectUser={setSelectedBuyer}
          />
        )}
        {activeTab === 'profile' && <MediatorProfileView />}
        </div>
      </div>

      <div className="fixed left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-[360px] bottom-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <MobileTabBar
          items={mediatorTabItems}
          activeId={activeTab}
          onChange={(id) => {
            handleTabChange(id as typeof activeTab);
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
          <div className="flex justify-between items-center p-5 text-white pt-safe-top border-b border-white/10 bg-mobo-dark-900 z-10 sticky top-0">
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
                        <p className="text-[11px] font-bold text-zinc-200">{d.toLocaleDateString('en-GB')}</p>
                      </div>
                    ) : null;
                  })()}
                </div>
              )}

              {/* Settlement details */}
              {(proofModal.settlementRef || proofModal.settlementMode) && (
                <div className="grid grid-cols-2 gap-3 mt-3">
                  {proofModal.settlementRef && (
                    <div className="bg-black/40 p-2.5 rounded-xl border border-emerald-500/20">
                      <p className="text-[9px] text-emerald-400 font-bold uppercase mb-1">UTR / Reference</p>
                      <p className="text-[11px] font-mono font-bold text-emerald-200">{proofModal.settlementRef}</p>
                    </div>
                  )}
                  {proofModal.settlementMode && (
                    <div className="bg-black/40 p-2.5 rounded-xl border border-emerald-500/20">
                      <p className="text-[9px] text-emerald-400 font-bold uppercase mb-1">Payment Mode</p>
                      <p className="text-[11px] font-bold text-emerald-200 uppercase">{proofModal.settlementMode}</p>
                    </div>
                  )}
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
          <div className="absolute bottom-0 left-0 w-full p-4 bg-mobo-dark-900 border-t border-white/10 z-20 flex gap-3">
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
                    await loadData({ keys: ['orders'] });
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
            {/* Force Approve & Cancel */}
            <button
              onClick={() => { setActionNote(''); setApproveModalOpen(true); }}
              disabled={!!(proofModal?.requirements?.missingProofs as string[] ?? []).length}
              className={`flex-1 py-4 font-bold text-sm rounded-[1.2rem] transition-colors ${
                (proofModal?.requirements?.missingProofs as string[] ?? []).length
                  ? 'bg-slate-500/20 text-slate-400 cursor-not-allowed'
                  : 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
              }`}
              title={
                (proofModal?.requirements?.missingProofs as string[] ?? []).length
                  ? `Buyer hasn't uploaded: ${(proofModal?.requirements?.missingProofs as string[] ?? []).join(', ')}`
                  : 'Force approve order to cooling period'
              }
            >
              Approve
            </button>
            <button
              onClick={() => { setActionReason(''); setCancelModalOpen(true); }}
              className="flex-1 py-4 bg-rose-500/20 text-rose-200 font-bold text-sm rounded-[1.2rem] hover:bg-rose-500/30 transition-colors"
              title="Cancel order and release campaign slot"
            >
              Cancel Order
            </button>
            {!proofModal?.verification?.orderVerified ? (
              <button
                onClick={async () => {
                  try {
                    const resp = await api.ops.verifyOrderClaim(proofModal.id);
                    const missingProofs: Array<'review' | 'rating' | 'returnWindow'> =
                      resp?.missingProofs || [];
                    const missingVerifications: Array<'review' | 'rating' | 'returnWindow'> =
                      resp?.missingVerifications || [];

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

                    await loadData({ keys: ['orders'] });
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
                className="flex-[2] py-4 bg-mobo-accent text-black font-black text-sm rounded-[1.2rem] shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2"
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

                        await loadData({ keys: ['orders'] });
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
                    className="flex-[2] py-4 bg-mobo-accent text-black font-black text-sm rounded-[1.2rem] shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:hover:scale-100"
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
          className="fixed inset-0 z-modal bg-black/80 flex items-center justify-center p-4"
          onClick={() => setRejectModalOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-mobo-dark-900 border border-white/10 p-5 text-white"
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
              aria-label="Proof type"
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
                    await loadData({ keys: ['orders'] });
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

      {/* FORCE APPROVE MODAL */}
      {approveModalOpen && proofModal && (
        <div
          className="fixed inset-0 z-modal bg-black/80 flex items-center justify-center p-4"
          onClick={() => setApproveModalOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-mobo-dark-900 border border-white/10 p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-bold text-base">Force Approve Order</h4>
              <button aria-label="Close" onClick={() => setApproveModalOpen(false)} className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-zinc-400 mb-4">
              Move order to <strong>Pending Cooling</strong> (14-day cooling period before settlement).
            </p>
            <label className="text-[10px] font-bold text-zinc-400 uppercase block mb-2">Optional Note</label>
            <textarea
              value={actionNote}
              onChange={(e) => setActionNote(e.target.value)}
              className="w-full rounded-xl bg-black/40 border border-white/10 p-3 text-sm font-bold text-white h-20 resize-none mb-4"
              placeholder="Reason for manual approval..."
            />
            <div className="flex gap-2">
              <button onClick={() => setApproveModalOpen(false)} className="flex-1 py-3 rounded-xl bg-white/10 text-white font-bold">Back</button>
              <button
                onClick={async () => {
                  try {
                    await api.ops.forceApproveOrder(proofModal.id, actionNote || undefined);
                    toast.success('Order approved → Pending Cooling (14 days)');
                    setApproveModalOpen(false);
                    setProofModal(null);
                    await loadData({ keys: ['orders'] });
                  } catch (err) {
                    toast.error(formatErrorMessage(err, 'Failed to approve order'));
                  }
                }}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold"
              >
                Approve Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CANCEL ORDER MODAL */}
      {cancelModalOpen && proofModal && (
        <div
          className="fixed inset-0 z-modal bg-black/80 flex items-center justify-center p-4"
          onClick={() => setCancelModalOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-mobo-dark-900 border border-white/10 p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-bold text-base">Cancel Order</h4>
              <button aria-label="Close" onClick={() => setCancelModalOpen(false)} className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center hover:bg-white/20">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-zinc-400 mb-4">
              Cancel this order and release the campaign slot. This cannot be undone.
            </p>
            <label className="text-[10px] font-bold text-zinc-400 uppercase block mb-2">Cancellation Reason</label>
            <textarea
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              className="w-full rounded-xl bg-black/40 border border-white/10 p-3 text-sm font-bold text-white h-24 resize-none mb-4"
              placeholder="Example: Duplicate order, buyer request..."
            />
            <div className="flex gap-2">
              <button onClick={() => setCancelModalOpen(false)} className="flex-1 py-3 rounded-xl bg-white/10 text-white font-bold">Keep</button>
              <button
                onClick={async () => {
                  try {
                    if (!actionReason.trim() || actionReason.trim().length < 5) {
                      toast.error('Cancellation reason must be at least 5 characters.');
                      return;
                    }
                    await api.ops.cancelOrder(proofModal.id, actionReason.trim());
                    toast.success('Order cancelled and slot released.');
                    setCancelModalOpen(false);
                    setProofModal(null);
                    await loadData({ keys: ['orders'] });
                  } catch (err) {
                    toast.error(formatErrorMessage(err, 'Failed to cancel order'));
                  }
                }}
                className="flex-1 py-3 rounded-xl bg-rose-500 text-white font-bold"
              >
                Cancel Now
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
                <p className="text-lg font-black text-blue-700">₹{dealBuilder.assignmentPayout ?? dealBuilder.payout ?? 0}</p>
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
                <p className="text-2xl font-black text-mobo-lime-600">
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
              const agencyComm = dealBuilder.assignmentPayout ?? dealBuilder.payout ?? 0;
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
                aria-label="Commission amount"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '' || raw === '-') {
                    setCommission(raw);
                    return;
                  }
                  const n = Math.trunc(Number(raw));
                  setCommission(String(n));
                }}
                className="w-full bg-white border-2 border-zinc-100 rounded-[1.5rem] p-4 text-2xl font-black text-center focus:border-mobo-accent focus:ring-4 focus:ring-mobo-accent/20 outline-none transition-all placeholder:text-zinc-200"
                placeholder="0"
              />
              <p className="text-[9px] text-zinc-400 text-center">Use negative value to give buyers a discount from your commission</p>
            </div>
            <button
              onClick={handlePublish}
              disabled={!user?.mediatorCode}
              className="w-full py-4 bg-mobo-dark-900 text-white rounded-[1.5rem] font-black text-base shadow-xl hover:bg-mobo-accent hover:text-black transition-all disabled:opacity-50 disabled:scale-100 active:scale-95 flex items-center justify-center gap-2"
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
          onRefresh={refreshData}
        />
      )}
      <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"><Spinner /></div>}>
        <RaiseTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} />
      </Suspense>
    </div>
  );
};
