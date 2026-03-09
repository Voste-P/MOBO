import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { formatErrorMessage } from '../utils/errors';
import { ProxiedImage } from '../components/ProxiedImage';
import { RaiseTicketModal } from '../components/RaiseTicketModal';
import TicketDetailModal from '../components/TicketDetailModal';
import { FeedbackCard } from '../components/FeedbackCard';
import { api, asArray } from '../services/api';
import { getApiBaseAbsolute } from '../utils/apiBaseUrl';
import { exportToGoogleSheet } from '../utils/exportToSheets';
import { subscribeRealtime } from '../services/realtime';
import { useRealtimeConnection } from '../hooks/useRealtimeConnection';
import { User, Campaign, Order, Ticket } from '../types';
import { EmptyState, Spinner } from '../components/ui';
import { ProofImage } from '../components/ProofImage';
import { DesktopShell } from '../components/DesktopShell';
import { formatCurrency } from '../utils/formatCurrency';
import { getPrimaryOrderId } from '../utils/orderHelpers';
import { csvSafe, downloadCsv } from '../utils/csvHelpers';
import {
  LayoutDashboard,
  Users,
  Layers,
  LogOut,
  Building2,
  Plus,
  TrendingUp,
  Wallet,
  Search,
  X,
  CheckCircle,
  Copy,
  Link as LinkIcon,
  Menu,
  AlertCircle,
  AlertTriangle,
  UserPlus,
  Box,
  IndianRupee,
  ChevronRight,
  Eye,
  FileText,
  Trash2,
  CreditCard,
  Send,
  Clock,
  Check,
  Share2,
  Save,
  Receipt,
  Download,
  ExternalLink,
  Star,
  MessageCircle,
  Banknote,
  Camera,
  Edit2,
  Lock,
  Hourglass,
  Gift,
  BookmarkPlus,
  Package,
  FileSpreadsheet,
  Sparkles,
  Loader2,
  HelpCircle,
  ClipboardList,
  ShieldAlert,
  Filter,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  ChartSuspense,
} from '../components/LazyCharts';

// formatCurrency, getPrimaryOrderId, urlToBase64, csvSafe, downloadCsv imported from shared/utils

// --- COMPONENTS ---

const SidebarItem = ({ icon, label, active, onClick, badge }: any) => (
  <button
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 group mb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none motion-reduce:transform-none ${
      active
        ? 'bg-purple-600 text-white shadow-lg shadow-purple-200'
        : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
    }`}
  >
    <div className="flex items-center gap-3">
      {React.cloneElement(icon, {
        size: 20,
        strokeWidth: active ? 2.5 : 2,
        className: active ? 'text-white' : 'text-slate-400 group-hover:text-slate-600',
      })}
      <span className={`text-sm ${active ? 'font-bold' : 'font-medium'}`}>{label}</span>
    </div>
    {badge > 0 && (
      <span
        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${active ? 'bg-white text-purple-600' : 'bg-purple-100 text-purple-600'}`}
      >
        {badge}
      </span>
    )}
  </button>
);

const StatCard = ({ label, value, icon: Icon, trend, colorClass = 'bg-white' }: any) => (
  <div
    className={`${colorClass} p-5 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all duration-300 group`}
  >
    <div className="flex justify-between items-start mb-4">
      <div className="p-3 rounded-xl bg-slate-50 text-slate-600 group-hover:bg-purple-50 group-hover:text-purple-600 transition-colors">
        <Icon size={22} />
      </div>
      {trend && (
        <span className="flex items-center gap-1 text-[10px] font-bold bg-green-50 text-green-700 px-2 py-1 rounded-full border border-green-100">
          <TrendingUp size={10} /> {trend}
        </span>
      )}
    </div>
    <div>
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">{label}</p>
      <h3 className="text-2xl font-black text-slate-900 tracking-tight">{value}</h3>
    </div>
  </div>
);

// --- VIEWS ---

const AgencyProfile = ({ user }: any) => {
  const { updateUser } = useAuth();
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    name: user?.name || '',
    mobile: user?.mobile || '',
    upiId: user?.upiId || '',
    bankName: user?.bankDetails?.bankName || '',
    accountNumber: user?.bankDetails?.accountNumber || '',
    ifsc: user?.bankDetails?.ifsc || '',
    holderName: user?.bankDetails?.holderName || '',
  });
  const [avatar, setAvatar] = useState(user?.avatar);

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name || '',
        mobile: user.mobile || '',
        upiId: user.upiId || '',
        bankName: user.bankDetails?.bankName || '',
        accountNumber: user.bankDetails?.accountNumber || '',
        ifsc: user.bankDetails?.ifsc || '',
        holderName: user.bankDetails?.holderName || '',
      });
      setAvatar(user.avatar);
    }
  }, [user]);

  const handleSave = async () => {
    setLoading(true);
    try {
      await updateUser({
        name: form.name,
        mobile: form.mobile,
        upiId: form.upiId,
        bankDetails: {
          bankName: form.bankName,
          accountNumber: form.accountNumber,
          ifsc: form.ifsc,
          holderName: form.holderName,
        },
        avatar,
      });
      setIsEditing(false);
      toast.success('Profile updated');
    } catch (err) {
      console.error('Failed to update profile:', err);
      toast.error('Failed to update profile.');
    } finally {
      setLoading(false);
    }
  };

  const handleFile = (e: any) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) { toast.error('Avatar must be under 2 MB'); return; }
      if (!isEditing) setIsEditing(true);
      const reader = new FileReader();
      reader.onload = () => setAvatar(reader.result as string);
      reader.readAsDataURL(file);
    }
  };
  return (
    <div className="max-w-5xl mx-auto animate-enter pb-12">
      {/* Header */}
      <div className="bg-white rounded-[2.5rem] shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden relative mb-8 group">
        <div className="h-32 bg-gradient-to-r from-purple-600 to-indigo-600 relative">
          <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20"></div>
        </div>
        <div className="px-8 pb-8 flex flex-col md:flex-row items-end -mt-12 gap-6">
          <div className="relative">
            <div className="w-32 h-32 rounded-[2rem] bg-white p-2 shadow-lg border border-slate-100 flex-shrink-0">
              <div className="w-full h-full bg-slate-900 rounded-[1.5rem] flex items-center justify-center text-4xl font-black text-white overflow-hidden relative group-hover:scale-[1.02] transition-transform duration-500">
                {avatar ? (
                  <ProxiedImage
                    src={avatar}
                    alt={user?.name ? `${user.name} avatar` : 'Avatar'}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  user?.name?.charAt(0)
                )}
                {isEditing && (
                  <div
                    className="absolute inset-0 bg-black/50 flex items-center justify-center cursor-pointer"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Camera className="text-white" />
                  </div>
                )}
              </div>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              aria-label="Upload profile photo"
              onChange={handleFile}
            />
          </div>

          <div className="flex-1 pb-2 flex justify-between items-end">
            <div>
              <h2 className="text-3xl font-black text-slate-900">{user?.name}</h2>
              <div className="flex items-center gap-4 mt-2">
                <span className="px-3 py-1 bg-purple-50 text-purple-700 rounded-lg text-xs font-bold border border-purple-100">
                  Agency Partner
                </span>
                <span
                  className="flex items-center gap-1.5 text-xs font-bold text-slate-500 font-mono bg-slate-50 px-2 py-1 rounded border border-slate-200 cursor-pointer hover:bg-slate-100"
                  onClick={() => {
                    navigator.clipboard.writeText(user?.mediatorCode || '');
                    toast.success('Code copied');
                  }}
                >
                  {user?.mediatorCode} <Copy size={12} />
                </span>
              </div>
            </div>
            <button
              onClick={() => (isEditing ? handleSave() : setIsEditing(true))}
              disabled={loading}
              className={`px-6 py-3 rounded-xl font-bold text-sm shadow-lg transition-all active:scale-95 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${isEditing ? 'bg-green-500 text-white hover:bg-green-600' : 'bg-slate-900 text-white hover:bg-slate-800'}`}
            >
              {isEditing ? (
                <>
                  <Save size={18} /> Save Changes
                </>
              ) : (
                <>
                  <Edit2 size={18} /> Edit Profile
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Agency Details */}
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 space-y-6 h-full">
          <h3 className="font-bold text-lg text-slate-900 flex items-center gap-2">
            <Building2 size={20} /> Agency Details
          </h3>

          <div className="space-y-4">
            <div className="group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Agency Name
              </label>
              <input
                type="text"
                disabled={!isEditing}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                aria-label="Agency Name"
                className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:opacity-70 disabled:bg-slate-50/50 transition-all"
              />
            </div>
            <div className="group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Contact Number
              </label>
              <input
                type="tel"
                disabled={!isEditing}
                value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                aria-label="Contact Number"
                className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:opacity-70 disabled:bg-slate-50/50 transition-all"
              />
            </div>
            <div className="group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Agency ID (Fixed)
              </label>
              <div className="w-full p-4 bg-slate-100 border border-slate-200 rounded-xl font-mono font-bold text-slate-500">
                {user?.mediatorCode}
              </div>
            </div>
          </div>
        </div>

        {/* Banking & Settlement */}
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100 space-y-6 h-full">
          <h3 className="font-bold text-lg text-slate-900 flex items-center gap-2">
            <Wallet size={20} /> Banking & Settlement
          </h3>

          <div className="space-y-4">
            <div className="group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Official UPI ID
              </label>
              <input
                type="text"
                disabled={!isEditing}
                value={form.upiId}
                onChange={(e) => setForm({ ...form, upiId: e.target.value })}
                placeholder="agency@upi"
                className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:opacity-70 disabled:bg-slate-50/50 transition-all"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="group">
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Bank Name
                </label>
                <input
                  type="text"
                  disabled={!isEditing}
                  value={form.bankName}
                  onChange={(e) => setForm({ ...form, bankName: e.target.value })}
                  placeholder="e.g. HDFC"
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:opacity-70 disabled:bg-slate-50/50 transition-all"
                />
              </div>
              <div className="group">
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                  IFSC Code
                </label>
                <input
                  type="text"
                  disabled={!isEditing}
                  value={form.ifsc}
                  onChange={(e) => setForm({ ...form, ifsc: e.target.value })}
                  placeholder="HDFC000..."
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:opacity-70 disabled:bg-slate-50/50 transition-all"
                />
              </div>
            </div>

            <div className="group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Account Number
              </label>
              <input
                type="text"
                disabled={!isEditing}
                value={form.accountNumber}
                onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
                aria-label="Account Number"
                className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl font-mono font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:opacity-70 disabled:bg-slate-50/50 transition-all"
              />
            </div>

            <div className="group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Account Holder Name
              </label>
              <input
                type="text"
                disabled={!isEditing}
                value={form.holderName}
                onChange={(e) => setForm({ ...form, holderName: e.target.value })}
                aria-label="Account Holder Name"
                className="w-full p-4 bg-slate-50 border border-slate-100 rounded-xl font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-purple-200 disabled:opacity-70 disabled:bg-slate-50/50 transition-all"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Feedback Section */}
      <div className="mt-8">
        <FeedbackCard role="agency" />
      </div>
    </div>
  );
};

const FinanceView = ({ allOrders, mediators: _mediators, loading, onRefresh, user }: any) => {
  const { toast } = useToast();
  const [sheetsExporting, setSheetsExporting] = useState(false);
  // Flatten orders for detailed ledger view
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [newStatus, setNewStatus] = useState<string>('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [financeSearch, setFinanceSearch] = useState('');
  const [financeStatusFilter, setFinanceStatusFilter] = useState<string>('All');
  const [financeDealTypeFilter, setFinanceDealTypeFilter] = useState<string>('All');
  const [financeMediatorFilter, setFinanceMediatorFilter] = useState<string>('All');
  const [financeProductFilter, setFinanceProductFilter] = useState<string>('All');
  const [financeViewMode, setFinanceViewMode] = useState<'ledger' | 'orders' | 'finance'>('ledger');

  // Unique mediators and products for filter dropdowns
  const mediatorOptions = useMemo(() => {
    const codes = new Set<string>();
    (allOrders as Order[]).forEach((o: Order) => {
      const label = o.managerName || o.mediatorCode || '';
      if (label) codes.add(label);
    });
    return Array.from(codes).sort();
  }, [allOrders]);

  const productOptions = useMemo(() => {
    const titles = new Set<string>();
    (allOrders as Order[]).forEach((o: Order) => {
      const t = o.items?.[0]?.title || '';
      if (t) titles.add(t);
    });
    return Array.from(titles).sort();
  }, [allOrders]);

  const ledger = useMemo(() => {
    let result = allOrders as Order[];
    if (financeStatusFilter !== 'All') {
      result = result.filter((o: Order) => {
        const st = o.affiliateStatus === 'Unchecked' ? o.paymentStatus : o.affiliateStatus;
        return String(st).toLowerCase() === financeStatusFilter.toLowerCase();
      });
    }
    if (financeDealTypeFilter !== 'All') {
      result = result.filter((o: Order) =>
        String(o.items?.[0]?.dealType || '').toLowerCase() === financeDealTypeFilter.toLowerCase()
      );
    }
    if (financeMediatorFilter !== 'All') {
      result = result.filter((o: Order) => {
        const label = (o as any).managerName || (o as any).mediatorCode || '';
        return label === financeMediatorFilter;
      });
    }
    if (financeProductFilter !== 'All') {
      result = result.filter((o: Order) =>
        (o.items?.[0]?.title || '') === financeProductFilter
      );
    }
    if (financeSearch.trim()) {
      const q = financeSearch.trim().toLowerCase();
      result = result.filter((o: Order) =>
        (getPrimaryOrderId(o) || '').toLowerCase().includes(q) ||
        (o.buyerName || '').toLowerCase().includes(q) ||
        (o.brandName || '').toLowerCase().includes(q) ||
        (o.items?.[0]?.title || '').toLowerCase().includes(q) ||
        (o.managerName || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [allOrders, financeSearch, financeStatusFilter, financeDealTypeFilter, financeMediatorFilter, financeProductFilter]);

  // [PERF] Memoize volume calculations — only recalculate when ledger changes
  const { settledVolume, coolingVolume, pendingReviewVolume, grossPayableAmount } = useMemo(() => ({
    settledVolume: ledger
      .filter((o: Order) => o.paymentStatus === 'Paid' && o.affiliateStatus === 'Approved_Settled')
      .reduce((sum: number, o: Order) => sum + o.total, 0),
    coolingVolume: ledger
      .filter((o: Order) => o.affiliateStatus === 'Pending_Cooling')
      .reduce((sum: number, o: Order) => sum + o.total, 0),
    pendingReviewVolume: ledger
      .filter((o: Order) => o.affiliateStatus === 'Unchecked')
      .reduce((sum: number, o: Order) => sum + o.total, 0),
    grossPayableAmount: ledger
      .reduce((sum: number, o: Order) => sum + (o.items?.[0]?.commission || 0), 0),
  }), [ledger]);

  const handleUpdate = async () => {
    if (!editingOrder) return;
    setIsUpdating(true);
    // Real update via Ops API.
    try {
      if (newStatus === 'Paid') await api.ops.settleOrderPayment(editingOrder.id, undefined, 'external');
      else if (newStatus === 'Pending') await api.ops.unsettleOrderPayment(editingOrder.id);

      toast.success('Ledger updated');
      setEditingOrder(null);
      onRefresh();
    } catch (err) {
      console.error('Ledger update failed:', err);
      toast.error('Update failed');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleExport = () => {
    if (ledger.length === 0) { toast.info('No orders to export'); return; }
    const apiBase = getApiBaseAbsolute();
    const buildProofUrl = (orderId: string, type: 'order' | 'payment' | 'rating' | 'review' | 'returnWindow') => {
      return `${apiBase}/orders/${encodeURIComponent(orderId)}/proof/${type}`;
    };

    // csvSafe imported from shared/utils/csvHelpers
    const csvEscape = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const hyperlinkYes = (url?: string) =>
      url ? csvEscape(`=HYPERLINK("${url}","Yes")`) : 'No';

    // Build filter summary for metadata row
    const activeFilters: string[] = [];
    if (financeStatusFilter !== 'All') activeFilters.push(`Status: ${financeStatusFilter}`);
    if (financeDealTypeFilter !== 'All') activeFilters.push(`Deal Type: ${financeDealTypeFilter}`);
    if (financeMediatorFilter !== 'All') activeFilters.push(`Mediator: ${financeMediatorFilter}`);
    if (financeProductFilter !== 'All') activeFilters.push(`Product: ${financeProductFilter}`);
    if (financeSearch) activeFilters.push(`Search: ${financeSearch}`);

    const headers = [
      'Order ID',
      'Date',
      'Time',
      'Product',
      'Brand',
      'Platform',
      'Deal Type',
      'Unit Price',
      'Quantity',
      'Total Value',
      'Commission (₹)',
      'Settlement Date',
      'Agency Name',
      'Mediator Name',
      'Mediator Code',
      'Buyer Name',
      'Buyer Mobile',
      'Reviewer Name',
      'Workflow Status',
      'Payment Status',
      'Verification Status',
      'Internal Ref',
      'Sold By',
      'Order Date',
      'Extracted Product',
      'UTR/Reference',
      'Payment Mode',
      'Proof: Order',
      'Proof: Payment',
      'Proof: Rating',
      'Proof: Review Link',
      'Proof: Return Window',
    ];

    const csvRows: string[] = [];
    // Metadata header
    csvRows.push(`"Agency Orders Report - ${new Date().toLocaleDateString('en-GB')}","Generated: ${new Date().toLocaleString('en-GB')}","Total Orders: ${ledger.length}","${activeFilters.length ? 'Filters: ' + activeFilters.join(' | ') : 'Filters: None'}"`);
    csvRows.push(''); // blank separator row
    csvRows.push(headers.join(','));

    let totalValue = 0;
    let totalCommission = 0;

    ledger.forEach((o: Order) => {
      const dateObj = new Date(o.createdAt);
      const date = dateObj.toLocaleDateString('en-GB');
      const time = dateObj.toLocaleTimeString('en-GB');
      const item = o.items?.[0];
      totalValue += o.total || 0;
      totalCommission += item?.commission || 0;

      const row = [
        csvSafe(getPrimaryOrderId(o)),
        date,
        time,
        csvSafe(item?.title || ''),
        csvSafe(item?.brandName || ''),
        csvSafe(item?.platform || ''),
        csvSafe(item?.dealType || 'Discount'),
        item?.priceAtPurchase,
        item?.quantity || 1,
        o.total,
        item?.commission || 0,
        (o as any).expectedSettlementDate ? new Date((o as any).expectedSettlementDate).toLocaleDateString('en-GB') : '',
        csvSafe(o.agencyName || user?.name || 'Agency'),
        csvSafe(o.managerName || ''),
        csvSafe(o.mediatorCode || (o as any).managerCode || ''),
        csvSafe(o.buyerName || ''),
        csvSafe(o.buyerMobile || ''),
        csvSafe(o.reviewerName || ''),
        csvSafe(o.workflowStatus || o.status || ''),
        csvSafe(o.paymentStatus || ''),
        csvSafe(o.affiliateStatus || ''),
        o.id,
        csvSafe(o.soldBy || ''),
        o.orderDate ? new Date(o.orderDate).toLocaleDateString('en-GB') : '',
        csvSafe(o.extractedProductName || ''),
        csvSafe(o.settlementRef || ''),
        csvSafe(o.settlementMode || ''),
        o.screenshots?.order ? hyperlinkYes(buildProofUrl(o.id, 'order')) : 'No',
        o.screenshots?.payment ? hyperlinkYes(buildProofUrl(o.id, 'payment')) : 'No',
        o.screenshots?.rating ? hyperlinkYes(buildProofUrl(o.id, 'rating')) : 'No',
        (o.reviewLink || o.screenshots?.review)
          ? hyperlinkYes(buildProofUrl(o.id, 'review'))
          : 'No',
        o.screenshots?.returnWindow
          ? hyperlinkYes(buildProofUrl(o.id, 'returnWindow'))
          : 'No',
      ];
      csvRows.push(row.join(','));
    });

    // Totals row
    csvRows.push('');
    csvRows.push(`"TOTALS","","","","","","","","",${totalValue.toFixed(2)},${totalCommission.toFixed(2)},"","","","","","","","","","","","","","","","","","",""`);

    const filterSlug = activeFilters.length ? '_filtered' : '';
    const csvString = csvRows.join('\n');
    downloadCsv(`agency_orders_report_${new Date().toISOString().slice(0, 10)}${filterSlug}.csv`, csvString);
  };

  const handleExportToSheets = () => {
    const orderRows = ledger.map((o: Order) => {
      const dateObj = new Date(o.createdAt);
      const item = o.items?.[0];
      return [
        getPrimaryOrderId(o),
        dateObj.toLocaleDateString('en-GB'),
        dateObj.toLocaleTimeString('en-GB'),
        item?.title || '',
        item?.brandName || '',
        item?.platform || '',
        item?.dealType || 'Discount',
        item?.priceAtPurchase ?? 0,
        item?.quantity || 1,
        o.total,
        item?.commission || 0,
        (o as any).expectedSettlementDate ? new Date((o as any).expectedSettlementDate).toLocaleDateString('en-GB') : '',
        o.agencyName || user?.name || 'Agency',
        o.managerName || '',
        o.mediatorCode || (o as any).managerCode || '',
        o.buyerName || '',
        o.buyerMobile || '',
        (o as any).reviewerName || '',
        o.workflowStatus || o.status || '',
        o.paymentStatus,
        o.affiliateStatus || '',
        o.id,
        o.soldBy || '',
        o.orderDate ? new Date(o.orderDate).toLocaleDateString('en-GB') : '',
        o.extractedProductName || '',
        o.settlementRef || '',
        o.settlementMode || '',
      ] as (string | number)[];
    });

    exportToGoogleSheet({
      title: `Agency Orders Report - ${new Date().toISOString().slice(0, 10)}`,
      headers: ['Order ID','Date','Time','Product','Brand','Platform','Deal Type','Unit Price','Quantity','Total Value','Commission (₹)','Settlement Date','Agency Name','Mediator Name','Mediator Code','Buyer Name','Buyer Mobile','Reviewer Name','Workflow Status','Payment Status','Verification Status','Internal Ref','Sold By','Order Date','Extracted Product','UTR/Reference','Payment Mode'],
      rows: orderRows,
      sheetName: 'Agency Orders',
      onStart: () => setSheetsExporting(true),
      onEnd: () => setSheetsExporting(false),
      onSuccess: () => toast.success('Exported to Google Sheets!'),
      onError: (msg) => toast.error(msg),
    });
  };

  return (
    <div className="space-y-6 animate-enter pb-12 h-full flex flex-col">
      {/* Header & Integrated Stats */}
      <div className="bg-white rounded-[2rem] border border-slate-100 shadow-sm flex flex-col flex-1 overflow-hidden relative">
        <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-6 bg-slate-50/50">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-100 text-purple-700 rounded-2xl shadow-inner">
              <FileText size={24} />
            </div>
            <div>
              <h3 className="font-extrabold text-2xl text-slate-900">Financial Ledger</h3>
              <p className="text-xs text-slate-500 font-bold mt-1">
                Detailed breakdown of all network orders
              </p>
            </div>
          </div>

          {/* Compact Integrated Stats */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8 bg-white p-1.5 rounded-2xl border border-slate-100 shadow-sm">
            <div className="px-4 py-2 flex flex-col justify-center border-b sm:border-b-0 sm:border-r border-slate-50 w-full sm:w-auto">
              <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-0.5 flex items-center gap-1">
                <CheckCircle size={10} className="text-green-500" /> Settled
              </p>
              <p className="text-lg font-black text-slate-900 leading-tight">
                {formatCurrency(settledVolume)}
              </p>
            </div>
            <div className="px-4 py-2 flex flex-col justify-center border-b sm:border-b-0 sm:border-r border-slate-50 w-full sm:w-auto">
              <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-0.5 flex items-center gap-1">
                <Lock size={10} className="text-blue-500" /> Locked (Cooling)
              </p>
              <p className="text-lg font-black text-slate-900 leading-tight">
                {formatCurrency(coolingVolume)}
              </p>
            </div>
            <div className="px-4 py-2 flex flex-col justify-center w-full sm:w-auto">
              <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-0.5 flex items-center gap-1">
                <Hourglass size={10} className="text-amber-500" /> Pending Review
              </p>
              <p className="text-lg font-black text-slate-900 leading-tight">
                {formatCurrency(pendingReviewVolume)}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleExport}
              className="text-xs font-bold text-purple-600 flex items-center gap-2 hover:bg-purple-50 px-4 py-3 rounded-xl transition-colors border border-transparent hover:border-purple-100"
            >
              <Download size={16} /> CSV
            </button>
            <button
              onClick={handleExportToSheets}
              disabled={sheetsExporting}
              className="text-xs font-bold text-green-600 flex items-center gap-2 hover:bg-green-50 px-4 py-3 rounded-xl transition-colors border border-transparent hover:border-green-100 disabled:opacity-50"
            >
              <FileSpreadsheet size={16} /> {sheetsExporting ? 'Exporting...' : 'Google Sheets'}
            </button>
          </div>
        </div>

        {/* Finance Search + Filter */}
        <div className="px-6 py-3 border-b border-slate-100 flex gap-3 flex-wrap items-center">
          <div className="flex-1 min-w-[180px] relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={financeSearch}
              onChange={(e) => setFinanceSearch(e.target.value)}
              placeholder="Search orders, buyers, mediators..."
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 text-xs font-medium focus:border-purple-300 focus:ring-2 focus:ring-purple-100 outline-none"
            />
          </div>
          <select
            value={financeStatusFilter}
            onChange={(e) => setFinanceStatusFilter(e.target.value)}
            aria-label="Filter by status"
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold bg-white"
          >
            <option value="Pending">Pending</option>
            <option value="Pending_Cooling">Cooling</option>
            <option value="Approved_Settled">Settled</option>
            <option value="Paid">Paid</option>
          </select>
          <select
            value={financeDealTypeFilter}
            onChange={(e) => setFinanceDealTypeFilter(e.target.value)}
            aria-label="Filter by deal type"
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold bg-white"
          >
            <option value="Discount">Order Deal</option>
            <option value="Rating">Rating Deal</option>
            <option value="Review">Review Deal</option>
          </select>
          <select
            value={financeMediatorFilter}
            onChange={(e) => setFinanceMediatorFilter(e.target.value)}
            aria-label="Filter by mediator"
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold bg-white max-w-[160px]"
          >
            {mediatorOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select
            value={financeProductFilter}
            onChange={(e) => setFinanceProductFilter(e.target.value)}
            aria-label="Filter by product"
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold bg-white max-w-[200px] truncate"
          >
            {productOptions.map((p) => (
              <option key={p} value={p}>{p.length > 30 ? p.slice(0, 30) + '…' : p}</option>
            ))}
          </select>
          <span className="text-xs text-slate-400 font-bold">{ledger.length} records</span>
        </div>

        {/* View Mode Tabs */}
        <div className="px-6 py-2 border-b border-slate-100 flex gap-2">
          {(['ledger', 'orders', 'finance'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFinanceViewMode(mode)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                financeViewMode === mode
                  ? 'bg-purple-600 text-white shadow-lg'
                  : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
              }`}
            >
              {mode === 'ledger' ? 'Ledger' : mode === 'orders' ? 'Order Sheet' : 'Finance Sheet'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-0 scrollbar-styled">
          {/* === LEDGER VIEW === */}
          {financeViewMode === 'ledger' && (<>
          {ledger.length === 0 ? (
            <div className="p-6">
              {loading ? (
                <EmptyState
                  title="Loading transactions"
                  description="Loading the latest financial ledger."
                  icon={<Spinner className="w-5 h-5 text-slate-400" />}
                  className="bg-transparent"
                />
              ) : (
                <EmptyState
                  title="No transactions yet"
                  description="Once orders start flowing through your network, they'll appear here."
                  icon={<Receipt size={22} className="text-slate-400" />}
                  className="bg-transparent"
                />
              )}
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50 text-slate-400 text-[10px] font-extrabold uppercase tracking-wider sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="p-5 pl-8">Order ID / Date</th>
                  <th className="p-5">Brand & Product</th>
                  <th className="p-5">Mediator</th>
                  <th className="p-5 text-right">Amount</th>
                  <th className="p-5 pr-8 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-sm">
                {ledger.map((o: Order) => (
                  <tr key={o.id} className="hover:bg-slate-50/80 transition-colors group">
                    <td className="p-5 pl-8">
                      <div className="font-mono text-xs font-bold text-slate-900 group-hover:text-purple-600 transition-colors">
                        {getPrimaryOrderId(o)}
                      </div>
                      <div className="text-[10px] text-slate-400 font-bold mt-0.5">
                        {new Date(o.createdAt).toLocaleDateString('en-GB')}
                      </div>
                    </td>
                    <td className="p-5">
                      <div className="font-bold text-slate-900 text-sm mb-0.5">
                        {o.brandName || 'Brand'}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate max-w-[180px]">
                        {o.items[0]?.title}
                      </div>
                      {o.soldBy && o.soldBy !== 'null' && o.soldBy !== 'undefined' && (
                        <div className="text-[9px] text-slate-400 mt-0.5">Seller: {o.soldBy}</div>
                      )}
                    </td>
                    <td className="p-5">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-black text-slate-500">
                          M
                        </div>
                        <div>
                          <div className="text-xs font-bold text-slate-700">
                            {o.managerName || 'Unknown'}
                          </div>
                          <div className="text-[9px] text-slate-400 font-mono">
                            {o.mediatorCode || o.managerCode || ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="p-5 text-right font-mono font-bold text-slate-900">
                      {formatCurrency(o.total)}
                    </td>
                    <td className="p-5 pr-8 text-right">
                      <button
                        className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase border cursor-pointer hover:scale-105 transition-transform ${
                          o.paymentStatus === 'Paid'
                            ? 'bg-green-50 text-green-700 border-green-100'
                            : o.affiliateStatus === 'Pending_Cooling'
                              ? 'bg-blue-50 text-blue-700 border-blue-100'
                              : 'bg-amber-50 text-amber-700 border-amber-100'
                        }`}
                        onClick={() => {
                          setEditingOrder(o);
                          setNewStatus(o.paymentStatus);
                        }}
                      >
                        {o.paymentStatus === 'Paid' ? (
                          <CheckCircle size={10} className="stroke-[3]" />
                        ) : o.affiliateStatus === 'Pending_Cooling' ? (
                          <Lock size={10} className="stroke-[3]" />
                        ) : (
                          <Clock size={10} className="stroke-[3]" />
                        )}
                        {o.paymentStatus === 'Paid'
                          ? 'Paid'
                          : o.affiliateStatus === 'Pending_Cooling'
                            ? 'Locked'
                            : 'Pending'}
                        <Edit2 size={8} className="ml-1 opacity-50" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </>)}

          {/* === ORDER SHEET VIEW === */}
          {financeViewMode === 'orders' && (
            ledger.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-20">
                <div className="text-center">
                  <FileText size={48} className="mx-auto mb-4 text-slate-200" />
                  <p className="text-sm text-slate-400">No orders found</p>
                </div>
              </div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="sticky top-0 bg-gradient-to-r from-slate-50 to-white z-10">
                    <th className="p-4 pl-8 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Order ID</th>
                    <th className="p-4 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Mediator</th>
                    <th className="p-4 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Product</th>
                    <th className="p-4 text-right text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Amount</th>
                    <th className="p-4 text-right text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Amount Payable</th>
                    <th className="p-4 pr-8 text-right text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Deal Type</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((o: any, i: number) => (
                    <tr key={o._id || i} className="border-b border-slate-50 hover:bg-purple-50/30 transition-colors">
                      <td className="p-4 pl-8">
                        <span className="font-mono text-xs font-bold text-slate-700">{getPrimaryOrderId(o)}</span>
                        <div className="text-[9px] text-slate-400 mt-0.5">
                          {new Date(o.createdAt).toLocaleDateString('en-GB')}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center text-[9px] font-bold text-purple-600">M</div>
                          <div>
                            <div className="text-xs font-bold text-slate-700">{o.managerName || 'Unknown'}</div>
                            <div className="text-[9px] text-slate-400 font-mono">{o.mediatorCode || o.managerCode || ''}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="text-xs font-semibold text-slate-700 max-w-[150px] truncate">{o.items?.[0]?.productName || 'Product'}</div>
                        <div className="text-[9px] text-slate-400">Qty: {o.items?.[0]?.qty || 1}</div>
                      </td>
                      <td className="p-4 text-right font-mono font-bold text-slate-900">{formatCurrency(o.total)}</td>
                      <td className="p-4 text-right font-mono font-bold text-lime-600">{formatCurrency(o.commission || 0)}</td>
                      <td className="p-4 pr-8 text-right">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          o.dealType === 'Rating' ? 'bg-orange-50 text-orange-600' :
                          o.dealType === 'Review' ? 'bg-purple-50 text-purple-600' :
                          'bg-lime-50 text-lime-600'
                        }`}>
                          {o.dealType === 'Discount' ? 'Order' : o.dealType || 'Order'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* === FINANCE SHEET VIEW === */}
          {financeViewMode === 'finance' && (
            ledger.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-20">
                <div className="text-center">
                  <FileText size={48} className="mx-auto mb-4 text-slate-200" />
                  <p className="text-sm text-slate-400">No finance records found</p>
                </div>
              </div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="sticky top-0 bg-gradient-to-r from-slate-50 to-white z-10">
                    <th className="p-4 pl-8 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest w-12">S.No</th>
                    <th className="p-4 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Brand</th>
                    <th className="p-4 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Product</th>
                    <th className="p-4 text-center text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Slots</th>
                    <th className="p-4 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Mediator</th>
                    <th className="p-4 text-right text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Amount Payable</th>
                    <th className="p-4 pr-8 text-right text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Deal Type</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((o: any, i: number) => (
                    <tr key={o._id || i} className="border-b border-slate-50 hover:bg-purple-50/30 transition-colors">
                      <td className="p-4 pl-8 text-xs font-mono text-slate-400">{i + 1}</td>
                      <td className="p-4">
                        <div className="text-xs font-bold text-slate-700">{o.brandName || o.items?.[0]?.brandName || 'Brand'}</div>
                      </td>
                      <td className="p-4">
                        <div className="text-xs font-semibold text-slate-700 max-w-[150px] truncate">{o.items?.[0]?.productName || 'Product'}</div>
                      </td>
                      <td className="p-4 text-center">
                        <span className="text-xs font-bold text-slate-600">{o.items?.[0]?.qty || 1}</span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center text-[9px] font-bold text-purple-600">M</div>
                          <div>
                            <div className="text-xs font-bold text-slate-700">{o.managerName || 'Unknown'}</div>
                            <div className="text-[9px] text-slate-400 font-mono">{o.mediatorCode || o.managerCode || ''}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 text-right font-mono font-bold text-lime-600">{formatCurrency(o.commission || 0)}</td>
                      <td className="p-4 pr-8 text-right">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          o.dealType === 'Rating' ? 'bg-orange-50 text-orange-600' :
                          o.dealType === 'Review' ? 'bg-purple-50 text-purple-600' :
                          'bg-lime-50 text-lime-600'
                        }`}>
                          {o.dealType === 'Discount' ? 'Order' : o.dealType || 'Order'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Gross Payable Footer */}
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-slate-200">
                    <td colSpan={5} className="p-4 pl-8 text-xs font-extrabold text-slate-700 uppercase">Gross Payable Amount</td>
                    <td className="p-4 text-right font-mono font-extrabold text-lg text-lime-600">{formatCurrency(grossPayableAmount)}</td>
                    <td className="p-4 pr-8"></td>
                  </tr>
                </tfoot>
              </table>
            )
          )}
        </div>

        {/* EDIT MODAL */}
        {editingOrder && (
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in"
            onClick={() => setEditingOrder(null)}
          >
            <div
              className="bg-white p-6 rounded-3xl w-full max-w-sm shadow-2xl animate-slide-up"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-extrabold text-slate-900 mb-2">Update Ledger Entry</h3>
              <p className="text-xs text-slate-500 mb-6 font-mono">
                Order {getPrimaryOrderId(editingOrder)}
              </p>

              <div className="space-y-3 mb-6">
                {['Pending', 'Paid'].map((status) => (
                  <button
                    key={status}
                    onClick={() => setNewStatus(status)}
                    className={`w-full p-4 rounded-xl text-sm font-bold flex items-center justify-between border-2 transition-all ${
                      newStatus === status
                        ? 'border-purple-500 bg-purple-50 text-purple-700'
                        : 'border-slate-100 bg-white text-slate-500 hover:border-slate-200'
                    }`}
                  >
                    {status}
                    {newStatus === status && <CheckCircle size={16} className="text-purple-600" />}
                  </button>
                ))}
              </div>

              <button
                onClick={handleUpdate}
                disabled={isUpdating}
                className="w-full py-4 bg-black text-white rounded-2xl font-bold text-sm hover:bg-green-600 transition-colors"
              >
                {isUpdating ? 'Updating...' : 'Confirm Update'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const BrandsView = () => {
  const [brandCode, setBrandCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = brandCode.trim().toUpperCase();
    if (!code) return;
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      await api.ops.connectBrand(code);
      setSuccessMsg(`Request sent to Brand ${code}.`);
      setBrandCode('');
    } catch (e: any) {
      // Idempotent UX: if it's already connected/pending, treat as success.
      if (e?.code === 'ALREADY_REQUESTED') {
        setSuccessMsg(`Already connected or already pending for ${code}.`);
        setBrandCode('');
      } else {
        setErrorMsg(String(e?.message || 'Failed to send request.'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-enter h-full flex flex-col items-center justify-center p-8">
      <div className="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100 max-w-md w-full relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-purple-50 rounded-full blur-3xl -mr-10 -mt-10"></div>

        <div className="relative z-10 text-center mb-8">
          <div className="w-16 h-16 bg-slate-900 text-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
            <LinkIcon size={28} />
          </div>
          <h3 className="text-2xl font-extrabold text-slate-900 mb-2">Connect Brand</h3>
          <p className="text-sm text-slate-500 font-medium">
            Enter a unique Brand Code to request partnership access.
          </p>
        </div>

        <form onSubmit={handleConnect} className="relative z-10 space-y-4">
          <div className="bg-slate-50 p-2 rounded-2xl border border-slate-200 focus-within:border-purple-500 focus-within:ring-4 focus-within:ring-purple-100 transition-all">
            <input
              type="text"
              placeholder="BRD_XXXX"
              value={brandCode}
              onChange={(e) => setBrandCode(e.target.value.toUpperCase())}
              className="w-full bg-transparent p-3 text-center font-mono text-xl font-bold text-slate-900 outline-none placeholder:text-slate-300 uppercase tracking-widest"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !brandCode}
            className="w-full py-4 bg-purple-600 text-white rounded-2xl font-bold text-sm hover:bg-purple-700 transition-colors shadow-lg active:scale-95 disabled:opacity-50 disabled:scale-100 flex items-center justify-center gap-2"
          >
            <Send size={18} />
            Send Connection Request
          </button>

          {successMsg && (
            <div className="text-center text-xs font-bold text-green-700 bg-green-50 border border-green-100 rounded-2xl px-4 py-3">
              {successMsg}
            </div>
          )}
          {errorMsg && (
            <div className="text-center text-xs font-bold text-red-700 bg-red-50 border border-red-100 rounded-2xl px-4 py-3">
              {errorMsg}
            </div>
          )}
        </form>
      </div>
    </div>
  );
};

const PayoutsView = ({ payouts, loading, onRefresh }: any) => {
  const { toast } = useToast();
  const { confirm, ConfirmDialogElement } = useConfirm();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sheetsExporting, setSheetsExporting] = useState(false);

  const handleDelete = async (payoutId: string) => {
    const ok = await confirm({ message: 'Delete this payout record? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!ok) return;
    setDeletingId(payoutId);
    try {
      await api.ops.deletePayout(payoutId);
      toast.success('Payout deleted');
      onRefresh?.();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to delete payout'));
    } finally {
      setDeletingId(null);
    }
  };
  const totalPayouts = payouts.reduce((sum: number, p: any) => sum + p.amount, 0);

  const handleExport = () => {
    const headers = [
      'Transaction ID',
      'Date',
      'Time',
      'Beneficiary Name',
      'Beneficiary Code',
      'Amount (INR)',
      'Status',
    ];

    const csvRows = [headers.join(',')];

    payouts.forEach((p: any) => {
      const dateObj = new Date(p.date);
      const date = dateObj.toLocaleDateString('en-GB');
      const time = dateObj.toLocaleTimeString('en-GB');

      const row = [
        p.id,
        date,
        time,
        `"${(p.mediatorName || '').replace(/"/g, '""')}"`,
        p.mediatorCode,
        p.amount,
        p.status,
      ];
      csvRows.push(row.join(','));
    });

    const csvString = csvRows.join('\n');
    const blob = new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payout_ledger_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const handleExportPayoutsToSheets = () => {
    const payoutHeaders = ['Transaction ID','Date','Time','Beneficiary Name','Beneficiary Code','Amount (INR)','Status'];
    const payoutRows = payouts.map((p: any) => {
      const dateObj = new Date(p.date);
      return [
        p.id,
        dateObj.toLocaleDateString('en-GB'),
        dateObj.toLocaleTimeString('en-GB'),
        p.mediatorName || '',
        p.mediatorCode || '',
        p.amount,
        p.status || '',
      ] as (string | number)[];
    });
    exportToGoogleSheet({
      title: `Agency Payout Ledger - ${new Date().toISOString().slice(0, 10)}`,
      headers: payoutHeaders,
      rows: payoutRows,
      sheetName: 'Payouts',
      onStart: () => setSheetsExporting(true),
      onEnd: () => setSheetsExporting(false),
      onSuccess: () => toast.success('Exported to Google Sheets!'),
      onError: (msg) => toast.error(msg),
    });
  };

  return (
    <div className="space-y-6 animate-enter pb-12 h-full flex flex-col">
      {ConfirmDialogElement}
      <div className="bg-white rounded-[2rem] border border-slate-100 shadow-sm flex flex-col flex-1 overflow-hidden">
        <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-6 bg-slate-50/50">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-emerald-100 text-emerald-700 rounded-2xl shadow-inner">
              <Banknote size={24} />
            </div>
            <div>
              <h3 className="font-extrabold text-2xl text-slate-900">Payout Ledger</h3>
              <p className="text-xs text-slate-500 font-bold mt-1">
                History of transfers to mediators
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8 bg-white p-1.5 rounded-2xl border border-slate-100 shadow-sm">
            <div className="px-4 py-2 flex flex-col justify-center w-full sm:w-auto">
              <p className="text-[9px] font-extrabold text-slate-400 uppercase tracking-widest mb-0.5">
                Total Disbursed
              </p>
              <p className="text-lg font-black text-slate-900 leading-tight">
                {formatCurrency(totalPayouts)}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleExport}
              className="text-xs font-bold text-emerald-600 flex items-center gap-2 hover:bg-emerald-50 px-4 py-3 rounded-xl transition-colors border border-transparent hover:border-emerald-100"
            >
              <Download size={16} /> CSV
            </button>
            <button
              onClick={handleExportPayoutsToSheets}
              disabled={sheetsExporting}
              className="text-xs font-bold text-green-600 flex items-center gap-2 hover:bg-green-50 px-4 py-3 rounded-xl transition-colors border border-transparent hover:border-green-100 disabled:opacity-50"
            >
              <FileSpreadsheet size={16} /> {sheetsExporting ? 'Exporting...' : 'Google Sheets'}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-0 scrollbar-styled">
          {payouts.length === 0 ? (
            <div className="p-6">
              {loading ? (
                <EmptyState
                  title="Loading payouts"
                  description="Loading payout history."
                  icon={<Spinner className="w-5 h-5 text-slate-400" />}
                  className="bg-transparent"
                />
              ) : (
                <EmptyState
                  title="No payouts yet"
                  description="Recorded payouts to mediators will show up here."
                  icon={<Receipt size={22} className="text-slate-400" />}
                  className="bg-transparent"
                />
              )}
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50 text-slate-400 text-[10px] font-extrabold uppercase tracking-wider sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="p-5 pl-8">Transaction ID / Date</th>
                  <th className="p-5">Beneficiary (Mediator)</th>
                  <th className="p-5 text-right">Amount</th>
                  <th className="p-5 text-right">Status</th>
                  <th className="p-5 pr-8 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-sm">
                {payouts.map((p: any) => (
                  <tr key={p.id} className="hover:bg-slate-50/80 transition-colors group">
                    <td className="p-5 pl-8">
                      <div className="font-mono text-xs font-bold text-slate-900 group-hover:text-emerald-600 transition-colors">
                        {p.id}
                      </div>
                      <div className="text-[10px] text-slate-400 font-bold mt-0.5">
                        {new Date(p.date).toLocaleDateString('en-GB')}
                      </div>
                    </td>
                    <td className="p-5">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-black text-slate-500">
                          {p.mediatorName?.charAt(0)}
                        </div>
                        <div>
                          <div className="font-bold text-slate-900 text-sm mb-0.5">
                            {p.mediatorName}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {p.mediatorCode}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="p-5 text-right font-mono font-bold text-slate-900">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="p-5 pr-8 text-right">
                      <span
                        className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase border ${
                          p.status === 'Success'
                            ? 'bg-green-50 text-green-700 border-green-100'
                            : 'bg-amber-50 text-amber-700 border-amber-100'
                        }`}
                      >
                        {p.status === 'Success' ? (
                          <CheckCircle size={10} className="stroke-[3]" />
                        ) : (
                          <Clock size={10} className="stroke-[3]" />
                        )}
                        {p.status}
                      </span>
                    </td>
                    <td className="p-5 pr-8 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(p.id)}
                        disabled={deletingId === p.id}
                        className={`inline-flex items-center justify-center p-2 rounded-lg border transition-colors ${
                          deletingId === p.id
                            ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                            : 'bg-white text-rose-500 border-rose-100 hover:bg-rose-50'
                        }`}
                        title="Delete payout"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

const DashboardView = ({ stats, allOrders }: any) => {
  const [range, setRange] = useState<'last30' | 'yesterday' | 'last7' | 'thisMonth'>('last30');

  const data = useMemo(() => {
    const now = new Date();
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);

    let start = new Date(now);
    if (range === 'last7') {
      start.setDate(start.getDate() - 6);
    } else if (range === 'yesterday') {
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setTime(start.getTime());
      end.setHours(23, 59, 59, 999);
    } else if (range === 'thisMonth') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      start.setDate(start.getDate() - 29);
    }
    start.setHours(0, 0, 0, 0);

    const localKey = (d: Date) => {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    const buckets = new Map<string, number>();
    const cursor = new Date(start);
    while (cursor <= end) {
      buckets.set(localKey(cursor), 0);
      cursor.setDate(cursor.getDate() + 1);
    }

    (allOrders || []).forEach((o: any) => {
      const createdAt = new Date(o.createdAt);
      if (Number.isNaN(createdAt.getTime())) return;
      if (createdAt < start || createdAt > end) return;
      const key = localKey(createdAt);
      if (!buckets.has(key)) return;
      buckets.set(key, (buckets.get(key) || 0) + Number(o.total || 0));
    });

    return Array.from(buckets.entries()).map(([iso, total]) => ({
      name: new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
      val: Math.round(total),
    }));
  }, [allOrders, range]);

  // Calculate Brand Performance
  const brandData = useMemo(() => {
    const brandCounts: Record<string, number> = {};
    allOrders.forEach((o: Order) => {
      const brand = o.brandName || 'Unknown';
      brandCounts[brand] = (brandCounts[brand] || 0) + 1;
    });
    return Object.keys(brandCounts)
      .map((b) => ({ name: b, count: brandCounts[b] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [allOrders]);

  return (
    <div className="space-y-6 animate-enter pb-12">
      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard
          label="Total Revenue"
          value={formatCurrency(stats.revenue)}
          icon={IndianRupee}
        />
        <StatCard label="Active Squad" value={stats.totalMediators} icon={Users} />
        <StatCard label="Live Campaigns" value={stats.activeCampaigns} icon={Layers} />
        <StatCard
          label="Orders Today"
          value={
            allOrders.filter(
              (o: any) => new Date(o.createdAt).toDateString() === new Date().toDateString()
            ).length
          }
          icon={Box}
        />
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Revenue Chart */}
        <div className="lg:col-span-2 bg-white p-6 rounded-[1.5rem] border border-slate-100 shadow-sm flex flex-col h-[400px]">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h3 className="text-lg font-bold text-slate-900">Revenue Trends</h3>
              <p className="text-xs text-slate-400 font-medium">
                {range === 'yesterday'
                  ? 'Performance for yesterday'
                  : range === 'last7'
                    ? 'Performance over last 7 days'
                    : range === 'thisMonth'
                      ? 'Performance over this month'
                      : 'Performance over last 30 days'}
              </p>
            </div>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as any)}
              aria-label="Date range"
              className="bg-slate-50 border border-slate-200 text-xs font-bold text-slate-600 rounded-lg px-3 py-2 outline-none hover:bg-slate-100 transition-colors cursor-pointer"
            >
              <option value="last30">Last 30 Days</option>
              <option value="yesterday">Yesterday</option>
              <option value="last7">Last 7 Days</option>
              <option value="thisMonth">This Month</option>
            </select>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ChartSuspense>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#94a3b8', fontWeight: 600 }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: '#94a3b8', fontWeight: 600 }}
                  tickFormatter={(v: number) => `${v / 1000}k`}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: '12px',
                    border: 'none',
                    boxShadow: '0 10px 30px -5px rgba(0,0,0,0.1)',
                    padding: '12px 16px',
                  }}
                  itemStyle={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}
                  cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area
                  type="monotone"
                  dataKey="val"
                  stroke="#a855f7"
                  strokeWidth={3}
                  fillOpacity={1}
                  fill="url(#colorVal)"
                />
              </AreaChart>
            </ResponsiveContainer>
            </ChartSuspense>
          </div>
        </div>

        {/* Brand Mix */}
        <div className="bg-white p-6 rounded-[1.5rem] border border-slate-100 shadow-sm flex flex-col h-[400px]">
          <h3 className="text-lg font-bold text-slate-900 mb-1">Brand Performance</h3>
          <p className="text-xs text-slate-400 font-medium mb-6">Top performing brands by volume</p>
          <div className="flex-1 min-h-0">
            <ChartSuspense>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={brandData} layout="vertical" barSize={24}>
                <XAxis type="number" hide />
                <YAxis
                  dataKey="name"
                  type="category"
                  width={90}
                  tick={{ fontSize: 11, fontWeight: 600, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: '#f8fafc' }}
                  contentStyle={{
                    borderRadius: '12px',
                    border: 'none',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                  }}
                />
                <Bar dataKey="count" fill="#a855f7" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            </ChartSuspense>
          </div>
        </div>
      </div>
    </div>
  );
};

const InventoryView = ({ campaigns, user, loading, onRefresh, mediators, allOrders }: any) => {
  const { toast } = useToast();
  const { confirm, ConfirmDialogElement: InventoryConfirmDialog } = useConfirm();
  const [subTab, setSubTab] = useState<'inventory' | 'offered'>('inventory');
  const [assignModal, setAssignModal] = useState<Campaign | null>(null);
  const [createModal, setCreateModal] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [inventorySearch, setInventorySearch] = useState('');
  const [filterDealType, setFilterDealType] = useState<string>('All');
  const [filterBrand, setFilterBrand] = useState<string>('All');
  const [filterDateFrom, setFilterDateFrom] = useState<string>('');
  const [filterDateTo, setFilterDateTo] = useState<string>('');
  const [assignSearch, setAssignSearch] = useState('');
  const [selectedDealType, setSelectedDealType] = useState<string>('Discount');
  const [customPrice, setCustomPrice] = useState<string>('');
  const [customPayout, setCustomPayout] = useState<string>('');
  const [commissionOnDeal, setCommissionOnDeal] = useState<string>('');
  const [commissionToMediator, setCommissionToMediator] = useState<string>('');
  const [mediatorPayouts, setMediatorPayouts] = useState<Record<string, string>>({});
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);

  useEffect(() => {
    if (!assignModal) return;
    // Normalize existing assignments: DB stores either number or {limit, payout} objects
    const raw = assignModal.assignments || {};
    const normalized: Record<string, number> = {};
    for (const [code, val] of Object.entries(raw)) {
      normalized[code] = typeof val === 'number' ? val : Number((val as any)?.limit ?? 0);
    }
    setAssignments(normalized);
    setAssignSearch('');
    setMediatorPayouts({});
  }, [assignModal]);

  // Get list of mediator codes for this agency to verify if campaign is active in network
  const myMediatorCodes = useMemo(
    () => mediators.map((m: any) => m.mediatorCode).filter(Boolean),
    [mediators]
  );

  // Helper: apply search + filters to a campaign list
  const applyFilters = (list: Campaign[]) => {
    let result = list;
    if (inventorySearch.trim()) {
      const q = inventorySearch.trim().toLowerCase();
      result = result.filter((c: Campaign) =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.platform || '').toLowerCase().includes(q) ||
        (c.brand || '').toLowerCase().includes(q)
      );
    }
    if (filterDealType !== 'All') {
      result = result.filter((c: Campaign) => (c.dealType || 'Discount') === filterDealType);
    }
    if (filterBrand !== 'All') {
      result = result.filter((c: Campaign) => (c.brand || '') === filterBrand);
    }
    if (filterDateFrom) {
      const from = new Date(filterDateFrom).getTime();
      result = result.filter((c: Campaign) => (c.createdAt || 0) >= from);
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo).getTime() + 86400000; // end of day
      result = result.filter((c: Campaign) => (c.createdAt || 0) < to);
    }
    return result;
  };

  // Unique brand names across all campaigns for filter dropdown
  const brandOptions = useMemo(() => {
    const brands = new Set<string>();
    campaigns.forEach((c: Campaign) => { if (c.brand) brands.add(c.brand); });
    return Array.from(brands).sort();
  }, [campaigns]);

  // Active Inventory = what agency is already managing (at least one sub-mediator has assignments)
  const activeInventory = useMemo(() => {
    const base = campaigns.filter(
      (c: Campaign) =>
        c.allowedAgencies.includes(user.mediatorCode) &&
        (c.status === 'Draft' || Object.keys(c.assignments || {}).some((code) => myMediatorCodes.includes(code)))
    );
    return applyFilters(base);
  }, [campaigns, user.mediatorCode, myMediatorCodes, inventorySearch, filterDealType, filterBrand, filterDateFrom, filterDateTo]);

  // Filter campaigns for "Offered by Brands" (where agency is allowed but no sub-mediators have slots yet)
  const offeredCampaigns = useMemo(() => {
    const base = campaigns.filter(
      (c: Campaign) =>
        c.allowedAgencies.includes(user.mediatorCode) &&
        c.status !== 'Draft' &&
        !Object.keys(c.assignments || {}).some((code) => myMediatorCodes.includes(code))
    );
    return applyFilters(base);
  }, [campaigns, user.mediatorCode, myMediatorCodes, inventorySearch, filterDealType, filterBrand, filterDateFrom, filterDateTo]);

  // New Campaign Form
  const [newCampaign, setNewCampaign] = useState({
    title: '',
    platform: '',
    dealType: 'Discount',
    price: '',
    payout: '0',
    totalSlots: '',
    originalPrice: '',
    image: '',
    productUrl: '',
    brandName: '',
  });

  const handleAssign = async () => {
    if (!assignModal) return;
    const positiveAssignments = Object.fromEntries(
      Object.entries(assignments || {}).filter(([, v]) => Number(v) > 0)
    );
    if (Object.keys(positiveAssignments).length === 0) {
      toast.error('Please allocate at least 1 unit to someone');
      return;
    }
    if (assignedTotal > availableForAssign) {
      toast.error('Total assigned exceeds available stock');
      return;
    }

    const isInternal = String(assignModal.brandId || '') === String(user?.id || '');
    const globalMediatorPayout = commissionToMediator.trim() ? Number(commissionToMediator) : 0;
    const commission = isInternal ? 0 : commissionOnDeal.trim() ? Number(commissionOnDeal) : 0;
    if (!Number.isFinite(globalMediatorPayout) || globalMediatorPayout < 0) {
      toast.error('Commission to mediator must be 0 or more');
      return;
    }
    if (!isInternal && (!Number.isFinite(commission) || commission < 0)) {
      toast.error('Commission on deal must be 0 or more');
      return;
    }
    const dealType = selectedDealType !== (assignModal.dealType || 'Discount') ? selectedDealType : undefined;

    // Build per-mediator rich assignments with individual payout overrides
    const richAssignments: Record<string, { limit: number; payout: number }> = {};
    for (const [code, count] of Object.entries(positiveAssignments)) {
      const perMediatorPayout = mediatorPayouts[code]?.trim()
        ? Number(mediatorPayouts[code])
        : globalMediatorPayout;
      if (!Number.isFinite(perMediatorPayout) || perMediatorPayout < 0) {
        toast.error(`Invalid commission for mediator ${code}`);
        return;
      }
      richAssignments[code] = { limit: Number(count), payout: perMediatorPayout };
    }

    try {
      // Send rich assignments with per-mediator payout, plus commission on deal
      await api.ops.assignSlots(assignModal.id, richAssignments, dealType, undefined, undefined, commission);
      toast.success('Distribution saved');
      setAssignModal(null);
      setAssignments({});
      setMediatorPayouts({});
      onRefresh();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to distribute inventory'));
    }
  };

  const handleCreate = async () => {
    const title = newCampaign.title.trim();
    const productUrl = newCampaign.productUrl.trim();
    const image = newCampaign.image.trim();
    const price = Number(newCampaign.price);
    const payout = 0;
    const totalSlots = Number(newCampaign.totalSlots);
    const originalPrice = Number(newCampaign.originalPrice);

    if (!title) {
      toast.error('Title is required');
      return;
    }
    if (!productUrl) {
      toast.error('Product URL is required');
      return;
    }
    if (!image) {
      toast.error('Image URL is required');
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      toast.error('Deal price must be 0 or more');
      return;
    }
    if (!Number.isFinite(originalPrice) || originalPrice < 0) {
      toast.error('Original price is required');
      return;
    }
    if (!Number.isFinite(totalSlots) || totalSlots < 0) {
      toast.error('Total slots must be 0 or more');
      return;
    }

    try {
      await api.ops.createCampaign({
        ...newCampaign,
        title,
        productUrl,
        image,
        price,
        payout,
        totalSlots,
        originalPrice,
        dealType: newCampaign.dealType as any,
        allowedAgencies: [user.mediatorCode],
        brandName: newCampaign.brandName.trim() || undefined,
      });
      toast.success('Campaign created');
      setCreateModal(false);
      setNewCampaign({
        title: '',
        platform: '',
        dealType: 'Discount',
        price: '',
        payout: '0',
        totalSlots: '',
        originalPrice: '',
        image: '',
        productUrl: '',
        brandName: '',
      });
      onRefresh();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to create campaign'));
    }
  };

  const handleDistributeEvenly = () => {
    if (!assignModal || mediators.length === 0) return;

    const active = mediators.filter((m: User) => m.status === 'active' && !!m.mediatorCode);
    if (active.length === 0) {
      toast.error('No active mediators available');
      return;
    }

    const available = assignModal.totalSlots - assignModal.usedSlots;
    if (available <= 0) return;

    const count = active.length;
    const perUser = Math.floor(available / count);
    const remainder = available % count;

    const newAssignments: Record<string, number> = {};
    active.forEach((m: User, index: number) => {
      let amount = perUser;
      if (index < remainder) amount += 1;
      newAssignments[m.mediatorCode!] = amount;
    });
    setAssignments(newAssignments);
    // Reset per-mediator overrides so everyone uses the global commission
    setMediatorPayouts({});
  };

  const handleClaimOffered = (c: Campaign) => {
    setSelectedDealType(c.dealType || 'Discount');
    setCustomPrice(c.price.toString());
    setCustomPayout(c.payout.toString());
    // Pre-fill commission & payout from previously saved assignment values.
    const details = (c as any).assignmentDetails || {};
    const detailValues = Object.values(details) as Array<{ limit: number; payout: number; commission: number }>;
    const savedComm = detailValues.find((d) => typeof d?.commission === 'number' && d.commission > 0);
    setCommissionOnDeal(savedComm ? String(savedComm.commission) : '0');
    const savedPayout = detailValues.find((d) => typeof d?.payout === 'number' && d.payout > 0);
    setCommissionToMediator(savedPayout ? String(savedPayout.payout) : c.payout.toString());
    setAssignModal(c);
  };

  const handleToggleStatus = async (campaign: Campaign) => {
    const current = String(campaign.status || '').toLowerCase();
    const next = current === 'active' ? 'paused' : 'active';
    if (!['active', 'paused'].includes(next)) {
      toast.error('Only active or paused campaigns can be updated');
      return;
    }
    setStatusUpdatingId(campaign.id);
    try {
      await api.ops.updateCampaignStatus(campaign.id, next);
      toast.success(next === 'paused' ? 'Campaign paused' : 'Campaign resumed');
      onRefresh();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to update campaign status'));
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const handleDelete = async (campaign: Campaign) => {
    const isOwner = String(campaign.brandId || '') === String(user?.id || '');
    if (!isOwner) return;
    const confirmed = await confirm({ message: 'Delete this campaign? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!confirmed) return;
    setDeletingId(campaign.id);
    try {
      await api.ops.deleteCampaign(campaign.id);
      toast.success('Campaign deleted');
      onRefresh();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to delete campaign'));
    } finally {
      setDeletingId(null);
    }
  };

  const activeMediatorsForAssign = useMemo(() => {
    const q = assignSearch.trim().toLowerCase();
    const all = (mediators as User[]).filter((m: User) => !!m.mediatorCode);
    if (!q) return all;
    return all.filter(
      (m: User) =>
        m.name.toLowerCase().includes(q) ||
        String(m.mediatorCode || '').toLowerCase().includes(q)
    );
  }, [mediators, assignSearch]);

  const assignedTotal = useMemo(() => {
    return Object.values(assignments || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }, [assignments]);

  const availableForAssign = useMemo(() => {
    if (!assignModal) return 0;
    return Math.max(0, assignModal.totalSlots - assignModal.usedSlots);
  }, [assignModal]);

  const remainingForAssign = useMemo(() => {
    return Math.max(0, availableForAssign - assignedTotal);
  }, [availableForAssign, assignedTotal]);

  const isAgencyCampaign =
    !!assignModal && String(assignModal.brandId || '') === String(user?.id || '');

  return (
    <div className="space-y-6 animate-enter h-full flex flex-col">
      {InventoryConfirmDialog}
      {/* Header Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-4 rounded-[1.5rem] border border-slate-100 shadow-sm gap-4">
        <div>
          <h3 className="font-extrabold text-lg text-slate-900">Inventory Manager</h3>
          <p className="text-xs text-slate-500 font-medium">
            Manage and distribute your deal stock
          </p>
        </div>

        {/* Sub Tab Switcher */}
        <div className="flex bg-slate-50 p-1.5 rounded-2xl border border-slate-100 shadow-inner">
          <button
            onClick={() => setSubTab('inventory')}
            className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${subTab === 'inventory' ? 'bg-white text-purple-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <Layers size={14} /> Active Inventory
          </button>
          <button
            onClick={() => setSubTab('offered')}
            className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${subTab === 'offered' ? 'bg-white text-purple-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <Gift size={14} /> Offered by Brands{' '}
            {offeredCampaigns.length > 0 && (
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"></span>
            )}
          </button>
        </div>

        <button
          onClick={() => setCreateModal(true)}
          className="px-5 py-3 bg-slate-900 text-white rounded-xl font-bold text-xs flex items-center gap-2 hover:bg-black shadow-lg shadow-black/10 active:scale-95 transition-transform"
        >
          <Plus size={16} /> <span>Add Campaign</span>
        </button>
      </div>

      {/* Inventory Search + Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <div className="flex-1 min-w-[180px] relative">
          <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={inventorySearch}
            onChange={(e) => setInventorySearch(e.target.value)}
            placeholder="Search campaigns..."
            className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 bg-white text-sm font-medium focus:border-purple-300 focus:ring-2 focus:ring-purple-100 outline-none"
          />
        </div>
        <select
          value={filterDealType}
          onChange={(e) => setFilterDealType(e.target.value)}
          aria-label="Filter by deal type"
          className="px-3 py-3 rounded-xl border border-slate-200 text-xs font-bold bg-white"
        >
          <option value="Discount">Discount</option>
          <option value="Review">Review</option>
          <option value="Rating">Rating</option>
        </select>
        <select
          value={filterBrand}
          onChange={(e) => setFilterBrand(e.target.value)}
          aria-label="Filter by brand"
          className="px-3 py-3 rounded-xl border border-slate-200 text-xs font-bold bg-white"
        >
          {brandOptions.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <input
          type="date"
          value={filterDateFrom}
          onChange={(e) => setFilterDateFrom(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-slate-200 text-xs font-bold bg-white"
          title="From date"
        />
        <input
          type="date"
          value={filterDateTo}
          onChange={(e) => setFilterDateTo(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-slate-200 text-xs font-bold bg-white"
          title="To date"
        />
        {(filterDealType !== 'All' || filterBrand !== 'All' || filterDateFrom || filterDateTo) && (
          <button
            onClick={() => { setFilterDealType('All'); setFilterBrand('All'); setFilterDateFrom(''); setFilterDateTo(''); }}
            className="px-3 py-2.5 rounded-xl border border-red-200 text-xs font-bold text-red-500 bg-red-50 hover:bg-red-100 transition-colors"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Content Area */}
      <div className="bg-white rounded-[2rem] border border-slate-100 overflow-hidden shadow-sm flex-1">
        <div className="overflow-x-auto h-full scrollbar-styled">
          {subTab === 'inventory' ? (
            <table className="w-full text-left">
              <thead className="bg-slate-50 text-slate-400 text-[10px] font-extrabold uppercase tracking-wider sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="p-5 pl-8 whitespace-nowrap">Campaign Name</th>
                  <th className="p-5 whitespace-nowrap">Brand</th>
                  <th className="p-5 whitespace-nowrap">Platform</th>
                  <th className="p-5 whitespace-nowrap">Deal Type</th>
                  <th className="p-5 text-center whitespace-nowrap">Status</th>
                  <th className="p-5 whitespace-nowrap">Created</th>
                  <th className="p-5 text-right whitespace-nowrap">Units</th>
                  <th className="p-5 pr-8 text-center whitespace-nowrap">Distribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-sm">
                {activeInventory.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8">
                      {loading ? (
                        <EmptyState
                          title="Loading inventory"
                          description="Fetching campaigns and assignments."
                          icon={<Spinner className="w-5 h-5 text-slate-400" />}
                          className="bg-transparent"
                        />
                      ) : (
                        <EmptyState
                          title="No active inventory"
                          description="Claim deals from brands to start managing inventory."
                          icon={<Layers size={22} className="text-slate-400" />}
                          className="bg-transparent"
                        />
                      )}
                    </td>
                  </tr>
                ) : (
                  activeInventory.map((c: Campaign) => (
                    <tr key={c.id} className="hover:bg-slate-50/50 transition-colors group">
                      <td className="p-5 pl-8">
                        <div className="flex items-center gap-4">
                          <ProxiedImage
                            src={c.image}
                            alt={c.title || 'Campaign'}
                            className="w-10 h-10 object-contain rounded-lg bg-slate-50 border border-slate-100 p-1 group-hover:scale-105 transition-transform"
                          />
                          <div>
                            <span className="font-bold text-slate-900 truncate max-w-[200px] block">
                              {c.title}
                            </span>
                            <span
                              className="text-[9px] text-slate-400 font-mono cursor-pointer hover:text-purple-600 transition-colors"
                              title="Click to copy Campaign ID"
                              onClick={() => {
                                navigator.clipboard.writeText(String(c.id));
                                toast.success('Campaign ID copied');
                              }}
                            >
                              ID: {String(c.id).slice(-8)}
                            </span>
                          </div>
                          {String(c.brandId || '') === String(user.id || '') && (
                            <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                              Agency Campaign
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-5">
                        <span className="text-xs font-bold text-indigo-700 truncate max-w-[120px] block">
                          {c.brand || '—'}
                        </span>
                      </td>
                      <td className="p-5">
                        <span className="text-[10px] font-bold text-slate-500 uppercase bg-slate-100 px-2 py-1 rounded border border-slate-200">
                          {c.platform}
                        </span>
                      </td>
                      <td className="p-5">
                        <span
                          className={`px-2 py-1 rounded text-[9px] font-bold uppercase border ${
                            c.dealType === 'Review'
                              ? 'bg-purple-50 text-purple-700 border-purple-100'
                              : c.dealType === 'Rating'
                                ? 'bg-orange-50 text-orange-700 border-orange-100'
                                : 'bg-blue-50 text-blue-700 border-blue-100'
                          }`}
                        >
                          {c.dealType || 'Discount'}
                        </span>
                      </td>
                      <td className="p-5 text-center">
                        <span
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase border shadow-sm ${c.status === 'Active' ? 'bg-green-50 text-green-600 border-green-100' : 'bg-slate-100 text-slate-500 border-slate-200'}`}
                        >
                          {c.status}
                        </span>
                      </td>
                      <td className="p-5">
                        <span className="text-[10px] font-medium text-slate-500">
                          {c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-GB') : '—'}
                        </span>
                      </td>
                      <td className="p-5 text-right font-mono text-slate-700 font-bold">
                        <span className="text-slate-400 mr-1">SOLD:</span> {c.usedSlots}{' '}
                        <span className="text-slate-300 mx-1">/</span> {c.totalSlots}
                      </td>
                      <td className="p-5 pr-8 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <button
                            onClick={() => {
                              setAssignModal(c);
                              setSelectedDealType(c.dealType || 'Discount');
                              setCustomPrice(c.price.toString());
                              setCustomPayout(c.payout.toString());
                              // Pre-fill commission & payout from previously saved assignment values.
                              const details = (c as any).assignmentDetails || {};
                              const detailValues = Object.values(details) as Array<{ limit: number; payout: number; commission: number }>;
                              const savedComm = detailValues.find((d) => typeof d?.commission === 'number' && d.commission > 0);
                              setCommissionOnDeal(savedComm ? String(savedComm.commission) : '0');
                              const savedPayout = detailValues.find((d) => typeof d?.payout === 'number' && d.payout > 0);
                              setCommissionToMediator(savedPayout ? String(savedPayout.payout) : c.payout.toString());
                              // Pre-fill per-mediator commission overrides from saved assignments
                              const perMediatorOverrides: Record<string, string> = {};
                              for (const [code, detail] of Object.entries(details)) {
                                if (detail && typeof (detail as any).payout === 'number') {
                                  perMediatorOverrides[code] = String((detail as any).payout);
                                }
                              }
                              setMediatorPayouts(perMediatorOverrides);
                            }}
                            className="px-4 py-2 bg-white border border-slate-200 text-slate-700 text-xs font-bold rounded-xl hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-all flex items-center gap-2 mx-auto shadow-sm active:scale-95"
                          >
                            <Users size={14} /> Manage Slots
                          </button>
                          {(c.status === 'Active' || c.status === 'Paused') && (
                            <button
                              onClick={() => handleToggleStatus(c)}
                              disabled={statusUpdatingId === c.id}
                              className={`px-4 py-2 text-xs font-bold rounded-xl border transition-all flex items-center gap-2 mx-auto shadow-sm active:scale-95 ${
                                c.status === 'Active'
                                  ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                                  : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                              } ${statusUpdatingId === c.id ? 'opacity-60 cursor-not-allowed' : ''}`}
                            >
                              {statusUpdatingId === c.id
                                ? 'Updating...'
                                : c.status === 'Active'
                                  ? 'Pause Campaign'
                                  : 'Resume Campaign'}
                            </button>
                          )}
                          {String(c.brandId || '') === String(user.id || '') && (
                            <button
                              onClick={() => handleDelete(c)}
                              disabled={deletingId === c.id}
                              className={`px-4 py-2 text-xs font-bold rounded-xl border transition-all flex items-center gap-2 mx-auto shadow-sm active:scale-95 bg-red-50 text-red-600 border-red-200 hover:bg-red-100 ${
                                deletingId === c.id ? 'opacity-60 cursor-not-allowed' : ''
                              }`}
                            >
                              {deletingId === c.id ? 'Deleting...' : 'Delete Campaign'}
                            </button>
                          )}
                          <button
                            onClick={async () => {
                              setCopyingId(c.id);
                              try {
                                const res = await api.ops.copyCampaign(c.id);
                                if (res.ok) {
                                  toast.success('Campaign copied as Draft — see Active Inventory');
                                  await onRefresh();
                                  setSubTab('inventory');
                                } else {
                                  toast.error((res as any).error || 'Copy failed');
                                }
                              } catch (err) {
                                toast.error(formatErrorMessage(err, 'Copy failed'));
                              } finally {
                                setCopyingId(null);
                              }
                            }}
                            disabled={copyingId === c.id}
                            className={`px-4 py-2 text-xs font-bold rounded-xl border transition-all flex items-center gap-2 mx-auto shadow-sm active:scale-95 bg-sky-50 text-sky-600 border-sky-200 hover:bg-sky-100 ${
                              copyingId === c.id ? 'opacity-60 cursor-not-allowed' : ''
                            }`}
                          >
                            <Copy className="w-3.5 h-3.5" />
                            {copyingId === c.id ? 'Copying...' : 'Copy Campaign'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-enter">
              {offeredCampaigns.length === 0 ? (
                <div className="col-span-full">
                  {loading ? (
                    <EmptyState
                      title="Loading offers"
                      description="Checking brand campaigns shared with your agency."
                      icon={<Spinner className="w-5 h-5 text-slate-400" />}
                      className="bg-slate-50 border-slate-200 rounded-[2.5rem] py-20"
                    />
                  ) : (
                    <EmptyState
                      title="No new offers"
                      description="Brands haven't shared any campaigns with you recently."
                      icon={<Gift size={22} className="text-slate-400" />}
                      className="bg-slate-50 border-slate-200 rounded-[2.5rem] py-20"
                    />
                  )}
                </div>
              ) : (
                offeredCampaigns.map((c: Campaign) => (
                  <div
                    key={c.id}
                    className="bg-white rounded-3xl border border-slate-100 shadow-sm p-5 hover:shadow-xl transition-all group flex flex-col"
                  >
                    <div className="flex gap-4 mb-5">
                      <div className="w-20 h-20 bg-slate-50 rounded-2xl p-2 border border-slate-100 flex-shrink-0 flex items-center justify-center">
                        <ProxiedImage
                          src={c.image}
                          alt={c.title || 'Campaign'}
                          className="w-full h-full object-contain mix-blend-multiply group-hover:scale-110 transition-transform"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-1">
                          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                            {c.platform}
                          </span>
                          <span className="text-[9px] font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full border border-purple-100">
                            {c.dealType || 'Discount'}
                          </span>
                        </div>
                        <h4 className="font-bold text-slate-900 text-sm leading-tight line-clamp-2 mb-2">
                          {c.title}
                        </h4>
                        <p className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                          Offered by <span className="text-indigo-600">"{c.brand}"</span>
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                      <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                        <p className="text-[9px] font-bold text-slate-400 uppercase mb-0.5">
                          Budget
                        </p>
                        <p className="text-sm font-black text-slate-900">{c.payout}/unit</p>
                      </div>
                      <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                        <p className="text-[9px] font-bold text-slate-400 uppercase mb-0.5">
                          Availability
                        </p>
                        <p className="text-sm font-black text-slate-900">{c.totalSlots} Slots</p>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-auto">
                      <button
                        onClick={() => handleClaimOffered(c)}
                        className="flex-1 py-3.5 bg-slate-900 text-white rounded-2xl font-bold text-xs flex items-center justify-center gap-2 hover:bg-purple-600 transition-all shadow-lg active:scale-95"
                      >
                        <BookmarkPlus size={16} /> Add to Network
                      </button>
                      <button
                        onClick={async () => {
                          const confirmed = await confirm({ message: `Decline this offer from "${c.brand}"? This cannot be undone.`, confirmLabel: 'Decline', variant: 'destructive' });
                          if (!confirmed) return;
                          setDecliningId(c.id);
                          try {
                            await api.ops.declineOffer(c.id);
                            toast.success('Offer declined');
                            onRefresh();
                          } catch (err) {
                            toast.error(formatErrorMessage(err, 'Failed to decline offer'));
                          } finally {
                            setDecliningId(null);
                          }
                        }}
                        disabled={decliningId === c.id}
                        className={`px-4 py-3.5 bg-red-50 text-red-600 border border-red-200 rounded-2xl font-bold text-xs flex items-center justify-center gap-1 hover:bg-red-100 transition-all active:scale-95 ${
                          decliningId === c.id ? 'opacity-60 cursor-not-allowed' : ''
                        }`}
                        title="Decline this offer"
                      >
                        {decliningId === c.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* CREATE CAMPAIGN MODAL */}
      {createModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => setCreateModal(false)}
        >
          <div
            className="bg-white w-[95%] md:w-full max-w-lg rounded-[2rem] p-8 shadow-2xl relative max-h-[90vh] overflow-y-auto scrollbar-styled animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-black text-slate-900">New Campaign</h3>
              <button
                aria-label="Close new campaign modal"
                onClick={() => setCreateModal(false)}
                className="p-2 bg-slate-50 rounded-full hover:bg-slate-100 transition-colors"
              >
                <X size={20} className="text-slate-500" />
              </button>
            </div>

            <div className="space-y-5">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">Title</label>
                <input
                  type="text"
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                  value={newCampaign.title}
                  onChange={(e) => setNewCampaign({ ...newCampaign, title: e.target.value })}
                  placeholder="Product Title"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">Brand Name</label>
                <input
                  type="text"
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                  value={newCampaign.brandName}
                  onChange={(e) => setNewCampaign({ ...newCampaign, brandName: e.target.value })}
                  placeholder="e.g. Samsung, Nike"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                    Platform
                  </label>
                  <input
                    type="text"
                    className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                    value={newCampaign.platform}
                    onChange={(e) => setNewCampaign({ ...newCampaign, platform: e.target.value })}
                    placeholder="e.g. Amazon"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                    Total Units
                  </label>
                  <input
                    type="number"
                    className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                    value={newCampaign.totalSlots}
                    onChange={(e) => setNewCampaign({ ...newCampaign, totalSlots: e.target.value })}
                    placeholder="100"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                  Deal Type
                </label>
                <div className="relative">
                  <select
                    className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all appearance-none"
                    value={newCampaign.dealType}
                    onChange={(e) => setNewCampaign({ ...newCampaign, dealType: e.target.value })}
                    aria-label="Deal type"
                  >
                    <option value="Discount">Order Deal</option>
                    <option value="Review">Review Deal</option>
                    <option value="Rating">Rating Deal</option>
                    
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                    <ChevronRight className="rotate-90" size={16} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                    Product Price (₹)
                  </label>
                  <input
                    type="number"
                    className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                    value={newCampaign.originalPrice}
                    onChange={(e) => setNewCampaign({ ...newCampaign, originalPrice: e.target.value })}
                    placeholder="2000"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                    Deal Price (₹)
                  </label>
                  <input
                    type="number"
                    className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                    value={newCampaign.price}
                    onChange={(e) => setNewCampaign({ ...newCampaign, price: e.target.value })}
                    placeholder="1000"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                  Image URL
                </label>
                <input
                  type="text"
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                  value={newCampaign.image}
                  onChange={(e) => setNewCampaign({ ...newCampaign, image: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                  Product Link
                </label>
                <input
                  type="text"
                  className="w-full p-4 bg-slate-50 border border-slate-100 rounded-2xl font-bold text-sm outline-none focus:border-purple-200 focus:bg-white focus:ring-4 focus:ring-purple-50 transition-all"
                  value={newCampaign.productUrl}
                  onChange={(e) => setNewCampaign({ ...newCampaign, productUrl: e.target.value })}
                  placeholder="https://amazon.in/..."
                />
              </div>
            </div>

            <button
              onClick={handleCreate}
              className="w-full mt-8 py-4 bg-slate-900 text-white rounded-2xl font-bold text-sm hover:bg-black shadow-xl hover:shadow-2xl transition-all active:scale-95"
            >
              Launch Campaign
            </button>
          </div>
        </div>
      )}

      {/* ASSIGN MODAL */}
      {assignModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-fade-in"
          onClick={() => setAssignModal(null)}
        >
          <div
            className="bg-white w-[98%] md:w-full max-w-7xl rounded-2xl p-4 sm:p-5 lg:p-6 2xl:p-7 shadow-2xl relative h-[95vh] flex flex-col min-h-0 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex justify-between items-start gap-4 mb-2 shrink-0">
              <div>
                <h3 className="text-xl 2xl:text-2xl font-black text-slate-900 tracking-tight">
                  Distribute Inventory
                </h3>
                <p className="text-[11px] sm:text-xs text-slate-500 font-bold mt-0.5">
                  Allocate campaign slots to your team.
                </p>
              </div>
              <button
                aria-label="Close distribution modal"
                onClick={() => setAssignModal(null)}
                className="p-2.5 bg-slate-50 rounded-full hover:bg-slate-100 transition-colors shrink-0"
              >
                <X size={20} className="text-slate-500" />
              </button>
            </div>

            {/* Campaign Summary & Global Config */}
            <div className="bg-slate-50 p-3 2xl:p-4 rounded-2xl mb-2 border border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shrink-0">
              <div className="flex gap-3 items-center min-w-0">
                <div className="w-10 h-10 bg-white rounded-lg p-1.5 border border-slate-200 shadow-sm flex-shrink-0">
                  <ProxiedImage
                    src={assignModal.image}
                    alt={assignModal.title || 'Campaign'}
                    className="w-full h-full object-contain mix-blend-multiply"
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-slate-400 font-extrabold mb-1 uppercase tracking-widest">
                    Selected Campaign
                  </p>
                  <h4 className="text-sm sm:text-base font-black text-slate-900 mb-0.5 leading-tight line-clamp-1">
                    {assignModal.title}
                  </h4>
                  <span
                    className="text-[9px] text-slate-400 font-mono cursor-pointer hover:text-purple-600 transition-colors"
                    title="Click to copy Campaign ID"
                    onClick={() => {
                      navigator.clipboard.writeText(String(assignModal.id));
                      toast.success('Campaign ID copied');
                    }}
                  >
                    ID: {String(assignModal.id).slice(-8)}
                  </span>
                  {isAgencyCampaign && (
                    <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
                      Agency Campaign
                    </span>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-bold text-slate-500 bg-white px-2 py-1 rounded-lg border border-slate-200 shadow-sm">
                      Total Stock: {assignModal.totalSlots}
                    </span>
                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-100 shadow-sm">
                      Available: {assignModal.totalSlots - assignModal.usedSlots}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-1 rounded-lg border shadow-sm ${
                        assignedTotal > availableForAssign
                          ? 'text-red-600 bg-red-50 border-red-100'
                          : 'text-purple-600 bg-purple-50 border-purple-100'
                      }`}
                    >
                      Assigned: {assignedTotal}
                    </span>
                    <span className="text-[10px] font-bold text-slate-600 bg-white px-2 py-1 rounded-lg border border-slate-200 shadow-sm">
                      Remaining: {remainingForAssign}
                    </span>
                  </div>
                </div>
              </div>

              {/* CONFIG OPTIONS: Deal Type, Price, Payout */}
              <div className="flex flex-wrap gap-x-3 gap-y-2 items-end">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest ml-1">
                    Configure Deal Type
                  </label>
                  <div className="flex bg-white p-1 rounded-xl border border-slate-200 shadow-sm h-9">
                    {['Discount', 'Review', 'Rating'].map((type) => (
                      <button
                        key={type}
                        onClick={() => setSelectedDealType(type)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-black transition-all uppercase whitespace-nowrap ${selectedDealType === type ? 'bg-purple-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest ml-1">
                        Deal Price (₹)
                      </label>
                      <div className="bg-slate-50 border border-slate-200 rounded-lg shadow-sm h-8 px-2 flex items-center">
                        <span className="text-xs font-bold text-slate-400 mr-2"></span>
                        <input
                          type="number"
                          value={customPrice}
                          readOnly
                          aria-readonly="true"
                          tabIndex={-1}
                          className="w-12 bg-transparent text-[11px] font-bold text-slate-600 outline-none cursor-not-allowed"
                          placeholder="0"
                        />
                      </div>
                    </div>

                    {!isAgencyCampaign && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest ml-1">
                          Commission from Brand (₹)
                        </label>
                        <div className="bg-slate-50 border border-slate-200 rounded-lg shadow-sm h-8 px-2 flex items-center">
                          <span className="text-xs font-bold text-slate-400 mr-2"></span>
                          <input
                            type="number"
                            value={customPayout}
                            readOnly
                            aria-readonly="true"
                            tabIndex={-1}
                            className="w-12 bg-transparent text-[11px] font-bold text-slate-600 outline-none cursor-not-allowed"
                            placeholder="0"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex items-end gap-2">
                    {!isAgencyCampaign && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest ml-1">
                          Commission on Deal (₹)
                        </label>
                        <div className="bg-white border border-slate-200 rounded-lg shadow-sm h-8 px-2 flex items-center focus-within:ring-2 focus-within:ring-purple-100 transition-all">
                          <span className="text-xs font-bold text-slate-400 mr-2"></span>
                          <input
                            type="number"
                            value={commissionOnDeal}
                            onChange={(e) => setCommissionOnDeal(e.target.value)}
                            className="w-16 bg-transparent text-[11px] font-bold text-slate-900 outline-none"
                            placeholder="0"
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest ml-1">
                        Default Commission to Mediator (₹)
                      </label>
                      <div className="bg-white border border-slate-200 rounded-lg shadow-sm h-8 px-2 flex items-center focus-within:ring-2 focus-within:ring-purple-100 transition-all">
                        <span className="text-xs font-bold text-slate-400 mr-2"></span>
                        <input
                          type="number"
                          value={commissionToMediator}
                          onChange={(e) => setCommissionToMediator(e.target.value)}
                          className="w-16 bg-transparent text-[11px] font-bold text-slate-900 outline-none"
                          placeholder="0"
                        />
                      </div>
                    </div>
                  </div>
              </div>

                <div className="flex gap-2 ml-auto">
                  <button
                    onClick={handleDistributeEvenly}
                    className="px-4 py-2 bg-white text-slate-700 font-bold rounded-xl text-xs hover:bg-slate-100 transition-colors flex items-center gap-2 border border-slate-200 shadow-sm hover:shadow-md h-9"
                  >
                    <Share2 size={14} /> <span className="hidden sm:inline">Distribute Evenly</span>
                  </button>
                  <button
                    onClick={() => setAssignments({})}
                    aria-label="Clear assignments"
                    className="p-2 bg-white border border-slate-200 text-slate-400 rounded-xl hover:text-red-500 hover:border-red-200 transition-colors shadow-sm hover:shadow-md h-9 w-9 flex items-center justify-center"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>

              <div className="flex items-center justify-between gap-4 mb-1 shrink-0">
              <div className="flex-1 max-w-md">
                <div className="relative">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={assignSearch}
                    onChange={(e) => setAssignSearch(e.target.value)}
                    placeholder="Search mediators by name or code..."
                    className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-100 rounded-xl text-sm font-bold focus:ring-2 focus:ring-purple-100 outline-none transition-all placeholder:text-slate-400"
                  />
                </div>
              </div>
              <div className="text-xs font-bold text-slate-500">
                Showing {activeMediatorsForAssign.length} mediator(s)
              </div>
            </div>

            {/* List Header */}
            <div className="grid grid-cols-12 gap-4 px-4 py-2 bg-slate-50 rounded-xl border border-slate-100 mb-2 shrink-0">
              <div className="col-span-4 text-xs font-extrabold text-slate-400 uppercase tracking-wider pl-2">
                Mediator Profile
              </div>
              <div className="col-span-3 text-xs font-extrabold text-slate-400 uppercase tracking-wider text-center">
                Sales Performance
              </div>
              <div className="col-span-2 text-xs font-extrabold text-slate-400 uppercase tracking-wider text-center">
                Commission (₹)
              </div>
              <div className="col-span-3 text-xs font-extrabold text-slate-400 uppercase tracking-wider text-right pr-2">
                Allocation
              </div>
            </div>

            {/* Mediator List */}
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-styled space-y-2 pr-1 mb-2">
              {activeMediatorsForAssign.length === 0 ? (
                loading ? (
                  <EmptyState
                    title="Loading mediators"
                    description="Loading your team roster."
                    icon={<Spinner className="w-5 h-5 text-slate-400" />}
                    className="bg-slate-50/50 border-slate-200"
                  />
                ) : (
                  <EmptyState
                    title="No active mediators"
                    description="Invite mediators to start distributing inventory."
                    icon={<Users size={28} className="text-slate-300" />}
                    className="bg-slate-50/50 border-slate-200"
                  />
                )
              ) : (
                activeMediatorsForAssign.map((m: User) => {
                  const mediatorOrders = allOrders
                    ? allOrders.filter((o: Order) => o.managerName === m.mediatorCode)
                    : [];
                  const salesCount = mediatorOrders.length;
                  const salesRevenue = mediatorOrders.reduce(
                    (sum: number, o: Order) => sum + o.total,
                    0
                  );
                  const isActive = m.status === 'active';

                  return (
                    <div
                      key={m.id}
                      className={`grid grid-cols-12 gap-4 items-center p-2 border border-slate-100 rounded-2xl transition-all bg-white shadow-sm group ${isActive ? 'hover:border-purple-200 hover:bg-purple-50/10' : 'opacity-70'}`}
                    >
                      {/* Profile */}
                      <div className="col-span-4 flex items-center gap-4 pl-2">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center font-black text-sm group-hover:bg-purple-100 group-hover:text-purple-600 transition-colors shadow-inner overflow-hidden">
                          {m.avatar ? (
                            <ProxiedImage src={m.avatar} alt={m.name ? `${m.name} avatar` : 'Avatar'} className="w-full h-full object-cover" />
                          ) : (
                            (m.name || '?').charAt(0)
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-slate-900 group-hover:text-purple-700 transition-colors truncate">
                            {m.name || 'Unknown'}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-[10px] text-slate-400 font-mono bg-slate-50 px-1.5 py-0.5 rounded w-fit border border-slate-100">
                              {m.mediatorCode}
                            </p>
                            {!isActive && (
                              <span className="text-[9px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-100">
                                {m.status || 'inactive'}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Sales Performance */}
                      <div className="col-span-3 flex flex-col items-center justify-center">
                        <p className="text-base font-black text-slate-900">
                          {formatCurrency(salesRevenue)}
                        </p>
                        <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">
                          {salesCount} Orders
                        </p>
                      </div>

                      {/* Per-Mediator Commission */}
                      <div className="col-span-2 flex flex-col items-center">
                        <div className="relative group/input">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            className={`w-20 p-2 text-center bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none transition-all group-hover/input:shadow-md ${isActive ? 'focus:border-purple-500 focus:bg-white focus:ring-4 focus:ring-purple-100' : 'cursor-not-allowed'}`}
                            placeholder={commissionToMediator || '0'}
                            value={mediatorPayouts[m.mediatorCode!] ?? ''}
                            disabled={!isActive}
                            onChange={(e) =>
                              setMediatorPayouts({
                                ...mediatorPayouts,
                                [m.mediatorCode!]: e.target.value,
                              })
                            }
                          />
                        </div>
                        {mediatorPayouts[m.mediatorCode!]?.trim() && (
                          <span className="text-[8px] text-purple-500 font-bold mt-0.5">Override</span>
                        )}
                      </div>

                      {/* Input */}
                      <div className="col-span-3 flex flex-col items-end pr-2">
                        <div className="relative group/input">
                          <input
                            type="number"
                            min={0}
                            max={availableForAssign}
                            step={1}
                            className={`w-36 p-2 text-center bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none transition-all group-hover/input:shadow-md ${isActive ? 'focus:border-purple-500 focus:bg-white focus:ring-4 focus:ring-purple-100' : 'cursor-not-allowed'}`}
                            placeholder="0"
                            value={assignments[m.mediatorCode!] || ''}
                            disabled={!isActive}
                            onChange={(e) =>
                              {
                                const nextRaw = parseInt(e.target.value) || 0;
                                const currentVal = Number(assignments[m.mediatorCode!] || 0);
                                const remaining = Math.max(0, availableForAssign - (assignedTotal - currentVal));
                                const nextVal = Math.max(0, Math.min(nextRaw, remaining));
                                if (nextRaw > nextVal) {
                                  toast.error('Allocation capped by available stock');
                                }
                                setAssignments({
                                  ...assignments,
                                  [m.mediatorCode!]: nextVal,
                                });
                              }
                            }
                            onBlur={(e) => {
                              const nextRaw = parseInt(e.target.value) || 0;
                              const currentVal = Number(assignments[m.mediatorCode!] || 0);
                              const remaining = Math.max(0, availableForAssign - (assignedTotal - currentVal));
                              const nextVal = Math.max(0, Math.min(nextRaw, remaining));
                              if (nextVal !== currentVal) {
                                setAssignments({
                                  ...assignments,
                                  [m.mediatorCode!]: nextVal,
                                });
                              }
                            }}
                          />
                        </div>
                        <span className="text-[9px] text-slate-400 font-bold mt-1">
                          Current: {assignModal?.assignments?.[m.mediatorCode!] || 0}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="pt-4 border-t border-slate-100 flex justify-end gap-3 shrink-0">
              <button
                onClick={() => setAssignModal(null)}
                className="px-5 py-3 text-slate-500 font-bold text-sm hover:text-slate-800 hover:bg-slate-50 rounded-2xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAssign}
                disabled={assignedTotal <= 0 || assignedTotal > availableForAssign}
                className="px-8 py-3 bg-purple-600 text-white font-bold rounded-2xl hover:bg-purple-700 transition-all shadow-xl hover:shadow-2xl hover:shadow-purple-200 active:scale-95 flex items-center gap-2"
              >
                Confirm Distribution <CheckCircle size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ─── ORDER REVIEW TAB ─── */
const OrderReviewView = ({ allOrders, campaigns, mediators: _mediators, loading, onRefresh }: any) => {
  const { toast } = useToast();
  const [campaignFilter, setCampaignFilter] = useState('all');
  const [mediatorFilter, setMediatorFilter] = useState('all');
  const [approvalFilter, setApprovalFilter] = useState<'all' | 'manual' | 'ai' | 'pending'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'COMPLETED'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [proofOrder, setProofOrder] = useState<Order | null>(null);
  const [rejectModal, setRejectModal] = useState<{ order: Order; type: 'order' | 'review' | 'rating' | 'returnWindow' } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  useEffect(() => {
    setProofOrder((prev) => {
      if (!prev) return prev;
      const updated = allOrders.find((o: Order) => o.id === prev.id);
      return updated || null;
    });
  }, [allOrders]);

  const getApprovalMethod = (o: Order): 'ai' | 'manual' | 'pending' => {
    const v = (o as any).verification;
    if (!v?.order?.verifiedAt) return 'pending';
    return v.order.autoVerified ? 'ai' : 'manual';
  };

  const filtered = useMemo(() => {
    return (allOrders as Order[]).filter((o) => {
      if (campaignFilter !== 'all' && o.items?.[0]?.campaignId !== campaignFilter) return false;
      if (mediatorFilter !== 'all' && (o.managerName || '') !== mediatorFilter) return false;
      if (approvalFilter !== 'all' && getApprovalMethod(o) !== approvalFilter) return false;
      if (statusFilter !== 'all' && (o.workflowStatus || '') !== statusFilter) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const oid = (o.externalOrderId || o.id || '').toLowerCase();
        const buyer = (o.buyerName || '').toLowerCase();
        const product = (o.items?.[0]?.title || '').toLowerCase();
        if (!oid.includes(q) && !buyer.includes(q) && !product.includes(q)) return false;
      }
      return true;
    });
  }, [allOrders, campaignFilter, mediatorFilter, approvalFilter, statusFilter, searchTerm]);

  const handleReject = async () => {
    if (!rejectModal || rejectReason.trim().length < 5) return;
    setRejecting(true);
    try {
      await api.ops.rejectOrderProof(rejectModal.order.id, rejectModal.type, rejectReason.trim());
      toast.success('Proof rejected — buyer has been notified');
      setRejectModal(null);
      setRejectReason('');
      onRefresh();
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to reject proof'));
    } finally {
      setRejecting(false);
    }
  };

  const uniqueMediators = useMemo(() => {
    const codes = new Set<string>();
    allOrders.forEach((o: Order) => { if (o.managerName) codes.add(o.managerName); });
    return Array.from(codes).sort();
  }, [allOrders]);

  const uniqueCampaigns = useMemo(() => {
    const map = new Map<string, string>();
    allOrders.forEach((o: Order) => {
      const cid = o.items?.[0]?.campaignId;
      if (cid) {
        const camp = campaigns.find((c: Campaign) => c.id === cid);
        map.set(cid, camp?.title || cid.slice(0, 8));
      }
    });
    return Array.from(map.entries());
  }, [allOrders, campaigns]);

  const manualCount = useMemo(() => filtered.filter((o) => getApprovalMethod(o) === 'manual').length, [filtered]);

  return (
    <div className="animate-enter">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">Order Review</h2>
          <p className="text-xs text-slate-500 mt-1">{filtered.length} orders · {manualCount} manually approved</p>
        </div>
        <button onClick={onRefresh} disabled={loading} className="text-xs font-bold text-purple-600 hover:text-purple-700 bg-purple-50 hover:bg-purple-100 px-4 py-2 rounded-xl transition-colors">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative">
          <Filter size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search orders…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 pr-4 py-2 text-xs border border-slate-200 rounded-xl bg-white focus:ring-2 focus:ring-purple-200 focus:border-purple-300 outline-none w-48"
          />
        </div>
        <select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} className="text-xs border border-slate-200 rounded-xl px-3 py-2 bg-white focus:ring-2 focus:ring-purple-200">
          <option value="all">All Campaigns</option>
          {uniqueCampaigns.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </select>
        <select value={mediatorFilter} onChange={(e) => setMediatorFilter(e.target.value)} className="text-xs border border-slate-200 rounded-xl px-3 py-2 bg-white focus:ring-2 focus:ring-purple-200">
          <option value="all">All Mediators</option>
          {uniqueMediators.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={approvalFilter} onChange={(e) => setApprovalFilter(e.target.value as any)} className="text-xs border border-slate-200 rounded-xl px-3 py-2 bg-white focus:ring-2 focus:ring-purple-200">
          <option value="all">All Approval</option>
          <option value="manual">Manual Only</option>
          <option value="ai">AI Auto</option>
          <option value="pending">Pending</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className="text-xs border border-slate-200 rounded-xl px-3 py-2 bg-white focus:ring-2 focus:ring-purple-200">
          <option value="all">All Statuses</option>
          <option value="UNDER_REVIEW">Under Review</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="COMPLETED">Completed</option>
        </select>
      </div>

      {/* Orders table */}
      {filtered.length === 0 ? (
        <EmptyState
          title="No orders match filters"
          description="Adjust your filters or wait for new orders."
          icon={<ClipboardList size={22} className="text-slate-400" />}
          className="bg-transparent"
        />
      ) : (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-slate-50 text-slate-400 text-[10px] font-extrabold uppercase tracking-wider sticky top-0 z-10">
                <tr>
                  <th className="p-4 pl-6">Order ID / Date</th>
                  <th className="p-4">Buyer & Product</th>
                  <th className="p-4">Mediator</th>
                  <th className="p-4">Campaign</th>
                  <th className="p-4 text-right">Amount</th>
                  <th className="p-4 text-center">Approval</th>
                  <th className="p-4 text-center">Status</th>
                  <th className="p-4 pr-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 text-sm">
                {filtered.map((o: Order) => {
                  const method = getApprovalMethod(o);
                  const isManual = method === 'manual';
                  const wf = (o.workflowStatus || 'CREATED').toUpperCase();
                  const campTitle = campaigns.find((c: Campaign) => c.id === o.items?.[0]?.campaignId)?.title || '—';
                  return (
                    <tr key={o.id} className={`hover:bg-slate-50/80 transition-colors group ${isManual ? 'bg-amber-50/40' : ''}`}>
                      <td className="p-4 pl-6">
                        <div className="font-mono text-xs font-bold text-slate-900">{getPrimaryOrderId(o)}</div>
                        <div className="text-[10px] text-slate-400 font-bold mt-0.5">{new Date(o.createdAt).toLocaleDateString('en-GB')}</div>
                      </td>
                      <td className="p-4">
                        <div className="font-bold text-slate-900 text-xs truncate max-w-[160px]">{o.buyerName || 'Unknown'}</div>
                        <div className="text-[10px] text-slate-500 truncate max-w-[160px]">{o.items?.[0]?.title}</div>
                      </td>
                      <td className="p-4">
                        <div className="text-xs font-bold text-slate-700">{o.managerName || 'Unknown'}</div>
                      </td>
                      <td className="p-4">
                        <div className="text-xs text-slate-600 truncate max-w-[120px]">{campTitle}</div>
                      </td>
                      <td className="p-4 text-right font-mono font-bold text-slate-900 text-xs">{formatCurrency(o.total)}</td>
                      <td className="p-4 text-center">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                          method === 'ai' ? 'bg-blue-50 text-blue-600 border-blue-100'
                          : method === 'manual' ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-slate-50 text-slate-500 border-slate-200'
                        }`}>
                          {method === 'ai' ? <><Sparkles size={10} /> AI</> : method === 'manual' ? <><ShieldAlert size={10} /> Manual</> : <><Clock size={10} /> Pending</>}
                        </span>
                      </td>
                      <td className="p-4 text-center">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase ${
                          wf === 'APPROVED' || wf === 'COMPLETED' ? 'bg-green-50 text-green-700 border-green-100'
                          : wf === 'UNDER_REVIEW' ? 'bg-blue-50 text-blue-700 border-blue-100'
                          : wf === 'REJECTED' ? 'bg-red-50 text-red-600 border-red-100'
                          : 'bg-slate-50 text-slate-500 border-slate-200'
                        }`}>
                          {wf.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="p-4 pr-6 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setProofOrder(o)}
                            className="text-[10px] font-bold text-purple-600 hover:text-purple-700 bg-purple-50 hover:bg-purple-100 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                          >
                            <Eye size={12} /> Proof
                          </button>
                          {wf === 'UNDER_REVIEW' && (
                            <button
                              onClick={() => {
                                const v = (o as any).verification;
                                const proofType = !v?.order?.verifiedAt ? 'order'
                                  : o.items?.[0]?.dealType === 'Review' && !v?.review?.verifiedAt ? 'review'
                                  : o.items?.[0]?.dealType === 'Rating' && !v?.rating?.verifiedAt ? 'rating'
                                  : 'order';
                                setRejectModal({ order: o, type: proofType });
                              }}
                              className="text-[10px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                            >
                              <AlertTriangle size={12} /> Reject
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Proof Modal (reusable) */}
      {proofOrder && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => setProofOrder(null)}
        >
          <div
            className="bg-white w-full max-w-lg rounded-[2rem] p-6 shadow-2xl relative flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" aria-label="Close" onClick={() => setProofOrder(null)} className="absolute top-4 right-4 p-2 bg-slate-50 rounded-full hover:bg-slate-100 transition-colors">
              <X size={18} />
            </button>
            <div className="mb-4">
              <h3 className="font-extrabold text-lg text-zinc-900">Proof of Performance</h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-slate-500 font-bold">Order {getPrimaryOrderId(proofOrder)}</span>
                <span className="w-1 h-1 bg-slate-300 rounded-full" />
                <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${
                  proofOrder.items?.[0]?.dealType === 'Rating' ? 'bg-orange-50 text-orange-600 border-orange-100'
                  : proofOrder.items?.[0]?.dealType === 'Review' ? 'bg-purple-50 text-purple-600 border-purple-100'
                  : 'bg-blue-50 text-blue-600 border-blue-100'
                }`}>
                  {proofOrder.items?.[0]?.dealType || 'Discount'} Deal
                </span>
                {(() => {
                  const m = getApprovalMethod(proofOrder);
                  return m !== 'pending' ? (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${m === 'manual' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-600 border-blue-100'}`}>
                      {m === 'manual' ? 'Manual' : 'AI Auto'}
                    </span>
                  ) : null;
                })()}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-styled space-y-5 pr-2">
              {/* Product */}
              <div className="flex gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                <ProxiedImage src={proofOrder.items?.[0]?.image} alt={proofOrder.items?.[0]?.title || 'Product'} className="w-12 h-12 object-contain mix-blend-multiply rounded-lg bg-white border border-slate-100 p-1" />
                <div>
                  <p className="text-sm font-bold text-slate-900 line-clamp-1">{proofOrder.items?.[0]?.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">Total: <span className="font-mono font-bold text-zinc-900">{formatCurrency(proofOrder.total)}</span></p>
                  <p className="text-[10px] text-slate-400 mt-0.5">Mediator: {proofOrder.managerName} · Buyer: {proofOrder.buyerName}</p>
                  {proofOrder.reviewerName && <p className="text-[10px] text-indigo-500 font-bold mt-0.5">Reviewer: {proofOrder.reviewerName}</p>}
                  {proofOrder.items?.[0]?.platform && <p className="text-[10px] text-slate-400 mt-0.5">Platform: {proofOrder.items[0].platform}</p>}
                </div>
              </div>
              {/* Settlement details */}
              {(proofOrder.settlementRef || proofOrder.settlementMode) && (
                <div className="flex flex-wrap gap-3 p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                  {proofOrder.settlementRef && <div><span className="text-[10px] font-bold text-emerald-500 uppercase">UTR / Reference</span><p className="text-xs font-mono font-bold text-emerald-800">{proofOrder.settlementRef}</p></div>}
                  {proofOrder.settlementMode && <div><span className="text-[10px] font-bold text-emerald-500 uppercase">Payment Mode</span><p className="text-xs font-bold text-emerald-800 uppercase">{proofOrder.settlementMode}</p></div>}
                </div>
              )}
              {/* Order Screenshot */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-extrabold text-slate-400 uppercase tracking-widest"><FileText size={14} /> Purchase Proof</div>
                {proofOrder.screenshots?.order ? (
                  <div className="rounded-2xl border-2 border-slate-100 overflow-hidden shadow-sm">
                    <ProofImage orderId={proofOrder.id} proofType="order" existingSrc={proofOrder.screenshots.order !== 'exists' ? proofOrder.screenshots.order : undefined} alt="Order Proof" className="w-full h-auto block" />
                  </div>
                ) : (
                  <div className="p-6 border-2 border-dashed border-red-200 bg-red-50 rounded-2xl text-center"><AlertCircle size={20} className="mx-auto text-red-400 mb-1" /><p className="text-xs font-bold text-red-500">Missing</p></div>
                )}
                {proofOrder.orderAiVerification && (
                  <div className="bg-indigo-50 p-3 rounded-xl border border-indigo-100">
                    <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider mb-2"><Sparkles size={12} className="inline mr-1" />AI Verification</p>
                    <div className="flex gap-2">
                      <div className={`flex-1 p-2 rounded-lg border text-center ${proofOrder.orderAiVerification.orderIdMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                        <p className="text-[9px] font-bold uppercase text-slate-500">Order ID</p>
                        <p className={`text-xs font-bold ${proofOrder.orderAiVerification.orderIdMatch ? 'text-green-600' : 'text-red-600'}`}>{proofOrder.orderAiVerification.orderIdMatch ? 'Match' : 'Mismatch'}</p>
                      </div>
                      <div className={`flex-1 p-2 rounded-lg border text-center ${proofOrder.orderAiVerification.amountMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                        <p className="text-[9px] font-bold uppercase text-slate-500">Amount</p>
                        <p className={`text-xs font-bold ${proofOrder.orderAiVerification.amountMatch ? 'text-green-600' : 'text-red-600'}`}>{proofOrder.orderAiVerification.amountMatch ? 'Match' : 'Mismatch'}</p>
                      </div>
                    </div>
                    <p className="text-[9px] text-slate-500 mt-2">Confidence: {proofOrder.orderAiVerification.confidenceScore ?? 0}%</p>
                  </div>
                )}
              </div>
              {/* Rating Proof */}
              {proofOrder.items?.[0]?.dealType === 'Rating' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-orange-400 uppercase tracking-widest"><Star size={14} /> Rating Proof</div>
                  {proofOrder.screenshots?.rating ? (
                    <div className="rounded-2xl border-2 border-orange-100 overflow-hidden shadow-sm">
                      <ProofImage orderId={proofOrder.id} proofType="rating" existingSrc={proofOrder.screenshots.rating !== 'exists' ? proofOrder.screenshots.rating : undefined} alt="Rating Proof" className="w-full h-auto block" />
                    </div>
                  ) : (
                    <div className="p-4 border-2 border-dashed border-orange-200 bg-orange-50 rounded-2xl text-center"><p className="text-xs font-bold text-orange-500">Awaiting rating proof…</p></div>
                  )}
                </div>
              )}
              {/* Review Link */}
              {proofOrder.items?.[0]?.dealType === 'Review' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-purple-400 uppercase tracking-widest"><MessageCircle size={14} /> Live Review</div>
                  {proofOrder.reviewLink ? (
                    <a href={proofOrder.reviewLink} target="_blank" rel="noreferrer" className="flex items-center justify-between p-3 bg-purple-50 text-purple-700 rounded-xl font-bold text-xs border border-purple-100 hover:bg-purple-100 transition-colors group">
                      <span className="truncate flex-1 mr-2">{proofOrder.reviewLink}</span>
                      <ExternalLink size={14} className="group-hover:scale-110 transition-transform" />
                    </a>
                  ) : (
                    <div className="p-4 border-2 border-dashed border-purple-200 bg-purple-50 rounded-2xl text-center"><p className="text-xs font-bold text-purple-500">Review link not submitted</p></div>
                  )}
                </div>
              )}
              {/* Return Window */}
              {proofOrder.screenshots?.returnWindow && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-teal-500 uppercase tracking-widest"><Package size={14} /> Return Window</div>
                  <div className="rounded-2xl border-2 border-teal-100 overflow-hidden shadow-sm">
                    <ProofImage orderId={proofOrder.id} proofType="returnWindow" existingSrc={proofOrder.screenshots.returnWindow !== 'exists' ? proofOrder.screenshots.returnWindow : undefined} className="w-full h-auto max-h-[60vh] object-contain bg-zinc-50" alt="Return Window" />
                  </div>
                </div>
              )}
              {/* Rejection info */}
              {proofOrder.rejection?.type && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                  <p className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-1">Rejected: {proofOrder.rejection.type}</p>
                  <p className="text-xs text-red-700">{proofOrder.rejection.reason || 'No reason provided'}</p>
                  {proofOrder.rejection.rejectedAt && <p className="text-[9px] text-red-400 mt-1">{new Date(proofOrder.rejection.rejectedAt).toLocaleDateString('en-GB')}</p>}
                </div>
              )}
            </div>
            <button onClick={() => setProofOrder(null)} className="w-full py-3 mt-4 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-black transition-colors shadow-lg">Close</button>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in" onClick={() => { setRejectModal(null); setRejectReason(''); }}>
          <div className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-extrabold text-lg text-red-600 mb-1 flex items-center gap-2"><AlertTriangle size={20} /> Reject Proof</h3>
            <p className="text-xs text-slate-500 mb-4">Order {getPrimaryOrderId(rejectModal.order)} · Rejecting <strong>{rejectModal.type}</strong> proof</p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (min 5 characters)…"
              className="w-full border border-slate-200 rounded-xl p-3 text-sm resize-none h-24 focus:ring-2 focus:ring-red-200 focus:border-red-300 outline-none"
            />
            <div className="flex gap-3 mt-4">
              <button onClick={() => { setRejectModal(null); setRejectReason(''); }} className="flex-1 py-2.5 text-sm font-bold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">Cancel</button>
              <button onClick={handleReject} disabled={rejecting || rejectReason.trim().length < 5} className="flex-1 py-2.5 text-sm font-bold text-white bg-red-600 rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {rejecting ? 'Rejecting…' : 'Reject Proof'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const TeamView = ({ mediators, user, loading, onRefresh, allOrders }: any) => {
  const { toast } = useToast();
  const [subTab, setSubTab] = useState<'roster' | 'requests'>('roster');
  const [searchTerm, setSearchTerm] = useState('');
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [selectedMediator, setSelectedMediator] = useState<User | null>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [proofOrder, setProofOrder] = useState<Order | null>(null);


  // Keep proof modal in sync when allOrders updates from real-time
  useEffect(() => {
    setProofOrder((prev) => {
      if (!prev) return prev;
      const updated = allOrders.find((o: Order) => o.id === prev.id);
      return updated || null;
    });
  }, [allOrders]);

  // [PERF] Memoize mediator list filtering
  const { activeMediators, pendingMediators } = useMemo(() => ({
    activeMediators: mediators.filter((m: User) => m.status === 'active'),
    pendingMediators: mediators.filter((m: User) => m.status === 'pending'),
  }), [mediators]);

  const filtered = useMemo(() => (subTab === 'roster' ? activeMediators : pendingMediators).filter(
    (m: User) =>
      m.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      m.mediatorCode?.includes(searchTerm.toUpperCase())
  ), [subTab, activeMediators, pendingMediators, searchTerm]);

  // Filter orders for selected mediator (Sanitized for Privacy)
  const mediatorOrders = useMemo(() => {
    if (!selectedMediator) return [];
    return allOrders.filter((o: Order) => o.managerName === selectedMediator.mediatorCode);
  }, [selectedMediator, allOrders]);

  const generateInvite = async () => {
    const code = await api.ops.generateMediatorInvite(user.id);
    setInviteCode(code);
  };

  const handleApproval = async (e: React.MouseEvent, id: string, action: 'approve' | 'reject') => {
    e.stopPropagation(); // Prevents opening the modal row
    try {
      if (action === 'approve') await api.ops.approveMediator(id);
      else await api.ops.rejectMediator(id);
      onRefresh();
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to update mediator request'));
    }
  };

  const handlePayout = async () => {
    if (!selectedMediator || !payoutAmount) return;
    if (!selectedMediator.upiId && !selectedMediator.qrCode) {
      toast.error('UPI ID or QR is required to payout');
      return;
    }
    const amount = Number(payoutAmount);

    try {
      await api.ops.payoutMediator(selectedMediator.id, amount);
      toast.success(`Sent ${amount} to ${selectedMediator.name}`);
      setPayoutAmount('');
      onRefresh();
      setSelectedMediator(null);
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to payout mediator'));
    }
  };

  const getStatusBadge = (order: Order) => {
    const purchaseVerified = !!order.verification?.orderVerified;
    const missingProofs = order.requirements?.missingProofs ?? [];
    const missingVerifications = order.requirements?.missingVerifications ?? [];

    if (order.paymentStatus === 'Paid')
      return (
        <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-1 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
          <CheckCircle size={10} /> Settled
        </span>
      );
    if (purchaseVerified && missingProofs.length > 0)
      return (
        <span className="text-[10px] font-bold text-amber-700 flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
          <AlertTriangle size={10} /> Action Required
        </span>
      );
    if (purchaseVerified && missingVerifications.length > 0)
      return (
        <span className="text-[10px] font-bold text-purple-700 flex items-center gap-1 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
          <Clock size={10} /> Awaiting Approval
        </span>
      );
    if (order.affiliateStatus === 'Pending_Cooling')
      return (
        <span className="text-[10px] font-bold text-blue-600 flex items-center gap-1 bg-blue-50 px-2 py-0.5 rounded border border-blue-100">
          <CheckCircle size={10} /> Verified
        </span>
      );
    if (order.affiliateStatus === 'Unchecked')
      return (
        <span className="text-[10px] font-bold text-amber-500 flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded border border-amber-100">
          <Clock size={10} /> Pending Review
        </span>
      );
    return (
      <span className="text-[10px] font-bold text-slate-400 flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
        Pending
      </span>
    );
  };

  return (
    <div className="space-y-6 animate-enter h-full flex flex-col">
      {/* Controls Bar */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-4 rounded-[1.5rem] border border-slate-100 shadow-sm">
        <div className="flex gap-1 bg-slate-50 p-1 rounded-xl w-full md:w-auto">
          <button
            onClick={() => setSubTab('roster')}
            className={`flex-1 md:flex-none px-6 py-2.5 rounded-lg text-xs font-bold transition-all ${subTab === 'roster' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
          >
            Active Roster ({activeMediators.length})
          </button>
          <button
            onClick={() => setSubTab('requests')}
            className={`flex-1 md:flex-none px-6 py-2.5 rounded-lg text-xs font-bold transition-all ${subTab === 'requests' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
          >
            Requests ({pendingMediators.length})
          </button>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-1 md:w-64">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Find mediator..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm font-bold focus:ring-2 focus:ring-purple-100 outline-none transition-all placeholder:text-slate-400"
            />
          </div>
          {inviteCode ? (
            <div className="flex items-center gap-2 px-4 py-3 bg-purple-50 text-purple-700 rounded-xl text-xs font-bold border border-purple-200 animate-fade-in whitespace-nowrap">
              {inviteCode}{' '}
              <Copy
                size={14}
                className="cursor-pointer hover:text-purple-900"
                onClick={() => {
                  navigator.clipboard.writeText(inviteCode);
                }}
              />
              <button
                onClick={() => setInviteCode(null)}
                aria-label="Dismiss invite code"
                className="ml-2 p-1 hover:bg-purple-100 rounded-full"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              onClick={generateInvite}
              className="px-4 py-3 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-black flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-transform whitespace-nowrap"
            >
              <UserPlus size={16} /> Invite
            </button>
          )}
        </div>
      </div>

      {/* Main List */}
      <div className="bg-white rounded-[2rem] border border-slate-100 overflow-hidden shadow-sm flex-1">
        <div className="overflow-x-auto h-full scrollbar-styled">
          <table className="w-full text-left">
            <thead className="bg-slate-50 text-slate-400 text-[10px] font-extrabold uppercase tracking-wider sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="p-5 pl-8">Mediator Profile</th>
                <th className="p-5">Status</th>
                <th className="p-5 text-center">Orders</th>
                <th className="p-5 text-right">Pending Payout</th>
                {subTab === 'requests' && <th className="p-5 pr-8 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 text-sm">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6">
                    {loading ? (
                      <EmptyState
                        title="Loading mediators"
                        description="Fetching your roster and requests."
                        icon={<Spinner className="w-5 h-5 text-slate-400" />}
                        className="border-slate-200"
                      />
                    ) : (
                      <EmptyState
                        title="No mediators found"
                        description="Try clearing filters or searching by name / code."
                        className="border-slate-200"
                      />
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((m: User) => (
                  <tr
                    key={m.id}
                    onClick={() => subTab === 'roster' && setSelectedMediator(m)}
                    className={`transition-colors group ${subTab === 'roster' ? 'hover:bg-purple-50/50 cursor-pointer' : ''}`}
                  >
                    <td className="p-5 pl-8">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center font-black text-slate-500 shadow-inner overflow-hidden">
                          {m.avatar ? (
                            <ProxiedImage src={m.avatar} alt={m.name ? `${m.name} avatar` : 'Avatar'} className="w-full h-full object-cover" />
                          ) : (
                            (m.name || '?').charAt(0)
                          )}
                        </div>
                        <div>
                          <div className="font-bold text-slate-900 group-hover:text-purple-700 transition-colors">
                            {m.name || 'Unknown'}
                          </div>
                          <div className="text-[10px] text-slate-400 font-mono bg-slate-50 px-1.5 py-0.5 rounded w-fit mt-0.5 border border-slate-100">
                            {m.mediatorCode}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="p-5">
                      <span
                        className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase border shadow-sm ${
                          m.status === 'pending'
                            ? 'bg-blue-50 text-blue-700 border-blue-100'
                            : m.status === 'active'
                              ? 'bg-green-50 text-green-700 border-green-100'
                              : 'bg-amber-50 text-amber-700 border-amber-100'
                        }`}
                      >
                        {m.status === 'pending'
                          ? 'Awaiting Agency Approval'
                          : m.status === 'active'
                            ? 'Active'
                            : 'Suspended'}
                      </span>
                    </td>
                    <td className="p-5 text-center">
                      <div className="text-xs font-bold text-slate-600">
                        {allOrders.filter((o: Order) => o.managerName === m.mediatorCode).length}{' '}
                        Orders
                      </div>
                    </td>
                    <td className="p-5 text-right">
                      <p className="font-mono font-bold text-slate-900">
                        {formatCurrency(m.walletBalance || 0)}
                      </p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase">Payable</p>
                    </td>
                    {subTab === 'requests' && (
                      <td className="p-5 pr-8 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={(e) => handleApproval(e, m.id, 'approve')}
                            aria-label="Approve request"
                            className="p-2 bg-green-50 text-green-600 rounded-lg hover:bg-green-100 border border-green-100 transition-colors cursor-pointer active:scale-90"
                          >
                            <Check size={16} />
                          </button>
                          <button
                            onClick={(e) => handleApproval(e, m.id, 'reject')}
                            aria-label="Reject request"
                            className="p-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 border border-red-100 transition-colors cursor-pointer active:scale-90"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* DETAIL MODAL */}
      {selectedMediator && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => setSelectedMediator(null)}
        >
          <div
            className="bg-white w-[95%] md:w-full max-w-5xl rounded-[2.5rem] shadow-2xl relative max-h-[90vh] flex flex-col animate-slide-up overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="bg-slate-900 p-6 flex justify-between items-start text-white flex-shrink-0">
              <div className="flex gap-4 items-center">
                <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center font-black text-2xl overflow-hidden">
                  {selectedMediator.avatar ? (
                    <ProxiedImage
                      src={selectedMediator.avatar}
                      alt={selectedMediator.name ? `${selectedMediator.name} avatar` : 'Avatar'}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    (selectedMediator?.name || '?').charAt(0)
                  )}
                </div>
                <div>
                  <h2 className="text-2xl font-bold">{selectedMediator?.name || 'Unknown'}</h2>
                  <p className="text-sm text-slate-400 font-mono mb-2">
                    {selectedMediator.mediatorCode}
                  </p>
                </div>
              </div>
              <button
                aria-label="Close mediator details"
                onClick={() => setSelectedMediator(null)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <X size={24} />
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-styled md:overflow-hidden flex flex-col md:flex-row">
              {/* Order List Side */}
              <div className="flex-1 overflow-visible md:overflow-y-auto p-6 scrollbar-styled border-r border-slate-100">
                <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                  <FileText size={18} /> Order History
                </h3>
                <div className="space-y-3">
                  {mediatorOrders.length === 0 ? (
                    loading ? (
                      <EmptyState
                        title="Loading orders"
                        description="Fetching this mediator's order history."
                        icon={<Spinner className="w-5 h-5 text-slate-400" />}
                        className="border-slate-200"
                      />
                    ) : (
                      <EmptyState
                        title="No orders yet"
                        description="When this mediators network completes orders, they'll show up here."
                        className="border-slate-200"
                      />
                    )
                  ) : (
                    mediatorOrders.map((o: Order) => (
                      <div
                        key={o.id}
                        className="p-4 border border-slate-100 rounded-2xl hover:bg-slate-50 transition-colors flex gap-4 items-center"
                      >
                        <div className="w-12 h-12 bg-white border border-slate-200 rounded-xl p-1 shrink-0">
                          <ProxiedImage
                            src={o.items?.[0]?.image}
                            alt={o.items?.[0]?.title || 'Order item'}
                            className="w-full h-full object-contain mix-blend-multiply"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center mb-1">
                            <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                              {getPrimaryOrderId(o)}
                            </span>
                            {getStatusBadge(o)}
                          </div>
                          <h4 className="font-bold text-slate-900 text-sm truncate">
                            {o.items?.[0]?.title}
                          </h4>
                          <div className="flex justify-between items-center mt-1">
                            <span className="text-xs text-slate-500">Buyer: {o.buyerName}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setProofOrder(o);
                              }}
                              className="text-[10px] font-bold text-purple-600 hover:text-purple-700 bg-purple-50 hover:bg-purple-100 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
                            >
                              <Eye size={12} /> View Proof
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Payout Action Side */}
              <div className="w-full md:w-[28rem] bg-white p-6 flex flex-col shadow-[inset_10px_0_20px_-15px_rgba(0,0,0,0.05)] min-h-0">
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-styled">
                  <h3 className="font-bold text-slate-800 mb-6 flex items-center gap-2">
                    <Wallet size={18} /> Quick Payout
                  </h3>

                  <div className="bg-white p-5 rounded-2xl border border-slate-200 mb-6 shadow-md relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-purple-50 to-indigo-50 rounded-bl-full -mr-10 -mt-10 z-0 opacity-50 group-hover:opacity-100 transition-opacity"></div>
                    <div className="flex justify-between items-center mb-5 relative z-10">
                      <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">
                        Beneficiary Details
                      </p>
                      <CreditCard size={16} className="text-purple-500" />
                    </div>

                    <div className="space-y-4 relative z-10">
                      <div className="p-4 bg-slate-50/50 rounded-xl border border-slate-100 hover:border-purple-200 hover:bg-purple-50/20 transition-all">
                        <p className="text-[9px] text-slate-400 font-bold uppercase mb-2 flex justify-between">
                          UPI Address
                          {selectedMediator.upiId && (
                            <button
                              className="text-purple-600 hover:text-purple-800 flex items-center gap-1"
                              onClick={() => {
                                navigator.clipboard.writeText(selectedMediator.upiId || '');
                                toast.success('UPI copied');
                              }}
                            >
                              <Copy size={10} /> Copy
                            </button>
                          )}
                        </p>
                        {selectedMediator.upiId ? (
                          <p className="text-sm font-bold text-slate-900 font-mono break-all leading-tight">
                            {selectedMediator.upiId}
                          </p>
                        ) : (
                          <div className="flex items-center gap-2 text-red-500 bg-red-50 px-2 py-1 rounded w-fit">
                            <AlertCircle size={12} />{' '}
                            <span className="text-xs font-bold">Not Linked</span>
                          </div>
                        )}
                      </div>

                      <div className="p-4 bg-slate-50/50 rounded-xl border border-slate-100 hover:border-purple-200 hover:bg-purple-50/20 transition-all">
                        <p className="text-[9px] text-slate-400 font-bold uppercase mb-2 flex justify-between">
                          UPI QR
                          {selectedMediator.qrCode && (
                            <button
                              className="text-purple-600 hover:text-purple-800 flex items-center gap-1"
                              onClick={() => {
                                navigator.clipboard.writeText(selectedMediator.qrCode || '');
                                toast.success('QR copied');
                              }}
                              title="Copy QR image URL/data"
                            >
                              <Copy size={10} /> Copy
                            </button>
                          )}
                        </p>
                        {selectedMediator.qrCode ? (
                          <div className="bg-white border border-slate-200 rounded-xl p-3 w-fit">
                            <ProxiedImage
                              src={selectedMediator.qrCode}
                              alt="UPI QR"
                              className="w-36 h-36 object-contain"
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-slate-500 bg-slate-100 px-2 py-1 rounded w-fit">
                            <AlertCircle size={12} />{' '}
                            <span className="text-xs font-bold">QR Not Uploaded</span>
                          </div>
                        )}
                      </div>

                      <p className="text-[10px] text-slate-500 font-bold">
                        Bank details are not required for Quick Payout.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-4 pb-6">
                    <div>
                      <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">
                        Transfer Amount
                      </label>
                      <div className="relative group">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-slate-400 text-lg group-focus-within:text-green-600 transition-colors">
                          
                        </span>
                        <input
                          type="number"
                          value={payoutAmount}
                          onChange={(e) => setPayoutAmount(e.target.value)}
                          className="w-full pl-9 pr-4 py-4 border border-slate-200 bg-slate-50 rounded-2xl font-black text-xl text-slate-900 focus:outline-none focus:border-green-500 focus:ring-4 focus:ring-green-50 focus:bg-white transition-all placeholder:text-slate-300"
                          placeholder="0"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sticky bottom-0 pt-4 bg-white">
                  <button
                    onClick={handlePayout}
                    disabled={
                      !payoutAmount ||
                      Number(payoutAmount) <= 0 ||
                      (!selectedMediator.upiId && !selectedMediator.qrCode)
                    }
                    className="w-full py-4 bg-black text-white font-bold rounded-2xl shadow-xl hover:bg-green-600 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:scale-100 disabled:hover:bg-black"
                    title={
                      !selectedMediator.upiId && !selectedMediator.qrCode
                        ? 'UPI ID or QR is required'
                        : 'Send Payout'
                    }
                  >
                    <Send size={18} /> Confirm Transfer
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PROOF MODAL */}
      {proofOrder && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
          onClick={() => setProofOrder(null)}
        >
          <div
            className="bg-white w-full max-w-lg rounded-[2rem] p-6 shadow-2xl relative flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close proof modal"
              onClick={() => setProofOrder(null)}
              className="absolute top-4 right-4 p-2 bg-slate-50 rounded-full hover:bg-slate-100 transition-colors"
            >
              <X size={18} />
            </button>

            <div className="mb-6">
              <h3 className="font-extrabold text-lg text-zinc-900 mb-1">Proof of Performance</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 font-bold">
                  Order {getPrimaryOrderId(proofOrder)}
                </span>
                <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                <span
                  className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${
                    proofOrder.items?.[0]?.dealType === 'Rating'
                      ? 'bg-orange-50 text-orange-600 border-orange-100'
                      : proofOrder.items?.[0]?.dealType === 'Review'
                        ? 'bg-purple-50 text-purple-600 border-purple-100'
                        : 'bg-blue-50 text-blue-600 border-blue-100'
                  }`}
                >
                  {proofOrder.items?.[0]?.dealType || 'Discount'} Deal
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-styled space-y-6 pr-2">
              {/* Product Summary */}
              <div className="flex gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <ProxiedImage
                  src={proofOrder.items?.[0]?.image}
                  alt={proofOrder.items?.[0]?.title || 'Product'}
                  className="w-14 h-14 object-contain mix-blend-multiply rounded-xl bg-white border border-slate-100 p-1"
                />
                <div>
                  <p className="text-sm font-bold text-slate-900 line-clamp-1">
                    {proofOrder.items?.[0]?.title}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Total:{' '}
                    <span className="font-mono font-bold text-zinc-900">{formatCurrency(proofOrder.total)}</span>
                  </p>
                </div>
              </div>

              {/* 1. Mandatory Order Screenshot */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-extrabold text-slate-400 uppercase tracking-widest">
                  <FileText size={14} /> Purchase Proof
                </div>
                {proofOrder.screenshots?.order ? (
                  <>
                    <div className="rounded-2xl border-2 border-slate-100 overflow-hidden shadow-sm">
                      <ProofImage
                        orderId={proofOrder.id}
                        proofType="order"
                        existingSrc={proofOrder.screenshots.order !== 'exists' ? proofOrder.screenshots.order : undefined}
                        alt="Order Proof"
                        className="w-full h-auto block"
                      />
                    </div>
                    {/* AI Verification — stored from buyer's proof submission */}
                    {proofOrder.orderAiVerification && (
                    <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100 mt-3 relative overflow-hidden">
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="font-bold text-indigo-600 flex items-center gap-2 text-xs uppercase tracking-widest">
                          <Sparkles size={14} className="text-indigo-500" /> AI Verification
                        </h4>
                      </div>
                        <div className="space-y-3 animate-fade-in">
                          {(() => {
                            const aiData = proofOrder.orderAiVerification;
                            const n = Number(aiData?.confidenceScore);
                            const score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
                            return (
                              <>
                                <div className="flex gap-2">
                                  <div className={`flex-1 p-2 rounded-lg border ${aiData?.orderIdMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                                    <p className={`text-[9px] font-bold uppercase ${aiData?.orderIdMatch ? 'text-green-600' : 'text-red-600'}`}>Order ID</p>
                                    <p className="text-xs font-bold text-slate-900">{aiData?.orderIdMatch ? 'Matched' : 'Mismatch'}</p>
                                    {aiData?.detectedOrderId && (
                                      <p className="text-[9px] text-slate-500 mt-0.5 font-mono break-all">Detected: {aiData.detectedOrderId}</p>
                                    )}
                                  </div>
                                  <div className={`flex-1 p-2 rounded-lg border ${aiData?.amountMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                                    <p className={`text-[9px] font-bold uppercase ${aiData?.amountMatch ? 'text-green-600' : 'text-red-600'}`}>Amount</p>
                                    <p className="text-xs font-bold text-slate-900">{aiData?.amountMatch ? 'Matched' : 'Mismatch'}</p>
                                    {aiData?.detectedAmount != null && (
                                      <p className="text-[9px] text-slate-500 mt-0.5 font-mono">Detected: {formatCurrency(aiData.detectedAmount)}</p>
                                    )}
                                  </div>
                                </div>
                                <div className="bg-slate-100 p-2 rounded-lg">
                                  <p className="text-[10px] text-slate-600 leading-relaxed">{aiData?.discrepancyNote || 'Verified. Details match expected values.'}</p>
                                </div>
                                <div className="flex justify-between items-center pt-1">
                                  <span className="text-[9px] text-indigo-500 font-bold uppercase">Confidence Score</span>
                                  <div className="flex items-center gap-2">
                                    <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${score > 80 ? 'bg-green-500' : score > 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                        style={{ width: `${score}%` }}
                                      ></div>
                                    </div>
                                    <span className="text-xs font-bold text-slate-900">{score}%</span>
                                  </div>
                                </div>
                              </>
                            );
                          })()}
                        </div>
                    </div>
                    )}
                  </>
                ) : (
                  <div className="p-8 border-2 border-dashed border-red-200 bg-red-50 rounded-2xl text-center">
                    <AlertCircle size={24} className="mx-auto text-red-400 mb-2" />
                    <p className="text-xs font-bold text-red-500">Missing Order Screenshot</p>
                  </div>
                )}
              </div>

              {/* 2. Rating Screenshot (Conditional) */}
              {proofOrder.items?.[0]?.dealType === 'Rating' && (
                <div className="space-y-2 animate-slide-up">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-orange-400 uppercase tracking-widest">
                    <Star size={14} /> Rating Proof
                  </div>
                  {proofOrder.screenshots?.rating ? (
                    <div className="rounded-2xl border-2 border-orange-100 overflow-hidden shadow-sm relative">
                      <div className="absolute top-2 right-2 bg-orange-500 text-white text-[9px] font-bold px-2 py-1 rounded-lg">
                        5 Stars
                      </div>
                      <ProofImage
                        orderId={proofOrder.id}
                        proofType="rating"
                        existingSrc={proofOrder.screenshots.rating !== 'exists' ? proofOrder.screenshots.rating : undefined}
                        alt="Rating Proof"
                        className="w-full h-auto block"
                      />
                    </div>
                  ) : (
                    <div className="p-6 border-2 border-dashed border-orange-200 bg-orange-50 rounded-2xl text-center">
                      <p className="text-xs font-bold text-orange-500">
                        Waiting for Rating Screenshot...
                      </p>
                    </div>
                  )}
                  {/* AI Rating Verification Results */}
                  {proofOrder.ratingAiVerification && (
                    <div className="mt-2 bg-orange-50 rounded-xl border border-orange-100 p-3 space-y-1.5">
                      <p className="text-[10px] font-bold text-orange-400 uppercase tracking-wider">AI Rating Verification</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div className={`p-2 rounded-lg text-center ${proofOrder.ratingAiVerification.accountNameMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                          <p className="text-[9px] font-bold text-slate-400 uppercase">Account Name</p>
                          <p className={`text-xs font-bold ${proofOrder.ratingAiVerification.accountNameMatch ? 'text-green-600' : 'text-red-600'}`}>
                            {proofOrder.ratingAiVerification.accountNameMatch ? '✓ Match' : '✗ Mismatch'}
                          </p>
                          {proofOrder.ratingAiVerification.detectedAccountName && (
                            <p className="text-[9px] text-slate-500 truncate mt-0.5">Found: {proofOrder.ratingAiVerification.detectedAccountName}</p>
                          )}
                        </div>
                        <div className={`p-2 rounded-lg text-center ${proofOrder.ratingAiVerification.productNameMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                          <p className="text-[9px] font-bold text-slate-400 uppercase">Product Name</p>
                          <p className={`text-xs font-bold ${proofOrder.ratingAiVerification.productNameMatch ? 'text-green-600' : 'text-red-600'}`}>
                            {proofOrder.ratingAiVerification.productNameMatch ? '✓ Match' : '✗ Mismatch'}
                          </p>
                          {proofOrder.ratingAiVerification.detectedProductName && (
                            <p className="text-[9px] text-slate-500 truncate mt-0.5">Found: {proofOrder.ratingAiVerification.detectedProductName}</p>
                          )}
                        </div>
                      </div>
                      <p className="text-[9px] text-slate-500">Confidence: {proofOrder.ratingAiVerification.confidenceScore}%</p>
                    </div>
                  )}
                </div>
              )}

              {/* 3. Review Link (Conditional) */}
              {proofOrder.items?.[0]?.dealType === 'Review' && (
                <div className="space-y-2 animate-slide-up">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-purple-400 uppercase tracking-widest">
                    <MessageCircle size={14} /> Live Review
                  </div>
                  {proofOrder.reviewLink ? (
                    <a
                      href={proofOrder.reviewLink}
                      target="_blank" rel="noreferrer"
                      className="flex items-center justify-between p-4 bg-purple-50 text-purple-700 rounded-2xl font-bold text-xs border border-purple-100 hover:bg-purple-100 transition-colors group"
                    >
                      <span className="truncate flex-1 mr-2">{proofOrder.reviewLink}</span>
                      <ExternalLink
                        size={16}
                        className="group-hover:scale-110 transition-transform"
                      />
                    </a>
                  ) : (
                    <div className="p-6 border-2 border-dashed border-purple-200 bg-purple-50 rounded-2xl text-center">
                      <p className="text-xs font-bold text-purple-500">Review Link Not Submitted</p>
                    </div>
                  )}
                </div>
              )}

              {/* 4. Return Window Proof */}
              {proofOrder.screenshots?.returnWindow && (
                <div className="space-y-2 animate-slide-up">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-teal-500 uppercase tracking-widest">
                    <Package size={14} /> Return Window
                  </div>
                  <div className="rounded-2xl border-2 border-teal-100 overflow-hidden shadow-sm">
                    <ProofImage
                      orderId={proofOrder.id}
                      proofType="returnWindow"
                      existingSrc={proofOrder.screenshots.returnWindow !== 'exists' ? proofOrder.screenshots.returnWindow : undefined}
                      className="w-full h-auto max-h-[60vh] object-contain bg-zinc-50"
                      alt="Return Window proof"
                    />
                  </div>
                  {/* AI Return Window Verification */}
                  {proofOrder.returnWindowAiVerification && (
                    <div className="mt-2 bg-teal-50 rounded-xl border border-teal-100 p-3 space-y-1.5">
                      <p className="text-[10px] font-bold text-teal-500 uppercase tracking-wider">AI Return Window Verification</p>
                      <div className="grid grid-cols-2 gap-2">
                        {proofOrder.returnWindowAiVerification.orderIdMatch !== undefined && (
                          <div className={`p-2 rounded-lg text-center ${proofOrder.returnWindowAiVerification.orderIdMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                            <p className="text-[9px] font-bold text-slate-400 uppercase">Order ID</p>
                            <p className={`text-xs font-bold ${proofOrder.returnWindowAiVerification.orderIdMatch ? 'text-green-600' : 'text-red-600'}`}>
                              {proofOrder.returnWindowAiVerification.orderIdMatch ? '✓ Match' : '✗ Mismatch'}
                            </p>
                          </div>
                        )}
                        {proofOrder.returnWindowAiVerification.productNameMatch !== undefined && (
                          <div className={`p-2 rounded-lg text-center ${proofOrder.returnWindowAiVerification.productNameMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                            <p className="text-[9px] font-bold text-slate-400 uppercase">Product Name</p>
                            <p className={`text-xs font-bold ${proofOrder.returnWindowAiVerification.productNameMatch ? 'text-green-600' : 'text-red-600'}`}>
                              {proofOrder.returnWindowAiVerification.productNameMatch ? '✓ Match' : '✗ Mismatch'}
                            </p>
                          </div>
                        )}
                        {proofOrder.returnWindowAiVerification.amountMatch !== undefined && (
                          <div className={`p-2 rounded-lg text-center ${proofOrder.returnWindowAiVerification.amountMatch ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                            <p className="text-[9px] font-bold text-slate-400 uppercase">Amount</p>
                            <p className={`text-xs font-bold ${proofOrder.returnWindowAiVerification.amountMatch ? 'text-green-600' : 'text-red-600'}`}>
                              {proofOrder.returnWindowAiVerification.amountMatch ? '✓ Match' : '✗ Mismatch'}
                            </p>
                          </div>
                        )}
                        {proofOrder.returnWindowAiVerification.returnWindowClosed !== undefined && (
                          <div className={`p-2 rounded-lg text-center ${proofOrder.returnWindowAiVerification.returnWindowClosed ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
                            <p className="text-[9px] font-bold text-slate-400 uppercase">Window Closed</p>
                            <p className={`text-xs font-bold ${proofOrder.returnWindowAiVerification.returnWindowClosed ? 'text-green-600' : 'text-yellow-600'}`}>
                              {proofOrder.returnWindowAiVerification.returnWindowClosed ? '✓ Closed' : '⏳ Open'}
                            </p>
                          </div>
                        )}
                      </div>
                      {proofOrder.returnWindowAiVerification.detectedReturnWindow && (
                        <p className="text-[9px] text-slate-500">Detected Window: {proofOrder.returnWindowAiVerification.detectedReturnWindow}</p>
                      )}
                      {proofOrder.returnWindowAiVerification.discrepancyNote && (
                        <p className="text-[9px] text-red-500 font-semibold">Note: {proofOrder.returnWindowAiVerification.discrepancyNote}</p>
                      )}
                      <p className="text-[9px] text-slate-500">Confidence: {proofOrder.returnWindowAiVerification.confidenceScore}%</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={() => { setProofOrder(null); }}
              className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-black transition-colors shadow-lg"
            >
              Close Viewer
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// --- MAIN LAYOUT ---

export const AgencyDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  useRealtimeConnection();
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'team' | 'inventory' | 'orders' | 'finance' | 'payouts' | 'brands' | 'tickets' | 'profile'
  >('dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Data state
  const [stats, setStats] = useState({ revenue: 0, totalMediators: 0, activeCampaigns: 0 });
  const [orders, setOrders] = useState<Order[]>([]);
  const [mediators, setMediators] = useState<User[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [isDataLoading, setIsDataLoading] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketFilter, setTicketFilter] = useState<'All' | 'Open' | 'Resolved' | 'Rejected'>('All');
  const [ticketSearch, setTicketSearch] = useState('');
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  const fetchData = async () => {
    if (!user?.mediatorCode) return;
    setIsDataLoading(true);
    try {
      const [meds, camps, ords, ledger, tix] = await Promise.all([
        api.ops.getMediators(user.mediatorCode),
        api.ops.getCampaigns(user.mediatorCode),
        api.ops.getMediatorOrders(user.mediatorCode, 'agency'),
        api.ops.getAgencyLedger(),
        api.tickets.getAll().catch(() => []),
      ]);
      const safeMeds = asArray<User>(meds);
      const safeCamps = asArray<Campaign>(camps);
      const safeOrds = asArray<Order>(ords);
      const safeLedger = asArray(ledger);

      setMediators(safeMeds);
      setCampaigns(safeCamps);
      setOrders(safeOrds);
      setPayouts(safeLedger);
      setTickets(asArray<Ticket>(tix).filter((t: Ticket) => t.issueType !== 'Feedback'));

      const revenue = safeOrds.reduce((sum: number, o: Order) => sum + (o.total || 0), 0);

      // Fixed logic: Campaign is active if this agency is allowed AND some sub-mediators have assignments
      const myMediatorCodes: string[] = safeMeds
        .map((m: User) => m.mediatorCode)
        .filter((code: string | undefined | null): code is string => Boolean(code));
      const activeCount = safeCamps.filter(
        (c: Campaign) =>
          c.status === 'Active' &&
          c.allowedAgencies.includes(user.mediatorCode!) &&
          Object.keys(c.assignments || {}).some((code: string) => myMediatorCodes.includes(code))
      ).length;

      setStats({
        revenue,
        totalMediators: safeMeds.length,
        activeCampaigns: activeCount,
      });
    } catch (e) {
      console.error('Dashboard data fetch failed', e);
      toast.error('Failed to load dashboard data');
    } finally {
      setIsDataLoading(false);
    }
  };


  useEffect(() => {
    fetchData();
  }, [user]);

  // Realtime: refresh when backend data changes.
  useEffect(() => {
    if (!user) return;
    let timer: any = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fetchData();
      }, 900);
    };
    const unsub = subscribeRealtime((msg) => {
      if (
        msg.type === 'orders.changed' ||
        msg.type === 'users.changed' ||
        msg.type === 'wallets.changed' ||
        msg.type === 'deals.changed' ||
        msg.type === 'notifications.changed' ||
        msg.type === 'tickets.changed'
      ) {
        schedule();
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user]);

  return (
    <DesktopShell
      isSidebarOpen={isSidebarOpen}
      onSidebarOpenChange={setIsSidebarOpen}
      containerClassName="flex h-[100dvh] min-h-0 bg-[#F8F9FA] overflow-hidden relative"
      asideClassName="bg-white border-r border-slate-100 shadow-xl shadow-slate-200/50 flex flex-col"
      mainClassName="flex-1 min-w-0 min-h-0 overflow-y-auto bg-[#FAFAFA] relative scrollbar-styled p-4 md:p-8"
      mobileHeader={<h2 className="text-xl font-black text-slate-900">Agency Portal</h2>}
      mobileMenuButton={
        <button
          onClick={() => setIsSidebarOpen(true)}
          aria-label="Open menu"
          className="p-2 bg-white rounded-xl shadow-sm border border-slate-100"
        >
          <Menu size={20} />
        </button>
      }
      sidebar={
        <>
          <div className="p-6">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-purple-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-purple-200">
                <Building2 size={24} />
              </div>
              <div>
                <h1 className="font-extrabold text-xl text-slate-900 tracking-tight leading-none">
                  BUZZMA<span className="text-purple-600">Ops</span>
                </h1>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    Agency Portal
                  </p>
                </div>
              </div>
            </div>

            <nav className="space-y-1">
              <SidebarItem
                icon={<LayoutDashboard />}
                label="Dashboard"
                active={activeTab === 'dashboard'}
                onClick={() => {
                  setActiveTab('dashboard');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<Users />}
                label="My Team"
                active={activeTab === 'team'}
                onClick={() => {
                  setActiveTab('team');
                  setIsSidebarOpen(false);
                }}
                badge={mediators.filter((m) => m.kycStatus === 'pending').length}
              />
              <SidebarItem
                icon={<Layers />}
                label="Inventory"
                active={activeTab === 'inventory'}
                onClick={() => {
                  setActiveTab('inventory');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<ClipboardList />}
                label="Order Review"
                active={activeTab === 'orders'}
                onClick={() => {
                  setActiveTab('orders');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<FileText />}
                label="Finance"
                active={activeTab === 'finance'}
                onClick={() => {
                  setActiveTab('finance');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<Banknote />}
                label="Payouts"
                active={activeTab === 'payouts'}
                onClick={() => {
                  setActiveTab('payouts');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<LinkIcon />}
                label="Connect Brands"
                active={activeTab === 'brands'}
                onClick={() => {
                  setActiveTab('brands');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<HelpCircle />}
                label="Tickets"
                active={activeTab === 'tickets'}
                onClick={() => {
                  setActiveTab('tickets');
                  setIsSidebarOpen(false);
                }}
                badge={tickets.filter((t) => String(t.status || '').toLowerCase() === 'open').length}
              />
            </nav>
          </div>

          <div className="mt-auto p-6 border-t border-slate-50">
            <button
              onClick={() => {
                setActiveTab('profile');
                setIsSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all mb-2 ${activeTab === 'profile' ? 'bg-slate-50 border border-slate-200' : 'hover:bg-slate-50'}`}
            >
              <div className="w-10 h-10 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-sm overflow-hidden">
                {user?.avatar ? (
                  <ProxiedImage src={user.avatar} alt={user?.name ? `${user.name} avatar` : 'Avatar'} className="w-full h-full object-cover" />
                ) : (
                  (user?.name || '?').charAt(0)
                )}
              </div>
              <div className="text-left min-w-0">
                <p className="text-sm font-bold text-slate-900 truncate">{user?.name || 'Unknown'}</p>
                <p className="text-[10px] text-slate-400 font-mono truncate">{user?.mediatorCode}</p>
              </div>
            </button>
            <button
              onClick={() => setTicketOpen(true)}
              className="w-full flex items-center justify-center gap-2 py-3 text-xs font-bold text-amber-600 hover:bg-amber-50 rounded-xl transition-colors mb-1"
            >
              <AlertTriangle size={16} /> Raise a Ticket
            </button>
            <button
              onClick={logout}
              className="w-full flex items-center justify-center gap-2 py-3 text-xs font-bold text-red-500 hover:bg-red-50 rounded-xl transition-colors"
            >
              <LogOut size={16} /> Sign Out
            </button>
          </div>
        </>
      }
    >
      {activeTab === 'dashboard' && <DashboardView stats={stats} allOrders={orders} />}
      {activeTab === 'team' && (
        <TeamView
          mediators={mediators}
          user={user}
          loading={isDataLoading}
          onRefresh={fetchData}
          allOrders={orders}
        />
      )}
      {activeTab === 'inventory' && (
        <InventoryView
          campaigns={campaigns}
          user={user}
          loading={isDataLoading}
          onRefresh={fetchData}
          mediators={mediators}
          allOrders={orders}
        />
      )}
      {activeTab === 'orders' && (
        <OrderReviewView
          allOrders={orders}
          campaigns={campaigns}
          mediators={mediators}
          loading={isDataLoading}
          onRefresh={fetchData}
        />
      )}
      {activeTab === 'finance' && (
        <FinanceView
          allOrders={orders}
          mediators={mediators}
          loading={isDataLoading}
          onRefresh={fetchData}
          user={user}
        />
      )}
      {activeTab === 'payouts' && (
        <PayoutsView
          payouts={payouts}
          loading={isDataLoading}
          onRefresh={fetchData}
        />
      )}
      {activeTab === 'brands' && <BrandsView />}
      {activeTab === 'tickets' && (
        <div className="max-w-3xl mx-auto animate-enter pb-12">
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight mb-6">Tickets</h2>
          {/* Export CSV */}
          {tickets && tickets.length > 0 && (
            <button type="button" onClick={() => {
              const supportTickets = tickets.filter(t => t.issueType !== 'Feedback');
              if (!supportTickets.length) { toast.error('No tickets to export'); return; }
              const header = ['Ticket ID','Status','Issue Type','Description','User','Role','Target Role','Order ID','Resolution Note','Resolved By','Resolved At','Created At'].map(csvSafe).join(',');
              const rows = supportTickets.map(t => [
                csvSafe(t.id.slice(-8)), csvSafe(String(t.status)),
                csvSafe(String(t.issueType)), csvSafe(String(t.description || '')), csvSafe(String((t as any).userName || '')),
                csvSafe(String((t as any).role || '')), csvSafe(String((t as any).targetRole || '')), csvSafe(String(t.orderId || '')),
                csvSafe(String((t as any).resolutionNote || '')), csvSafe(String((t as any).resolvedByName || '')),
                csvSafe((t as any).resolvedAt ? new Date((t as any).resolvedAt).toLocaleDateString('en-GB') : ''),
                csvSafe(t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : ''),
              ].join(','));
              downloadCsv(`agency-tickets-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows].join('\n'));
              toast.success(`Exported ${supportTickets.length} tickets`);
            }} className="mb-4 px-4 py-2 rounded-xl text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-all">
              Export Tickets CSV
            </button>
          )}
          {/* Search + Status filter */}
          {tickets && tickets.length > 0 && (
            <>
            <div className="mb-2">
              <input type="text" placeholder="Search tickets..." value={ticketSearch} onChange={e => setTicketSearch(e.target.value)}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
            </div>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {(['All', 'Open', 'Resolved', 'Rejected'] as const).map(f => {
                const count = f === 'All' ? tickets.length : tickets.filter(t => String(t.status) === f).length;
                return (
                  <button key={f} type="button" onClick={() => setTicketFilter(f)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                      ticketFilter === f
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
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
              description="Support tickets assigned to your agency will appear here."
              icon={<HelpCircle size={22} className="text-slate-400" />}
            />
          ) : (
            <div className="space-y-3 max-h-[65vh] overflow-y-auto scrollbar-styled">
              {tickets.filter((t: Ticket) => {
                if (ticketFilter !== 'All' && String(t.status) !== ticketFilter) return false;
                if (ticketSearch.trim()) {
                  const q = ticketSearch.trim().toLowerCase();
                  return (String(t.issueType || '').toLowerCase().includes(q) ||
                    String(t.description || '').toLowerCase().includes(q) ||
                    String((t as any).userName || '').toLowerCase().includes(q) ||
                    String(t.orderId || '').toLowerCase().includes(q) ||
                    t.id.toLowerCase().includes(q));
                }
                return true;
              }).map((t: Ticket) => (
                <div key={t.id} className="rounded-xl border border-slate-100 bg-white px-3 py-3 shadow-sm space-y-2 cursor-pointer hover:border-slate-300 transition-colors" onClick={() => setSelectedTicket(t)}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-900 truncate">{String(t.issueType || 'Ticket')}</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          String(t.status) === 'Resolved' ? 'bg-emerald-50 text-emerald-600' :
                          String(t.status) === 'Rejected' ? 'bg-red-50 text-red-600' :
                          'bg-amber-50 text-amber-600'
                        }`}>{String(t.status || 'Open')}</span>
                      </div>
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0">{t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : ''}</span>
                  </div>
                  {t.description && (
                    <div className="text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2 line-clamp-3">
                      &ldquo;{String(t.description)}&rdquo;
                    </div>
                  )}
                  {(t as any).userName && (
                    <div className="text-[10px] text-slate-400">From: {String((t as any).userName)} ({String((t as any).userRole || '')})</div>
                  )}
                  {t.orderId && (
                    <div className="text-[10px] text-slate-400"><span className="font-bold">Order:</span> {String(t.orderId)}</div>
                  )}
                  {(t as any).resolutionNote && (
                    <div className="text-[10px] text-green-700 bg-green-50 rounded-lg px-2 py-1.5">
                      <span className="font-bold">Resolution:</span> {String((t as any).resolutionNote)}
                    </div>
                  )}
                  {(String(t.status) === 'Resolved' || String(t.status) === 'Rejected') && ((t as any).resolvedByName || (t as any).resolvedAt) && (
                    <div className="text-[10px] text-slate-400">
                      {String(t.status) === 'Resolved' ? 'Resolved' : 'Rejected'}
                      {(t as any).resolvedByName ? ` by ${String((t as any).resolvedByName)}` : ''}
                      {(t as any).resolvedAt ? ` on ${new Date(String((t as any).resolvedAt)).toLocaleDateString('en-GB')}` : ''}
                    </div>
                  )}
                  <div className="flex items-center gap-2 justify-end flex-wrap">
                    {String(t.status || '').toLowerCase() === 'open' && resolvingTicketId !== t.id && (
                        <button type="button" onClick={() => { setResolvingTicketId(t.id); setResolutionNote(''); }}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100">
                          ✓ Resolve / Reject
                        </button>
                    )}
                    {String(t.status || '').toLowerCase() === 'open' && resolvingTicketId === t.id && (
                      <div className="w-full mt-1 space-y-1.5">
                        <textarea placeholder="Resolution / rejection note (optional)..." value={resolutionNote} onChange={e => setResolutionNote(e.target.value)} rows={2}
                          className="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-none" />
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={async () => {
                            try { await api.tickets.update(t.id, 'Resolved', resolutionNote || undefined); toast.success('Ticket resolved.'); setResolvingTicketId(null); setResolutionNote(''); fetchData(); } catch (err: any) { toast.error(formatErrorMessage(err, 'Failed to resolve.')); }
                          }} className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-500 text-white hover:bg-emerald-600">✓ Resolve</button>
                          <button type="button" onClick={async () => {
                            try { await api.tickets.update(t.id, 'Rejected', resolutionNote || undefined); toast.success('Ticket rejected.'); setResolvingTicketId(null); setResolutionNote(''); fetchData(); } catch (err: any) { toast.error(formatErrorMessage(err, 'Failed to reject.')); }
                          }} className="px-3 py-1 rounded-lg text-xs font-bold bg-red-500 text-white hover:bg-red-600">✗ Reject</button>
                          <button type="button" onClick={() => { setResolvingTicketId(null); setResolutionNote(''); }}
                            className="px-3 py-1 rounded-lg text-xs font-bold bg-slate-100 text-slate-500 hover:bg-slate-200">Cancel</button>
                        </div>
                      </div>
                    )}
                    {String(t.status || '').toLowerCase() !== 'open' && (
                      <>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await api.tickets.update(t.id, 'Open');
                              toast.success('Ticket reopened.');
                              fetchData();
                            } catch (err: any) {
                              toast.error(formatErrorMessage(err, 'Failed to reopen ticket.'));
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100"
                        >
                          Reopen
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await api.tickets.delete(t.id);
                              toast.success('Ticket deleted.');
                              fetchData();
                            } catch (err: any) {
                              toast.error(formatErrorMessage(err, 'Failed to delete ticket.'));
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-50 border border-slate-200 text-slate-600 hover:text-red-600 hover:border-red-200"
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
        </div>
      )}
      {activeTab === 'profile' && <AgencyProfile user={user} />}
      <RaiseTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} />
      <TicketDetailModal
        open={!!selectedTicket}
        onClose={() => setSelectedTicket(null)}
        ticket={selectedTicket}
        onRefresh={fetchData}
      />
    </DesktopShell>
  );
};
