import React, { useState, useEffect, useMemo, useRef, useCallback, Suspense } from 'react';
import { getDirectBackendUrl } from '../utils/apiBaseUrl';
import { maskMobile } from '../utils/mobiles';
import { formatErrorMessage } from '../utils/errors';
import { ProxiedImage } from '../components/ProxiedImage';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ui/ConfirmDialog';
import {
  LogOut,
  Building2,
  Briefcase,
  Plus,
  Search,
  Trash2,
  CheckCircle,
  Users,
  LayoutDashboard,
  ChevronRight,
  ArrowUpRight,
  Globe,
  Wallet,
  TrendingUp,
  AlertCircle,
  AlertTriangle as AlertTriangleIcon,
  Lock,
  Image as ImageIcon,
  Link as LinkIcon,
  Bell,
  XCircle,
  ShoppingBag,
  Eye,
  X,
  Copy,
  Menu,
  CreditCard,
  Landmark,
  Send,
  Star,
  MessageCircle,
  FileText,
  ExternalLink,
  History,
  Save,
  Edit2,
  Key,
  Download,
  Phone,
  Mail,
  Camera,
  Package,
  FileSpreadsheet,
  Sparkles,
  HelpCircle,
  BarChart3,
} from 'lucide-react';
import { api, asArray, invalidateGetCache } from '../services/api';
import { subscribeRealtime } from '../services/realtime';
import { useRealtimeConnection } from '../hooks/useRealtimeConnection';
import { User, Campaign, Order, Ticket } from '../types';
import { EmptyState, Spinner, Pagination } from '../components/ui';
import { ProofImage } from '../components/ProofImage';
import { FeedbackCard } from '../components/FeedbackCard';
import { RatingVerificationBadge, ReturnWindowVerificationBadge } from '../components/AiVerificationBadge';
import { formatCurrency } from '../utils/formatCurrency';
import { getPrimaryOrderId } from '../utils/orderHelpers';
import { csvSafe, downloadCsv } from '../utils/csvHelpers';
import { lazyRetry } from '../utils/lazyRetry';

// Lazy-load modals & heavy utilities (only needed on user interaction)
const RaiseTicketModal = lazyRetry(() =>
  import('../components/RaiseTicketModal').then(m => ({ default: m.RaiseTicketModal }))
);
const TicketDetailModal = lazyRetry(() => import('../components/TicketDetailModal'));
import { DesktopShell } from '../components/DesktopShell';
import { BetaLock } from '../components/BetaLock';
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

// --- TYPES ---
type Tab = 'dashboard' | 'agencies' | 'campaigns' | 'requests' | 'orders' | 'tickets' | 'profile';

// formatCurrency, getPrimaryOrderId, csvSafe, downloadCsv imported from shared/utils

// --- COMPONENTS ---

const SidebarItem = ({ icon, label, active, onClick, badge }: any) => (
  <button
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`w-full flex items-center justify-between px-5 py-4 rounded-2xl transition-all duration-300 group mb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none motion-reduce:transform-none ${
      active
        ? 'bg-zinc-900 text-white shadow-xl shadow-zinc-900/10 scale-100'
        : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900'
    }`}
  >
    <div className="flex items-center gap-4 min-w-0 flex-1">
      <span
        className={`transition-colors flex-shrink-0 ${active ? 'text-lime-400' : 'group-hover:text-zinc-900'}`}
      >
        {React.cloneElement(icon, { size: 20, strokeWidth: active ? 2.5 : 2 })}
      </span>
      <span
        className={`font-bold text-[15px] tracking-wide whitespace-nowrap truncate ${active ? 'font-extrabold' : ''}`}
      >
        {label}
      </span>
    </div>
    {badge > 0 && (
      <span className="bg-lime-500 text-zinc-900 text-[10px] font-extrabold px-2.5 py-1 rounded-full shadow-sm flex-shrink-0 ml-2">
        {badge}
      </span>
    )}
  </button>
);

const StatCard = ({ label, value, icon, trend, dark }: any) => (
  <div
    className={`p-6 rounded-[2rem] flex flex-col justify-between h-44 relative overflow-hidden group hover:-translate-y-1 transition-all duration-300 ${
      dark
        ? 'bg-zinc-900 text-white shadow-2xl shadow-zinc-900/20'
        : 'bg-white border border-zinc-100 shadow-sm hover:shadow-xl hover:shadow-zinc-200/50'
    }`}
  >
    {/* Decor */}
    <div
      className={`absolute -right-6 -top-6 w-32 h-32 rounded-full blur-3xl transition-opacity ${
        dark ? 'bg-lime-500/20 opacity-100' : 'bg-zinc-200 opacity-0 group-hover:opacity-50'
      }`}
    ></div>

    <div className="flex justify-between items-start z-10">
      <div
        className={`p-3.5 rounded-2xl ${dark ? 'bg-white/10 text-lime-400' : 'bg-zinc-50 text-zinc-900'}`}
      >
        {icon}
      </div>
      {trend && (
        <div
          className={`flex items-center gap-1 text-xs font-bold px-3 py-1.5 rounded-full ${
            dark ? 'bg-lime-400/10 text-lime-400' : 'bg-green-50 text-green-600'
          }`}
        >
          <TrendingUp size={12} /> {trend}
        </div>
      )}
    </div>

    <div className="z-10">
      <p
        className={`text-xs font-bold uppercase tracking-widest mb-1 ${dark ? 'text-zinc-500' : 'text-zinc-400'}`}
      >
        {label}
      </p>
      <h3 className="text-4xl font-extrabold tracking-tight">{value}</h3>
    </div>
  </div>
);

// --- VIEWS ---

const BrandProfileView = () => {
  const { user, updateUser } = useAuth();
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    name: user?.name || '',
    mobile: user?.mobile || '',
    email: user?.email || '',
  });
  const [avatar, setAvatar] = useState(user?.avatar);

  const prevUserIdRef = useRef(user?.id);
  useEffect(() => {
    if (!user) return;
    if (prevUserIdRef.current === user.id) return;
    prevUserIdRef.current = user.id;
    setForm({
      name: user.name || '',
      mobile: user.mobile || '',
      email: user.email || '',
    });
    setAvatar(user.avatar);
  }, [user?.id]);

  const handleSave = async () => {
    setLoading(true);
    try {
      await updateUser({
        name: form.name,
        mobile: form.mobile,
        email: form.email,
        avatar,
      });
      setIsEditing(false);
      toast.success('Profile updated');
    } catch (e) {
      toast.error(formatErrorMessage(e, 'Failed to update profile.'));
    } finally {
      setLoading(false);
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) { toast.error('Avatar must be under 2 MB'); return; }
      const reader = new FileReader();
      reader.onload = () => setAvatar(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="animate-enter">
      <div className="bg-white rounded-[2.5rem] shadow-sm border border-zinc-100 overflow-hidden relative mb-8">
        <div className="h-40 bg-zinc-900 relative"></div>
        <div className="px-8 pb-8 flex flex-col md:flex-row items-end -mt-16 gap-8">
          <div
            className="relative group cursor-pointer"
            onClick={() => isEditing && fileInputRef.current?.click()}
          >
            <div className="w-36 h-36 rounded-[2rem] bg-white p-2 shadow-2xl border border-zinc-100 rotate-3 transition-transform group-hover:rotate-0">
              <div className="w-full h-full bg-zinc-100 rounded-[1.5rem] flex items-center justify-center text-5xl font-black text-zinc-300 overflow-hidden relative">
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
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white backdrop-blur-[2px] transition-opacity">
                    <Camera size={28} />
                  </div>
                )}
              </div>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              onChange={handleFile}
              aria-label="Upload profile photo"
            />
          </div>
          <div className="flex-1 pb-2">
            <h2 className="text-4xl font-black text-zinc-900 tracking-tight truncate">{user?.name}</h2>
            <div className="flex flex-wrap items-center gap-3 mt-3">
              <span className="px-3 py-1 bg-lime-100 text-lime-700 rounded-lg text-xs font-bold border border-lime-200">
                Verified Brand
              </span>
              <span className="font-mono text-xs text-zinc-400 font-bold bg-zinc-50 px-2 py-1 rounded border border-zinc-100 flex items-center gap-2">
                <Key size={12} /> {user?.brandCode}
              </span>
            </div>
          </div>
          <button
            onClick={() => (isEditing ? handleSave() : setIsEditing(true))}
            disabled={loading}
            className={`px-8 py-3.5 rounded-xl font-bold text-sm transition-all shadow-lg active:scale-95 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${isEditing ? 'bg-black text-white hover:bg-zinc-800' : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200'}`}
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-white p-10 rounded-[2.5rem] border border-zinc-100 shadow-sm space-y-8 h-full">
          <h3 className="font-extrabold text-xl text-zinc-900 flex items-center gap-3">
            <Building2 size={24} className="text-lime-500" /> Brand Identity
          </h3>
          <div className="space-y-6">
            <div className="group">
              <label className="text-[11px] font-extrabold text-zinc-400 uppercase tracking-wider ml-1 mb-2 block">
                Brand Name
              </label>
              <input
                type="text"
                disabled={!isEditing}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                aria-label="Brand Name"
                className="w-full p-4 bg-zinc-50 rounded-2xl font-bold text-zinc-900 outline-none focus:ring-4 focus:ring-lime-100 focus:bg-white transition-all disabled:opacity-70 disabled:bg-zinc-50/50"
              />
            </div>
            <div className="group">
              <label className="text-[11px] font-extrabold text-zinc-400 uppercase tracking-wider ml-1 mb-2 block">
                Brand Code (Immutable)
              </label>
              <div className="w-full p-4 bg-zinc-100 rounded-2xl font-bold text-zinc-500 font-mono border border-zinc-200 flex items-center gap-3">
                <Lock size={16} /> {user?.brandCode}
              </div>
              <p className="text-[10px] text-zinc-400 mt-2 ml-1 font-medium">
                This code is used by agencies to identify your organization.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white p-10 rounded-[2.5rem] border border-zinc-100 shadow-sm space-y-8 h-full">
          <h3 className="font-extrabold text-xl text-zinc-900 flex items-center gap-3">
            <Phone size={24} className="text-lime-500" /> Contact Details
          </h3>
          <div className="space-y-6">
            <div className="group">
              <label className="text-[11px] font-extrabold text-zinc-400 uppercase tracking-wider ml-1 mb-2 block">
                Mobile Number
              </label>
              <div className="relative">
                <Phone
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400"
                  size={18}
                />
                <input
                  type="tel"
                  disabled
                  value={maskMobile(form.mobile)}
                  onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                  aria-label="Mobile number"
                  className="w-full pl-12 pr-4 py-4 bg-zinc-50 rounded-2xl font-bold text-zinc-900 outline-none focus:ring-4 focus:ring-lime-100 focus:bg-white transition-all disabled:opacity-70 disabled:bg-zinc-50/50"
                />
              </div>
              <p className="text-[10px] text-zinc-400 mt-2 ml-1 font-medium">
                Mobile number cannot be changed.
              </p>
            </div>
            <div className="group">
              <label className="text-[11px] font-extrabold text-zinc-400 uppercase tracking-wider ml-1 mb-2 block">
                Email Address
              </label>
              <div className="relative">
                <Mail
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400"
                  size={18}
                />
                <input
                  type="email"
                  disabled={!isEditing}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="brand@company.com"
                  className="w-full pl-12 pr-4 py-4 bg-zinc-50 rounded-2xl font-bold text-zinc-900 outline-none focus:ring-4 focus:ring-lime-100 focus:bg-white transition-all disabled:opacity-70 disabled:bg-zinc-50/50"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Feedback Section */}
      <div className="mt-8">
        <FeedbackCard role="brand" />
      </div>
    </div>
  );
};

const DashboardView = ({
  stats,
  revenueData,
  campaignPerformance,
}: {
  stats: { totalRevenue: number; activeCampaigns: number; partnerAgencies: number; inventoryReach: number };
  revenueData: Array<{ name: string; revenue: number; dateKey: string }>;
  campaignPerformance: Array<{ name: string; sold: number; remaining: number; total: number }>;
}) => {
  const { totalRevenue, activeCampaigns, partnerAgencies, inventoryReach } = stats;

  const formatRupees = (value: number) => {
    const n = Number(value || 0);
    return `${Math.round(n).toLocaleString('en-IN')}`;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-enter">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
        <div>
          <h1 className="text-4xl font-extrabold text-zinc-900 tracking-tight mb-2">
            Command Center
          </h1>
          <p className="text-zinc-500 font-medium">
            Real-time overview of your market performance.
          </p>
        </div>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          label="Total Revenue"
          value={`${(totalRevenue / 100000).toFixed(2)}L`}
          icon={<Wallet size={24} />}
          dark
        />
        <StatCard label="Active Campaigns" value={activeCampaigns} icon={<Briefcase size={24} />} />
        <StatCard
          label="Partner Agencies"
          value={partnerAgencies}
          icon={<Users size={24} />}
        />
        <StatCard
          label="Inventory Reach"
          value={`${(inventoryReach / 1000).toFixed(1)}k`}
          icon={<Globe size={24} />}
          dark
        />
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 h-auto lg:h-[400px]">
        {/* Revenue Chart */}
        <div className="lg:col-span-2 bg-white p-8 rounded-[2.5rem] shadow-sm border border-zinc-100 relative overflow-hidden h-[400px] lg:h-full">
          <div className="flex justify-between items-center mb-8">
            <h3 className="font-bold text-lg text-zinc-900">Revenue Trajectory</h3>
            <div className="flex gap-2">
              <span className="w-3 h-3 rounded-full bg-lime-500"></span>
              <span className="text-xs font-bold text-zinc-400 uppercase">Gross Sales</span>
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 top-20 px-4 pb-4">
            {revenueData.length === 0 || revenueData.every((d: any) => !d.revenue) ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="p-4 rounded-full bg-zinc-50 mb-4"><TrendingUp size={32} className="text-zinc-300" /></div>
                <p className="text-sm font-semibold text-zinc-400">No revenue data yet</p>
                <p className="text-xs text-zinc-300 mt-1">Revenue will appear here as orders are completed</p>
              </div>
            ) : (
            <ChartSuspense>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueData}>
                <defs>
                  <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#84cc16" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#84cc16" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f4f4f5" />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  fontSize={12}
                  tick={{ fill: '#a1a1aa' }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  fontSize={12}
                  tick={{ fill: '#a1a1aa' }}
                  tickFormatter={(v: number) => formatRupees(Number(v))}
                />
                <Tooltip
                  cursor={{ stroke: '#d4d4d8', strokeWidth: 1, strokeDasharray: '4 4' }}
                  contentStyle={{
                    borderRadius: '16px',
                    border: 'none',
                    boxShadow: '0 10px 40px -10px rgba(0,0,0,0.1)',
                    padding: '12px 20px',
                  }}
                  itemStyle={{ color: '#18181b', fontWeight: 'bold' }}
                  formatter={(value: any) => formatRupees(Number(value))}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="#65a30d"
                  strokeWidth={4}
                  fillOpacity={1}
                  fill="url(#colorRev)"
                />
              </AreaChart>
            </ResponsiveContainer>
            </ChartSuspense>
            )}
          </div>
        </div>

        {/* Campaign Inventory Chart */}
        <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-zinc-100 flex flex-col h-[400px] lg:h-full">
          <div className="mb-4">
            <h3 className="font-bold text-lg text-zinc-900">Inventory Fill Rate</h3>
            <div className="flex items-center gap-3 mt-2">
              <span className="flex items-center gap-1 text-[10px] font-bold text-zinc-400 uppercase">
                <span className="w-2 h-2 rounded-full bg-lime-500"></span> Sold
              </span>
              <span className="flex items-center gap-1 text-[10px] font-bold text-zinc-400 uppercase">
                <span className="w-2 h-2 rounded-full bg-zinc-100"></span> Remaining
              </span>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {!campaignPerformance || campaignPerformance.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="p-4 rounded-full bg-zinc-50 mb-4"><BarChart3 size={32} className="text-zinc-300" /></div>
                <p className="text-sm font-semibold text-zinc-400">No campaigns yet</p>
                <p className="text-xs text-zinc-300 mt-1">Create campaigns to track inventory fill rates</p>
              </div>
            ) : (
            <ChartSuspense>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={campaignPerformance}
                layout="vertical"
                barSize={24}
                margin={{ left: 10, right: 10 }}
              >
                <XAxis type="number" hide />
                <YAxis
                  dataKey="name"
                  type="category"
                  width={100}
                  tick={{ fontSize: 12, fontWeight: 600, fill: '#52525b' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: 'transparent' }}
                  content={({ active, payload }: { active?: boolean; payload?: any[] }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className="bg-zinc-900 text-white p-3 rounded-xl shadow-xl text-xs font-bold">
                          <p className="mb-1 text-zinc-400 uppercase">{data.name}</p>
                          <p>
                            Sold: <span className="text-lime-400">{data.sold}</span> / {data.total}
                          </p>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Bar dataKey="sold" stackId="a" fill="#84cc16" radius={[4, 0, 0, 4]} />
                <Bar dataKey="remaining" stackId="a" fill="#f4f4f5" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            </ChartSuspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const OrdersView = ({ orders, isLoading }: { orders: Order[]; isLoading: boolean }) => {
  const { toast } = useToast();
  const [viewProofOrder, setViewProofOrder] = useState<Order | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [dealTypeFilter, setDealTypeFilter] = useState<string>('All');
  const [mediatorFilter, setMediatorFilter] = useState<string>('All');
  const [productFilter, setProductFilter] = useState<string>('All');
  const [orderViewMode, setOrderViewMode] = useState<'orders' | 'orderSheet' | 'financeSheet'>('orders');
  const [sheetsExporting, setSheetsExporting] = useState(false);
  const [ordersPage, setOrdersPage] = useState(1);
  const ORDERS_PER_PAGE = 25;

  const getOrderStatusBadge = (o: Order) => {
    const wf = String(o.workflowStatus || '').trim();
    const pay = String(o.paymentStatus || '').trim();
    const aff = String(o.affiliateStatus || '').trim();

    // Prefer workflow for "what stage is this order in?".
    const label = wf || aff || pay || 'Unknown';

    const isGood = pay === 'Paid' || wf === 'COMPLETED' || aff === 'Approved_Settled';
    const isBad = wf === 'REJECTED' || wf === 'FAILED' || aff === 'Rejected' || aff === 'Frozen_Disputed' || pay === 'Failed';
    const isAction = wf === 'UNDER_REVIEW' || wf === 'PROOF_SUBMITTED' || aff === 'Unchecked' || aff === 'Pending_Cooling';

    const cls = isGood
      ? 'bg-green-100 text-green-700'
      : isBad
        ? 'bg-red-100 text-red-700'
        : isAction
          ? 'bg-orange-100 text-orange-700'
          : 'bg-zinc-100 text-zinc-700';

    return (
      <span className={`px-3 py-1 text-[10px] font-bold rounded-full uppercase ${cls}`}>
        {label.replace(/_/g, ' ')}
      </span>
    );
  };

  // Sync viewProofOrder when parent orders update
  useEffect(() => {
    setViewProofOrder((prev) => {
      if (!prev) return prev;
      const updated = orders.find((o: Order) => o.id === prev.id);
      return updated || null;
    });
  }, [orders]);

  // Unique mediators and products for filter dropdowns
  const mediatorOptions = useMemo(() => {
    const codes = new Set<string>();
    orders.forEach((o) => {
      const label = o.managerName || (o as any).mediatorCode || '';
      if (label) codes.add(label);
    });
    return Array.from(codes).sort();
  }, [orders]);

  const productOptions = useMemo(() => {
    const titles = new Set<string>();
    orders.forEach((o) => {
      const t = o.items?.[0]?.title || '';
      if (t) titles.add(t);
    });
    return Array.from(titles).sort();
  }, [orders]);

  const filtered = useMemo(() => orders.filter((o) => {
    const q = search.toLowerCase();
    const title = String(o.items?.[0]?.title || '').toLowerCase();
    const internal = String(o.id || '').toLowerCase();
    const external = String(o.externalOrderId || '').toLowerCase();
    const textMatch = internal.includes(q) || external.includes(q) || title.includes(q);
    if (statusFilter !== 'All') {
      const st = String(o.affiliateStatus === 'Unchecked' ? o.paymentStatus : o.affiliateStatus || '').toLowerCase();
      if (st !== statusFilter.toLowerCase()) return false;
    }
    if (dealTypeFilter !== 'All') {
      const dt = o.dealType || o.items?.[0]?.dealType || 'Discount';
      if (dt !== dealTypeFilter) return false;
    }
    if (mediatorFilter !== 'All') {
      const label = o.managerName || (o as any).mediatorCode || '';
      if (label !== mediatorFilter) return false;
    }
    if (productFilter !== 'All') {
      const t = o.items?.[0]?.title || '';
      if (t !== productFilter) return false;
    }
    return textMatch;
  }), [orders, search, statusFilter, dealTypeFilter, mediatorFilter, productFilter]);

  // Reset page when filters change
  useEffect(() => { setOrdersPage(1); }, [search, statusFilter, dealTypeFilter, mediatorFilter, productFilter]);

  const totalOrderPages = Math.max(1, Math.ceil(filtered.length / ORDERS_PER_PAGE));
  const paginatedOrders = filtered.slice((ordersPage - 1) * ORDERS_PER_PAGE, ordersPage * ORDERS_PER_PAGE);

  const handleExport = async () => {
    if (filtered.length === 0) { toast.info('No orders to export'); return; }
    const apiBase = getDirectBackendUrl();

    // Fetch signed proof tokens so Excel/Sheets can open proof images without auth
    let proofTokens: Record<string, Record<string, string | null>> = {};
    try {
      proofTokens = await api.orders.batchProofUrls(filtered.map(o => o.id));
    } catch {
      // Fallback: use old auth-required URLs if batch fails
    }

    const buildSignedProofUrl = (orderId: string, type: string) => {
      const token = proofTokens[orderId]?.[type];
      if (token) return `${apiBase}/orders/proof/signed/${token}`;
      return `${apiBase}/orders/${encodeURIComponent(orderId)}/proof/${type}`;
    };

    // csvSafe imported from shared/utils/csvHelpers
    const csvEscape = (val: string) => `"${val.replace(/"/g, '""')}"`;
    const hyperlinkYes = (url?: string) =>
      url ? csvEscape(`=HYPERLINK("${url}","Yes")`) : 'No';

    // Build filter summary for metadata
    const activeFilters: string[] = [];
    if (statusFilter !== 'All') activeFilters.push(`Status: ${statusFilter}`);
    if (dealTypeFilter !== 'All') activeFilters.push(`Deal Type: ${dealTypeFilter}`);
    if (mediatorFilter !== 'All') activeFilters.push(`Mediator: ${mediatorFilter}`);
    if (productFilter !== 'All') activeFilters.push(`Product: ${productFilter}`);
    if (search) activeFilters.push(`Search: ${search}`);

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
    csvRows.push(`"Brand Orders Report - ${new Date().toLocaleDateString('en-GB')}","Generated: ${new Date().toLocaleString('en-GB')}","Total Orders: ${filtered.length}","${activeFilters.length ? 'Filters: ' + activeFilters.join(' | ') : 'Filters: None'}"`);
    csvRows.push(''); // blank separator row
    csvRows.push(headers.join(','));

    let totalValue = 0;
    let totalCommission = 0;

    filtered.forEach((o) => {
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
        csvSafe(o.brandName || item?.brandName || ''),
        csvSafe(item?.platform || ''),
        csvSafe(item?.dealType || 'Discount'),
        item?.priceAtPurchase,
        item?.quantity || 1,
        o.total,
        item?.commission || 0,
        (o as any).expectedSettlementDate ? new Date((o as any).expectedSettlementDate).toLocaleDateString('en-GB') : '',
        csvSafe(o.agencyName || 'Direct'),
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
        o.screenshots?.order ? hyperlinkYes(buildSignedProofUrl(o.id, 'order')) : 'No',
        o.screenshots?.payment ? hyperlinkYes(buildSignedProofUrl(o.id, 'payment')) : 'No',
        o.screenshots?.rating ? hyperlinkYes(buildSignedProofUrl(o.id, 'rating')) : 'No',
        (o.reviewLink || o.screenshots?.review)
          ? hyperlinkYes(buildSignedProofUrl(o.id, 'review'))
          : 'No',
        o.screenshots?.returnWindow
          ? hyperlinkYes(buildSignedProofUrl(o.id, 'returnWindow'))
          : 'No',
      ];
      csvRows.push(row.join(','));
    });

    // Totals row
    csvRows.push('');
    csvRows.push(`"TOTALS","","","","","","","","",${totalValue.toFixed(2)},${totalCommission.toFixed(2)},"","","","","","","","","","","","","","","","","","","",""`);

    const filterSlug = activeFilters.length ? '_filtered' : '';
    const csvString = csvRows.join('\n');
    downloadCsv(`brand_orders_report_${new Date().toISOString().slice(0, 10)}${filterSlug}.csv`, csvString);
  };

  const handleExportToSheets = () => {
    if (!filtered.length) { toast.info('No orders to export'); return; }
    const sheetHeaders = ['Order ID','Date','Time','Product','Platform','Deal Type','Unit Price','Quantity','Total Value','Commission (₹)','Settlement Date','Agency Name','Mediator Name','Mediator Code','Buyer Name','Buyer Mobile','Reviewer Name','Workflow Status','Payment Status','Verification Status','Internal Ref','Sold By','Order Date','Extracted Product','UTR/Reference','Payment Mode'];
    const sheetRows = filtered.map((o) => {
      const dateObj = new Date(o.createdAt);
      const item = o.items?.[0];
      return [
        getPrimaryOrderId(o),
        dateObj.toLocaleDateString('en-GB'),
        dateObj.toLocaleTimeString('en-GB'),
        item?.title || '',
        item?.platform || '',
        item?.dealType || 'Discount',
        item?.priceAtPurchase ?? 0,
        item?.quantity || 1,
        o.total,
        item?.commission || 0,
        (o as any).expectedSettlementDate ? new Date((o as any).expectedSettlementDate).toLocaleDateString('en-GB') : '',
        o.agencyName || 'Direct',
        o.managerName || '',
        o.mediatorCode || (o as any).managerCode || '',
        o.buyerName || '',
        o.buyerMobile || '',
        o.reviewerName || '',
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
    import('../utils/exportToSheets').then(({ exportToGoogleSheet }) => exportToGoogleSheet({
      title: `Brand Orders Report - ${new Date().toISOString().slice(0, 10)}`,
      headers: sheetHeaders,
      rows: sheetRows,
      sheetName: 'Orders',
      onStart: () => setSheetsExporting(true),
      onEnd: () => setSheetsExporting(false),
      onSuccess: () => toast.success('Exported to Google Sheets!'),
      onError: (msg) => toast.error(typeof msg === 'string' ? msg : 'Google Sheets export failed. Please try again.'),
    }));
  };

  return (
    <>
      <div className="max-w-7xl mx-auto animate-enter pb-12 px-2">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <h2 className="text-3xl font-extrabold text-zinc-900 shrink-0">Order Intelligence</h2>
          <div className="flex flex-wrap gap-3 w-full md:w-auto">
            <div className="relative group flex-1 min-w-[200px] md:w-80">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <Search
                  size={18}
                  className="text-zinc-400 group-focus-within:text-zinc-900 transition-colors"
                />
              </div>
              <input
                type="text"
                placeholder="Search Orders..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-12 pr-10 py-3.5 bg-white border border-zinc-200 rounded-2xl text-sm font-bold outline-none focus:border-zinc-900 focus:ring-4 focus:ring-zinc-100 transition-all shadow-sm placeholder:text-zinc-400 text-zinc-900"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-900 transition-colors"
                >
                  <XCircle size={16} />
                </button>
              )}
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by order status"
              className="px-4 py-3.5 bg-white border border-zinc-200 rounded-2xl text-sm font-bold outline-none focus:border-zinc-900 focus:ring-4 focus:ring-zinc-100 transition-all shadow-sm text-zinc-900"
            >
              <option value="All">All Statuses</option>
              <option value="Pending">Pending</option>
              <option value="Pending_Cooling">Cooling</option>
              <option value="Approved_Settled">Settled</option>
              <option value="Paid">Paid</option>
            </select>
            <select
              value={dealTypeFilter}
              onChange={(e) => setDealTypeFilter(e.target.value)}
              aria-label="Filter by deal type"
              className="px-4 py-3.5 bg-white border border-zinc-200 rounded-2xl text-sm font-bold outline-none focus:border-zinc-900 focus:ring-4 focus:ring-zinc-100 transition-all shadow-sm text-zinc-900"
            >
              <option value="All">All Deal Types</option>
              <option value="Discount">Order Deal</option>
              <option value="Rating">Rating Deal</option>
              <option value="Review">Review Deal</option>
            </select>
            <select
              value={mediatorFilter}
              onChange={(e) => setMediatorFilter(e.target.value)}
              aria-label="Filter by mediator"
              className="px-4 py-3.5 bg-white border border-zinc-200 rounded-2xl text-sm font-bold outline-none focus:border-zinc-900 focus:ring-4 focus:ring-zinc-100 transition-all shadow-sm text-zinc-900 max-w-[160px]"
            >
              <option value="All">All Mediators</option>
              {mediatorOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              aria-label="Filter by product"
              className="px-4 py-3.5 bg-white border border-zinc-200 rounded-2xl text-sm font-bold outline-none focus:border-zinc-900 focus:ring-4 focus:ring-zinc-100 transition-all shadow-sm text-zinc-900 max-w-[200px] truncate"
            >
              <option value="All">All Products</option>
              {productOptions.map((p) => (
                <option key={p} value={p}>{p.length > 30 ? p.slice(0, 30) + '…' : p}</option>
              ))}
            </select>
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-5 py-3.5 bg-zinc-900 text-white rounded-2xl font-bold text-sm shadow-lg hover:bg-black transition-all active:scale-95 whitespace-nowrap"
            >
              <Download size={18} /> <span className="hidden md:inline">CSV</span>
            </button>
            <button
              onClick={handleExportToSheets}
              disabled={sheetsExporting}
              className="flex items-center gap-2 px-5 py-3.5 bg-green-600 text-white rounded-2xl font-bold text-sm shadow-lg hover:bg-green-700 transition-all active:scale-95 whitespace-nowrap disabled:opacity-50"
            >
              <FileSpreadsheet size={18} /> <span className="hidden md:inline">{sheetsExporting ? 'Exporting...' : 'Google Sheets'}</span>
            </button>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div className="flex gap-2 mb-6">
          {(['orders', 'orderSheet', 'financeSheet'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setOrderViewMode(mode)}
              className={`px-5 py-2.5 rounded-xl text-xs font-extrabold uppercase tracking-wider transition-all ${
                orderViewMode === mode
                  ? 'bg-zinc-900 text-white shadow-lg'
                  : 'bg-white text-zinc-400 border border-zinc-200 hover:border-zinc-400'
              }`}
            >
              {mode === 'orders' ? 'Orders' : mode === 'orderSheet' ? 'Order Sheet' : 'Finance Sheet'}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-[2.5rem] border border-zinc-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto scrollbar-styled">

            {/* === ORDERS VIEW (default) === */}
            {orderViewMode === 'orders' && (
            <table className="w-full text-left min-w-[800px]">
              <thead className="bg-zinc-50 text-zinc-400 text-xs font-bold uppercase tracking-wider">
                <tr>
                  <th className="p-6">Order ID</th>
                  <th className="p-6">Product</th>
                  <th className="p-6">Agency</th>
                  <th className="p-6">Partner</th>
                  <th className="p-6 text-right">Value</th>
                  <th className="p-6 text-right">Status</th>
                  <th className="p-6 text-right">Proof</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="p-8">
                      <EmptyState
                        title="Loading orders"
                        description="Fetching the latest orders"
                        icon={<Spinner className="w-6 h-6 text-zinc-400" />}
                        className="bg-transparent"
                      />
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8">
                      <EmptyState
                        title="No orders"
                        description={search ? 'Try a different search term.' : 'Orders will appear here once customers place them.'}
                        icon={<ShoppingBag size={22} className="text-zinc-400" />}
                        className="bg-transparent"
                      />
                    </td>
                  </tr>
                ) : (
                  paginatedOrders.map((o) => (
                    <tr key={o.id} className="hover:bg-zinc-50/50 transition-colors group">
                      <td className="p-6">
                        <div className="font-mono text-xs font-bold text-zinc-500">
                          {getPrimaryOrderId(o)}
                        </div>
                      </td>
                      <td className="p-6">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-white rounded-lg border border-zinc-100 p-1 flex-shrink-0">
                            <ProxiedImage
                              src={o.items?.[0]?.image}
                              alt={o.items?.[0]?.title || 'Order item'}
                              className="w-full h-full object-contain mix-blend-multiply"
                            />
                          </div>
                          <span className="text-sm font-bold text-zinc-900 line-clamp-1">
                            {o.items?.[0]?.title || 'Unknown'}
                          </span>
                        </div>
                      </td>
                      <td className="p-6">
                        <span className="text-xs font-bold bg-zinc-100 text-zinc-600 px-2 py-1 rounded">
                          {o.agencyName || 'Direct'}
                        </span>
                      </td>
                      <td className="p-6 text-sm text-zinc-700">
                        <div className="text-xs font-bold text-zinc-700">{o.managerName || '-'}</div>
                        {o.mediatorCode && o.mediatorCode !== o.managerName && (
                          <div className="text-[9px] text-zinc-400 font-mono">{o.mediatorCode}</div>
                        )}
                      </td>
                      <td className="p-6 text-right font-bold text-zinc-900">{formatCurrency(o.total)}</td>
                      <td className="p-6 text-right">
                        {getOrderStatusBadge(o)}
                      </td>
                      <td className="p-6 text-right">
                        {o.screenshots?.payment || o.screenshots?.order ? (
                          <button
                            onClick={() => setViewProofOrder(o)}
                            aria-label="View order proof"
                            className="w-8 h-8 bg-white border border-zinc-200 rounded-lg flex items-center justify-center text-zinc-400 hover:text-black hover:border-black transition-colors ml-auto"
                          >
                            <Eye size={14} />
                          </button>
                        ) : (
                          <span className="text-zinc-200">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            )}

            {/* === ORDER SHEET VIEW === */}
            {orderViewMode === 'orderSheet' && (
              filtered.length === 0 ? (
                <div className="p-8">
                  <EmptyState
                    title="No orders"
                    description={search ? 'Try a different search term.' : 'Orders will appear here once customers place them.'}
                    icon={<ShoppingBag size={22} className="text-zinc-400" />}
                    className="bg-transparent"
                  />
                </div>
              ) : (
                <table className="w-full text-left min-w-[800px]">
                  <thead className="bg-zinc-50 text-zinc-400 text-xs font-bold uppercase tracking-wider">
                    <tr>
                      <th className="p-6">Order ID</th>
                      <th className="p-6">Date</th>
                      <th className="p-6">Agency</th>
                      <th className="p-6">Mediator</th>
                      <th className="p-6">Product</th>
                      <th className="p-6 text-right">Amount</th>
                      <th className="p-6 text-right">Commission</th>
                      <th className="p-6 text-right">Deal Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {paginatedOrders.map((o) => (
                      <tr key={o.id} className="hover:bg-zinc-50/50 transition-colors">
                        <td className="p-6">
                          <span className="font-mono text-xs font-bold text-zinc-500">{getPrimaryOrderId(o)}</span>
                        </td>
                        <td className="p-6">
                          <span className="text-xs text-zinc-500">{new Date(o.createdAt).toLocaleDateString('en-GB')}</span>
                        </td>
                        <td className="p-6">
                          <span className="text-xs font-bold bg-zinc-100 text-zinc-600 px-2 py-1 rounded">{o.agencyName || 'Direct'}</span>
                        </td>
                        <td className="p-6">
                          <div className="text-xs font-bold text-zinc-700">{o.managerName || '-'}</div>
                          {o.mediatorCode && o.mediatorCode !== o.managerName && (
                            <div className="text-[9px] text-zinc-400 font-mono">{o.mediatorCode}</div>
                          )}
                        </td>
                        <td className="p-6">
                          <span className="text-sm font-bold text-zinc-900 line-clamp-1">{o.items?.[0]?.title || 'Product'}</span>
                          <div className="text-[9px] text-zinc-400">Qty: {o.items?.[0]?.quantity || 1}</div>
                        </td>
                        <td className="p-6 text-right font-bold text-zinc-900">{formatCurrency(o.total)}</td>
                        <td className="p-6 text-right font-mono font-bold text-green-600">{formatCurrency(o.commission || 0)}</td>
                        <td className="p-6 text-right">
                          <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${
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
            {orderViewMode === 'financeSheet' && (
              filtered.length === 0 ? (
                <div className="p-8">
                  <EmptyState
                    title="No finance records"
                    description={search ? 'Try a different search term.' : 'Finance records will appear here once orders are placed.'}
                    icon={<Wallet size={22} className="text-zinc-400" />}
                    className="bg-transparent"
                  />
                </div>
              ) : (
                <table className="w-full text-left min-w-[900px]">
                  <thead className="bg-zinc-50 text-zinc-400 text-xs font-bold uppercase tracking-wider">
                    <tr>
                      <th className="p-6 w-12">S.No</th>
                      <th className="p-6">Agency</th>
                      <th className="p-6">Mediator</th>
                      <th className="p-6">Product</th>
                      <th className="p-6 text-center">Slots</th>
                      <th className="p-6 text-right">Order Value</th>
                      <th className="p-6 text-right">Amount Payable</th>
                      <th className="p-6 text-right">Deal Type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {paginatedOrders.map((o, i) => (
                      <tr key={o.id} className="hover:bg-zinc-50/50 transition-colors">
                        <td className="p-6 text-xs font-mono text-zinc-400">{(ordersPage - 1) * ORDERS_PER_PAGE + i + 1}</td>
                        <td className="p-6">
                          <span className="text-xs font-bold text-zinc-700">{o.agencyName || 'Direct'}</span>
                        </td>
                        <td className="p-6">
                          <div className="text-xs font-bold text-zinc-700">{o.managerName || '-'}</div>
                          {o.mediatorCode && o.mediatorCode !== o.managerName && (
                            <div className="text-[9px] text-zinc-400 font-mono">{o.mediatorCode}</div>
                          )}
                        </td>
                        <td className="p-6">
                          <span className="text-sm font-bold text-zinc-900 line-clamp-1">{o.items?.[0]?.title || 'Product'}</span>
                        </td>
                        <td className="p-6 text-center">
                          <span className="text-xs font-bold text-zinc-600">{o.items?.[0]?.quantity || 1}</span>
                        </td>
                        <td className="p-6 text-right font-bold text-zinc-900">{formatCurrency(o.total)}</td>
                        <td className="p-6 text-right font-mono font-bold text-green-600">{formatCurrency(o.commission || 0)}</td>
                        <td className="p-6 text-right">
                          <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${
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
                  {/* Gross Total Footer */}
                  <tfoot>
                    <tr className="bg-zinc-50 border-t-2 border-zinc-200">
                      <td colSpan={5} className="p-6 text-xs font-extrabold text-zinc-700 uppercase">Total Payable</td>
                      <td className="p-6 text-right font-mono font-extrabold text-zinc-900">{formatCurrency(filtered.reduce((s, o) => s + (o.total || 0), 0))}</td>
                      <td className="p-6 text-right font-mono font-extrabold text-lg text-green-600">{formatCurrency(filtered.reduce((s, o) => s + (o.commission || 0), 0))}</td>
                      <td className="p-6"></td>
                    </tr>
                  </tfoot>
                </table>
              )
            )}
          </div>
        </div>
      </div>

      {/* Pagination */}
      {totalOrderPages > 1 && (
        <Pagination
          page={ordersPage}
          totalPages={totalOrderPages}
          total={filtered.length}
          limit={ORDERS_PER_PAGE}
          onPageChange={(p) => { setOrdersPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        />
      )}

      {viewProofOrder && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-enter"
          onClick={() => { setViewProofOrder(null); }}
        >
          <div
            className="bg-white w-full max-w-lg rounded-[2rem] p-6 shadow-2xl relative flex flex-col max-h-[90dvh] animate-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close proof modal"
              onClick={() => { setViewProofOrder(null); }}
              className="absolute top-4 right-4 p-2 bg-zinc-50 rounded-full hover:bg-zinc-100 transition-colors"
            >
              <X size={18} />
            </button>

            <div className="mb-6">
              <h3 className="font-extrabold text-lg text-zinc-900 mb-1">Proof of Performance</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 font-bold">
                  Order {getPrimaryOrderId(viewProofOrder)}
                </span>
                <span className="w-1 h-1 bg-zinc-300 rounded-full"></span>
                <span
                  className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${
                    viewProofOrder.items?.[0]?.dealType === 'Rating'
                      ? 'bg-orange-50 text-orange-600 border-orange-100'
                      : viewProofOrder.items?.[0]?.dealType === 'Review'
                        ? 'bg-purple-50 text-purple-600 border-purple-100'
                        : 'bg-blue-50 text-blue-600 border-blue-100'
                  }`}
                >
                  {viewProofOrder.items?.[0]?.dealType || 'Discount'} Deal
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-styled space-y-6 pr-2">
              {/* Product Summary */}
              <div className="flex gap-4 p-4 bg-zinc-50 rounded-2xl border border-zinc-100">
                <ProxiedImage
                  src={viewProofOrder.items?.[0]?.image}
                  alt={viewProofOrder.items?.[0]?.title || 'Product'}
                  className="w-14 h-14 object-contain mix-blend-multiply rounded-xl bg-white border border-zinc-100 p-1"
                />
                <div>
                  <p className="text-sm font-bold text-zinc-900 line-clamp-1">
                    {viewProofOrder.items?.[0]?.title}
                  </p>
                  <p className="text-xs text-zinc-500 mt-1">
                    Value:{' '}
                    <span className="font-mono font-bold text-zinc-900">
                      {formatCurrency(viewProofOrder.total)}
                    </span>
                  </p>
                  {(() => {
                    const seller = viewProofOrder.soldBy && viewProofOrder.soldBy !== 'null' && viewProofOrder.soldBy !== 'undefined' ? viewProofOrder.soldBy : '';
                    const d = viewProofOrder.orderDate ? new Date(viewProofOrder.orderDate) : null;
                    const validDate = d && !isNaN(d.getTime()) && d.getFullYear() > 2020 ? d : null;
                    return (viewProofOrder.extractedProductName || seller || validDate || viewProofOrder.reviewerName) ? (
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-zinc-400">
                        {viewProofOrder.reviewerName && <span className="text-indigo-500 font-bold">Reviewer: {viewProofOrder.reviewerName}</span>}
                        {viewProofOrder.extractedProductName && <span>Product: {viewProofOrder.extractedProductName}</span>}
                        {seller && <span>Seller: {seller}</span>}
                        {validDate && <span>Ordered: {validDate.toLocaleDateString('en-GB')}</span>}
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
              {/* Settlement details */}
              {(viewProofOrder.settlementRef || viewProofOrder.settlementMode) && (
                <div className="flex flex-wrap gap-4 p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                  {viewProofOrder.settlementRef && <div><span className="text-[10px] font-bold text-emerald-500 uppercase">UTR / Reference</span><p className="text-xs font-mono font-bold text-emerald-800">{viewProofOrder.settlementRef}</p></div>}
                  {viewProofOrder.settlementMode && <div><span className="text-[10px] font-bold text-emerald-500 uppercase">Payment Mode</span><p className="text-xs font-bold text-emerald-800 uppercase">{viewProofOrder.settlementMode}</p></div>}
                </div>
              )}

              {/* 1. Mandatory Order Screenshot */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-extrabold text-zinc-400 uppercase tracking-widest">
                  <FileText size={14} /> Purchase Proof
                </div>
                {viewProofOrder.screenshots?.order ? (
                  <>
                    <div className="rounded-2xl border-2 border-zinc-100 overflow-hidden shadow-sm">
                      <ProofImage
                        orderId={viewProofOrder.id}
                        proofType="order"
                        existingSrc={viewProofOrder.screenshots.order !== 'exists' ? viewProofOrder.screenshots.order : undefined}
                        alt="Order Proof"
                        className="w-full h-auto block"
                      />
                    </div>
                    {/* AI Verification — stored from buyer's proof submission */}
                    {viewProofOrder.orderAiVerification && (
                    <div className="bg-indigo-50 p-3 rounded-xl border border-indigo-200 mt-2">
                      <div className="flex justify-between items-center mb-2">
                        <h5 className="font-bold text-indigo-600 flex items-center gap-1.5 text-[10px] uppercase tracking-widest">
                          <Sparkles size={12} className="text-indigo-500" /> AI Verification
                        </h5>
                      </div>
                        <div className="space-y-2">
                          {(() => {
                            const aiData = viewProofOrder.orderAiVerification;
                            const n = Number(aiData?.confidenceScore);
                            const score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
                            return (
                              <>
                                <div className="flex gap-2">
                                  <div className={`flex-1 p-2 rounded-lg border text-center ${aiData?.orderIdMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                                    <p className="text-[9px] font-bold text-zinc-400 uppercase">Order ID</p>
                                    <p className={`text-xs font-bold ${aiData?.orderIdMatch ? 'text-green-600' : 'text-red-600'}`}>
                                      {aiData?.orderIdMatch ? '✓ Match' : '✗ Mismatch'}
                                    </p>
                                    {aiData?.detectedOrderId && <p className="text-[9px] text-zinc-500 font-mono mt-0.5">Detected: {aiData.detectedOrderId}</p>}
                                  </div>
                                  <div className={`flex-1 p-2 rounded-lg border text-center ${aiData?.amountMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                                    <p className="text-[9px] font-bold text-zinc-400 uppercase">Amount</p>
                                    <p className={`text-xs font-bold ${aiData?.amountMatch ? 'text-green-600' : 'text-red-600'}`}>
                                      {aiData?.amountMatch ? '✓ Match' : '✗ Mismatch'}
                                    </p>
                                    {aiData?.detectedAmount != null && <p className="text-[9px] text-zinc-500 font-mono mt-0.5">Detected: {formatCurrency(aiData.detectedAmount)}</p>}
                                  </div>
                                </div>
                                {aiData?.discrepancyNote && (
                                  <p className="text-[10px] text-zinc-500 bg-white rounded-lg p-2 border border-zinc-100">{aiData.discrepancyNote}</p>
                                )}
                                <div className="flex justify-between items-center pt-1">
                                  <span className="text-[9px] text-indigo-500 font-bold uppercase">Confidence</span>
                                  <div className="flex items-center gap-2">
                                    <div className="w-20 h-1.5 bg-zinc-200 rounded-full overflow-hidden">
                                      <div className={`h-full rounded-full ${score > 80 ? 'bg-green-500' : score > 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${score}%` }} />
                                    </div>
                                    <span className="text-xs font-bold text-zinc-700">{score}%</span>
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
              {viewProofOrder.items?.[0]?.dealType === 'Rating' && (
                <div className="space-y-2 animate-slide-up">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-orange-400 uppercase tracking-widest">
                    <Star size={14} /> Rating Proof
                  </div>
                  {viewProofOrder.screenshots?.rating ? (
                    <div className="rounded-2xl border-2 border-orange-100 overflow-hidden shadow-sm relative">
                      <div className="absolute top-2 right-2 bg-orange-500 text-white text-[9px] font-bold px-2 py-1 rounded-lg">
                        5 Stars
                      </div>
                      <ProofImage
                        orderId={viewProofOrder.id}
                        proofType="rating"
                        existingSrc={viewProofOrder.screenshots.rating !== 'exists' ? viewProofOrder.screenshots.rating : undefined}
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
                  {viewProofOrder.ratingAiVerification && (
                    <RatingVerificationBadge
                      data={viewProofOrder.ratingAiVerification}
                      className="mt-2 bg-orange-50 rounded-xl border border-orange-100 p-3 space-y-1.5"
                    />
                  )}
                </div>
              )}

              {/* 3. Review Link (Conditional) */}
              {viewProofOrder.items?.[0]?.dealType === 'Review' && (
                <div className="space-y-2 animate-slide-up">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-purple-400 uppercase tracking-widest">
                    <MessageCircle size={14} /> Live Review
                  </div>
                  {viewProofOrder.reviewLink ? (
                    <a
                      href={viewProofOrder.reviewLink}
                      target="_blank" rel="noreferrer"
                      className="flex items-center justify-between p-4 bg-purple-50 text-purple-700 rounded-2xl font-bold text-xs border border-purple-100 hover:bg-purple-100 transition-colors group"
                    >
                      <span className="truncate flex-1 mr-2">{viewProofOrder.reviewLink}</span>
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
              {viewProofOrder.screenshots?.returnWindow && (
                <div className="space-y-2 animate-slide-up">
                  <div className="flex items-center gap-2 text-xs font-extrabold text-teal-500 uppercase tracking-widest">
                    <Package size={14} /> Return Window
                  </div>
                  <div className="rounded-2xl border-2 border-teal-100 overflow-hidden shadow-sm">
                    <ProofImage
                      orderId={viewProofOrder.id}
                      proofType="returnWindow"
                      existingSrc={viewProofOrder.screenshots.returnWindow !== 'exists' ? viewProofOrder.screenshots.returnWindow : undefined}
                      className="w-full h-auto max-h-[60dvh] object-contain bg-zinc-50"
                      alt="Return Window proof"
                    />
                  </div>
                  {/* AI Return Window Verification */}
                  {viewProofOrder.returnWindowAiVerification && (
                    <ReturnWindowVerificationBadge
                      data={viewProofOrder.returnWindowAiVerification}
                      className="mt-2 bg-teal-50 rounded-xl border border-teal-100 p-3 space-y-1.5"
                    />
                  )}
                </div>
              )}

              {/* 5. Payment Proof (Optional/Generic) */}
              {viewProofOrder.screenshots?.payment &&
                viewProofOrder.screenshots.payment !== 'verified' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-extrabold text-zinc-400 uppercase tracking-widest">
                      <CreditCard size={14} /> Payment Confirmation
                    </div>
                    <div className="rounded-2xl border-2 border-zinc-100 overflow-hidden shadow-sm">
                      <ProofImage
                        orderId={viewProofOrder.id}
                        proofType="payment"
                        existingSrc={viewProofOrder.screenshots.payment !== 'exists' ? viewProofOrder.screenshots.payment : undefined}
                        alt="Payment Proof"
                        className="w-full h-auto block"
                      />
                    </div>
                  </div>
                )}
            </div>

            <div className="pt-4 mt-2 border-t border-zinc-100">
              <button
                onClick={() => { setViewProofOrder(null); }}
                className="w-full py-3 bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-black transition-colors shadow-lg"
              >
                Close Viewer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const CampaignsView = ({ campaigns, agencies, user, loading, onRefresh }: any) => {
  const { toast } = useToast();
  const { confirm, ConfirmDialogElement } = useConfirm();
  const [view, setView] = useState<'list' | 'create'>('list');
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [filterDealType, setFilterDealType] = useState<string>('All');
  const [filterDateFrom, setFilterDateFrom] = useState<string>('');
  const [filterDateTo, setFilterDateTo] = useState<string>('');

  const filteredCampaigns = useMemo(() => {
    let result = campaigns as Campaign[];
    if (campaignSearch.trim()) {
      const q = campaignSearch.trim().toLowerCase();
      result = result.filter((c: Campaign) =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.platform || '').toLowerCase().includes(q)
      );
    }
    if (filterDealType !== 'All') {
      result = result.filter((c: Campaign) => (c.dealType || 'Discount') === filterDealType);
    }
    if (filterDateFrom) {
      const from = new Date(filterDateFrom).getTime();
      result = result.filter((c: Campaign) => (c.createdAt || 0) >= from);
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo).getTime() + 86400000;
      result = result.filter((c: Campaign) => (c.createdAt || 0) < to);
    }
    return result;
  }, [campaigns, campaignSearch, filterDealType, filterDateFrom, filterDateTo]);

  // Create Form State
  const initialForm = {
    title: '',
    platform: '',
    price: '',
    payout: '',
    totalSlots: '',
    originalPrice: '',
    image: '',
    productUrl: '',
    dealType: '',
  };
  const [form, setForm] = useState(initialForm);
  const [selAgencies, setSelAgencies] = useState<string[]>([]);

  const handleCreate = async (e: any) => {
    e.preventDefault();
    const price = Number(form.price);
    const payout = Number(form.payout);
    const totalSlots = Number(form.totalSlots);
    const originalPrice = Number(form.originalPrice);

    if (!form.title.trim()) { toast.error('Title is required'); return; }
    if (!Number.isFinite(price) || price < 0) { toast.error('Deal price must be 0 or more'); return; }
    if (!Number.isFinite(originalPrice) || originalPrice < 0) { toast.error('Original price must be 0 or more'); return; }
    if (!Number.isFinite(payout) || payout < 0) { toast.error('Payout must be 0 or more'); return; }
    if (form.dealType !== 'Review' && form.dealType !== 'Rating' && payout > price) { toast.error('Payout cannot exceed price'); return; }
    if (!Number.isFinite(totalSlots) || totalSlots < 1) { toast.error('Total slots must be at least 1'); return; }

    try {
      const payload = {
        ...form,
        brand: user.name,
        brandId: user.id,
        price,
        originalPrice,
        payout,
        totalSlots,
        allowedAgencies: selAgencies,
        dealType: form.dealType || undefined,
      };

      if (isEditing && editingId) {
        await api.brand.updateCampaign(editingId, payload);
      } else {
        await api.brand.createCampaign(payload);
      }

      setView('list');
      setIsEditing(false);
      setEditingId(null);
      setForm(initialForm);
      onRefresh(['campaigns']);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') console.error('Failed to save campaign:', err);
      toast.error(formatErrorMessage(err, 'Failed to save campaign'));
    }
  };

  const handleEdit = (campaign: Campaign) => {
    setForm({
      title: campaign.title,
      platform: campaign.platform,
      price: campaign.price.toString(),
      payout: campaign.payout.toString(),
      totalSlots: campaign.totalSlots.toString(),
      originalPrice: campaign.originalPrice.toString(),
      image: campaign.image,
      productUrl: campaign.productUrl,
      dealType: campaign.dealType || '',
    });
    setSelAgencies(campaign.allowedAgencies || []);
    setIsEditing(true);
    setEditingId(campaign.id);
    setView('create');
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
      await api.brand.updateCampaign(campaign.id, { status: next });
      toast.success(next === 'paused' ? 'Campaign paused' : 'Campaign resumed');
      onRefresh(['campaigns']);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') console.error('Failed to update campaign status:', err);
      toast.error(formatErrorMessage(err, 'Failed to update campaign status'));
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const handleDelete = async (campaign: Campaign) => {
    const confirmed = await confirm({ message: 'Delete this campaign? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!confirmed) return;
    setDeletingId(campaign.id);
    try {
      await api.brand.deleteCampaign(campaign.id);
      toast.success('Campaign deleted');
      onRefresh(['campaigns']);
    } catch (err: any) {
      toast.error(formatErrorMessage(err, 'Failed to delete campaign'));
    } finally {
      setDeletingId(null);
    }
  };

  if (view === 'create')
    return (
      <div className="max-w-7xl mx-auto animate-slide-up h-full flex flex-col">
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => {
              setView('list');
              setIsEditing(false);
              setEditingId(null);
              setForm(initialForm);
            }}
            aria-label="Back to campaigns"
            className="w-12 h-12 rounded-full bg-white border border-zinc-200 flex items-center justify-center hover:bg-zinc-50 transition-colors"
          >
            <ChevronRight className="rotate-180" size={20} />
          </button>
          <h1 className="text-3xl font-extrabold text-zinc-900">
            {isEditing ? 'Edit Campaign' : 'Launch New Campaign'}
          </h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 flex-1 overflow-y-auto scrollbar-styled">
          {/* FORM COLUMN */}
          <div className="lg:col-span-2 bg-white p-10 rounded-[2.5rem] shadow-xl border border-zinc-100">
            <form onSubmit={handleCreate} className="space-y-10">
              {/* Section 1 */}
              <div>
                <h3 className="text-lg font-bold text-zinc-900 mb-6 flex items-center gap-2">
                  <span className="w-8 h-8 rounded-full bg-zinc-900 text-white flex items-center justify-center text-sm">
                    1
                  </span>
                  Deal Details
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="md:col-span-2">
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Product Title
                    </label>
                    <input
                      type="text"
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 focus:ring-2 focus:ring-lime-400 outline-none"
                      placeholder="e.g. Nike Air Jordan 1 Low"
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Platform
                    </label>
                    <select
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 focus:ring-2 focus:ring-lime-400 outline-none"
                      value={form.platform}
                      onChange={(e) => setForm({ ...form, platform: e.target.value })}
                      required
                    >
                      <option value="">Select Platform</option>
                      <option value="Amazon">Amazon</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Total Units
                    </label>
                    <input
                      type="number"
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none"
                      placeholder="1000"
                      value={form.totalSlots}
                      onChange={(e) => setForm({ ...form, totalSlots: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Image URL
                    </label>
                    <input
                      type="url"
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none"
                      placeholder="https://..."
                      value={form.image}
                      onChange={(e) => setForm({ ...form, image: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Product Link
                    </label>
                    <input
                      type="url"
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none"
                      placeholder="https://amazon.in/..."
                      value={form.productUrl}
                      onChange={(e) => setForm({ ...form, productUrl: e.target.value })}
                      required
                    />
                  </div>
                </div>
              </div>

              {/* Section 2 */}
              <div>
                <h3 className="text-lg font-bold text-zinc-900 mb-6 flex items-center gap-2">
                  <span className="w-8 h-8 rounded-full bg-zinc-900 text-white flex items-center justify-center text-sm">
                    2
                  </span>
                  Financials
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Product Price (₹)
                    </label>
                    <input
                      type="number"
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none"
                      placeholder="2000"
                      value={form.originalPrice}
                      onChange={(e) => setForm({ ...form, originalPrice: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Deal Price (₹)
                    </label>
                    <input
                      type="number"
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none"
                      placeholder="1000"
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block whitespace-nowrap">
                      Agency Commission (₹)
                    </label>
                    <input
                      type="number"
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-900 outline-none"
                      placeholder="200"
                      value={form.payout}
                      onChange={(e) => setForm({ ...form, payout: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-zinc-400 uppercase ml-1 mb-2 block">
                      Enforce Deal Type
                    </label>
                    <select
                      className="w-full p-4 bg-zinc-50 border-none rounded-2xl font-bold text-zinc-500 focus:text-zinc-900 outline-none cursor-pointer appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem_1.25rem] bg-[right_1rem_center] bg-no-repeat"
                      value={form.dealType}
                      onChange={(e) => setForm({ ...form, dealType: e.target.value })}
                      aria-label="Enforce deal type"
                    >
                      <option value="">Flexible (Agency Decide)</option>
                      <option value="Discount">Discount Only</option>
                      <option value="Review">Review Required</option>
                      <option value="Rating">Rating Required</option>
                    </select>
                    <p className="text-[10px] text-zinc-400 mt-2 ml-1 font-medium italic">
                      Usually decided by agency partner.
                    </p>
                  </div>
                </div>
              </div>

              {/* Section 3 */}
              <div>
                <h3 className="text-lg font-bold text-zinc-900 mb-6 flex items-center gap-2">
                  <span className="w-8 h-8 rounded-full bg-zinc-900 text-white flex items-center justify-center text-sm">
                    3
                  </span>
                  Distribution
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {agencies.map((ag: User) => (
                    <button
                      type="button"
                      key={ag.id}
                      onClick={() => {
                        if (selAgencies.includes(ag.mediatorCode!))
                          setSelAgencies(selAgencies.filter((c: string) => c !== ag.mediatorCode));
                        else setSelAgencies([...selAgencies, ag.mediatorCode!]);
                      }}
                      className={`p-4 rounded-2xl font-bold text-sm text-left transition-all border-2 flex items-center justify-between ${
                        selAgencies.includes(ag.mediatorCode!)
                          ? 'bg-zinc-900 text-white border-zinc-900'
                          : 'bg-white text-zinc-500 border-zinc-100 hover:border-zinc-300'
                      }`}
                    >
                      <span>{ag.name}</span>
                      {selAgencies.includes(ag.mediatorCode!) && (
                        <CheckCircle size={16} className="text-lime-400" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <button className="w-full py-5 bg-lime-400 text-black font-extrabold rounded-2xl shadow-xl shadow-lime-400/20 hover:bg-lime-300 transition-all active:scale-[0.98] text-lg">
                {isEditing ? 'Update Campaign' : 'Launch Campaign'}
              </button>
            </form>
          </div>

          {/* PREVIEW COLUMN */}
          <div className="space-y-6">
            <h3 className="font-bold text-zinc-400 text-xs uppercase tracking-widest text-center">
              Live Preview
            </h3>

            {/* The Card Preview */}
            <div className="w-[320px] mx-auto bg-white rounded-[2rem] p-5 shadow-2xl border border-zinc-100 relative overflow-hidden">
              <div className="absolute top-4 right-4 bg-zinc-900 text-white text-[10px] font-bold px-2 py-1 rounded uppercase tracking-wider z-10">
                {form.platform || 'PLATFORM'}
              </div>

              <div className="flex gap-4 mb-4">
                <div className="w-24 h-24 rounded-2xl bg-zinc-50 p-2 flex-shrink-0 flex items-center justify-center border border-zinc-100">
                  {form.image ? (
                    <ProxiedImage
                      src={form.image}
                      alt={form.title || 'Campaign preview'}
                      className="w-full h-full object-contain mix-blend-multiply"
                    />
                  ) : (
                    <ImageIcon size={24} className="text-zinc-300" />
                  )}
                </div>
                <div className="flex-1 min-w-0 py-1">
                  <h3 className="font-bold text-zinc-900 text-sm leading-tight line-clamp-2 mb-2">
                    {form.title || 'Product Title'}
                  </h3>
                  <div className="flex items-center gap-1 mb-1">
                    <span className="text-[10px] font-bold text-zinc-400">(4.8)</span>
                  </div>
                  <p className="text-xl font-extrabold text-lime-600 leading-none">
                    {Number(form.price).toLocaleString('en-GB')}
                  </p>
                </div>
              </div>

              <div className="bg-zinc-50 rounded-xl p-3 mb-3 border border-zinc-100 relative font-mono text-[10px] text-zinc-500 leading-relaxed">
                <div className="mb-1">
                  <span className="text-indigo-600 font-bold">"{user.name}"</span> Direct Deal.
                </div>
                <div className="pt-2 border-t border-zinc-200 border-dashed flex justify-between items-center">
                  <span>Product Price:</span>
                  <span className="text-zinc-900 font-bold decoration-slice line-through">
                    {Number(form.originalPrice).toLocaleString('en-GB')}
                  </span>
                </div>
              </div>

              <div className="w-full py-3.5 bg-black text-white font-extrabold rounded-xl text-xs uppercase tracking-wider flex items-center justify-center gap-2">
                <LinkIcon size={14} /> GET DEAL LINK
              </div>
            </div>

            {/* Stats Preview */}
            <div className="bg-zinc-900 text-white p-6 rounded-[2rem] shadow-lg">
              <div className="flex justify-between items-center mb-4">
                <span className="text-xs font-bold text-zinc-500 uppercase">Estimated Budget</span>
                <Wallet size={16} className="text-lime-400" />
              </div>
              <h2 className="text-3xl font-extrabold">
                {(Number(form.payout) * Number(form.totalSlots)).toLocaleString('en-GB')}
              </h2>
              <p className="text-xs text-zinc-500 mt-2">Based on commission to agency & total units.</p>
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="max-w-7xl mx-auto animate-enter h-full flex flex-col">
      {ConfirmDialogElement}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-extrabold text-zinc-900 tracking-tight">Active Campaigns</h1>
          <p className="text-zinc-500 font-medium">Manage your product distribution and deals.</p>
        </div>
        <button
          onClick={() => {
            setForm(initialForm);
            setSelAgencies([]);
            setIsEditing(false);
            setEditingId(null);
            setView('create');
          }}
          className="px-6 py-3 bg-zinc-900 text-white rounded-xl font-bold text-sm shadow-lg hover:bg-black transition-all active:scale-95 flex items-center gap-2"
        >
          <Plus size={18} /> New Campaign
        </button>
      </div>

      {/* Search + Filters */}
      <div className="flex gap-3 flex-wrap items-center mb-6">
        <div className="flex-1 min-w-[180px] relative">
          <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={campaignSearch}
            onChange={(e) => setCampaignSearch(e.target.value)}
            placeholder="Search campaigns..."
            className="w-full pl-10 pr-4 py-3 rounded-xl border border-zinc-200 bg-white text-sm font-medium focus:border-lime-300 focus:ring-2 focus:ring-lime-100 outline-none"
          />
        </div>
        <select
          value={filterDealType}
          onChange={(e) => setFilterDealType(e.target.value)}
          aria-label="Filter campaigns by deal type"
          className="px-3 py-3 rounded-xl border border-zinc-200 text-xs font-bold bg-white"
        >
          <option value="All">All Deal Types</option>
          <option value="Discount">Discount</option>
          <option value="Review">Review</option>
          <option value="Rating">Rating</option>
        </select>
        <input
          type="date"
          value={filterDateFrom}
          onChange={(e) => setFilterDateFrom(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-zinc-200 text-xs font-bold bg-white"
          title="From date"
        />
        <input
          type="date"
          value={filterDateTo}
          onChange={(e) => setFilterDateTo(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-zinc-200 text-xs font-bold bg-white"
          title="To date"
        />
        {(filterDealType !== 'All' || filterDateFrom || filterDateTo) && (
          <button
            onClick={() => { setFilterDealType('All'); setFilterDateFrom(''); setFilterDateTo(''); }}
            className="px-3 py-2.5 rounded-xl border border-red-200 text-xs font-bold text-red-500 bg-red-50 hover:bg-red-100 transition-colors"
          >
            Clear Filters
          </button>
        )}
        <span className="text-xs text-zinc-400 font-bold">{filteredCampaigns.length} campaigns</span>
      </div>

      {loading ? (
        <EmptyState
          title="Loading campaigns"
          description="Fetching your latest campaigns"
          icon={<Spinner className="w-6 h-6 text-zinc-400" />}
          className="bg-transparent"
        />
      ) : filteredCampaigns.length === 0 ? (
        <EmptyState
          title={campaigns.length === 0 ? "No campaigns yet" : "No matching campaigns"}
          description={campaigns.length === 0 ? "Launch your first campaign to start selling." : "Try adjusting your search or filters."}
          icon={<Briefcase size={22} className="text-zinc-400" />}
          action={campaigns.length === 0 ? (
            <button
              onClick={() => setView('create')}
              className="px-6 py-3 bg-lime-400 text-black rounded-xl font-bold text-xs hover:bg-lime-300 transition-colors"
            >
              Create first campaign
            </button>
          ) : undefined}
          className="rounded-[2.5rem] py-20"
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-20">
          {filteredCampaigns.map((c: Campaign) => (
            <div
              key={c.id}
              className="bg-white p-5 rounded-[2rem] border border-zinc-100 shadow-sm hover:shadow-xl transition-all group relative overflow-hidden flex flex-col"
            >
              <div className="flex gap-4 mb-4">
                <div className="w-20 h-20 bg-zinc-50 rounded-2xl p-2 flex-shrink-0 border border-zinc-100 flex items-center justify-center">
                  <ProxiedImage src={c.image} alt={c.title || 'Campaign'} className="w-full h-full object-contain mix-blend-multiply" />
                </div>
                <div className="flex-1 min-w-0 py-1">
                  <div className="flex justify-between items-start mb-1">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase ${c.status === 'Active' ? 'bg-green-50 text-green-600 border-green-100' : 'bg-zinc-100 text-zinc-500 border-zinc-200'}`}
                    >
                      {c.status}
                    </span>
                    <span className="text-[10px] font-bold text-zinc-400 uppercase bg-zinc-50 px-1.5 py-0.5 rounded border border-zinc-100">
                      {c.platform}
                    </span>
                  </div>
                  <h3 className="font-bold text-zinc-900 text-sm line-clamp-1 leading-tight mb-1">
                    {c.title}
                  </h3>
                  <span
                    className="text-[9px] text-zinc-400 font-mono cursor-pointer hover:text-lime-600 transition-colors mb-2 block"
                    title="Click to copy Campaign ID"
                    onClick={() => {
                      navigator.clipboard.writeText(String(c.id)).then(() => toast.success('Campaign ID copied!')).catch(() => {});
                    }}
                  >
                    ID: {String(c.id).slice(-8)}
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col">
                      <span className="text-[9px] font-bold text-zinc-400 uppercase">Payout</span>
                      <span className="text-xs font-black text-zinc-900">{c.payout}</span>
                    </div>
                    <div className="w-[1px] h-6 bg-zinc-100"></div>
                    <div className="flex flex-col">
                      <span className="text-[9px] font-bold text-zinc-400 uppercase">Cost</span>
                      <span className="text-xs font-black text-zinc-900">{c.price}</span>
                    </div>
                    <div className="w-[1px] h-6 bg-zinc-100"></div>
                    <div className="flex flex-col">
                      <span className="text-[9px] font-bold text-zinc-400 uppercase">Created</span>
                      <span className="text-[10px] font-medium text-zinc-500">{c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-GB') : '—'}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3 mt-auto">
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase">
                      Slots Sold
                    </span>
                    <span className="text-[10px] font-bold text-zinc-900">
                      {c.usedSlots} / {c.totalSlots}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-lime-500 rounded-full transition-all duration-1000"
                      style={{
                        width: `${Math.min(
                          100,
                          c.totalSlots > 0 ? (c.usedSlots / c.totalSlots) * 100 : 0
                        )}%`,
                      }}
                    ></div>
                  </div>
                </div>

                <div className="space-y-2">
                  <button
                    onClick={() => handleEdit(c)}
                    className="w-full py-3 bg-zinc-50 text-zinc-600 rounded-xl font-bold text-xs hover:bg-zinc-900 hover:text-white transition-all flex items-center justify-center gap-2 border border-zinc-100 group-hover:border-zinc-900"
                  >
                    Manage Campaign <ArrowUpRight size={14} />
                  </button>
                  {(c.status === 'Active' || c.status === 'Paused') && (
                    <button
                      onClick={() => handleToggleStatus(c)}
                      disabled={statusUpdatingId === c.id}
                      className={`w-full py-3 rounded-xl font-bold text-xs border transition-all flex items-center justify-center gap-2 ${
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
                  <button
                    onClick={() => handleDelete(c)}
                    disabled={deletingId === c.id}
                    className={`w-full py-3 rounded-xl font-bold text-xs border transition-all flex items-center justify-center gap-2 bg-red-50 text-red-600 border-red-200 hover:bg-red-100 ${
                      deletingId === c.id ? 'opacity-60 cursor-not-allowed' : ''
                    }`}
                  >
                    {deletingId === c.id ? 'Deleting...' : 'Delete Campaign'}
                  </button>
                  <button
                    onClick={async () => {
                      setCopyingId(c.id);
                      try {
                        await api.brand.copyCampaign(c.id);
                        toast.success('Campaign copied as Draft — you can now edit it');
                        onRefresh(['campaigns']);
                      } catch (err) {
                        toast.error(formatErrorMessage(err, 'Copy failed'));
                      } finally {
                        setCopyingId(null);
                      }
                    }}
                    disabled={copyingId === c.id}
                    className={`w-full py-3 rounded-xl font-bold text-xs border transition-all flex items-center justify-center gap-2 bg-sky-50 text-sky-600 border-sky-200 hover:bg-sky-100 ${
                      copyingId === c.id ? 'opacity-60 cursor-not-allowed' : ''
                    }`}
                  >
                    <Copy className="w-3.5 h-3.5" />
                    {copyingId === c.id ? 'Copying...' : 'Copy Campaign'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const BrandDashboard: React.FC = () => {
  const { user, logout, updateUser } = useAuth();
  const { toast } = useToast();
  const { confirm: confirmDialog, ConfirmDialogElement: BrandConfirmDialog } = useConfirm();
  useRealtimeConnection();
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agencies, setAgencies] = useState<User[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDataLoading, setIsDataLoading] = useState(true);
  const [dashboardStats, setDashboardStats] = useState<{ totalRevenue: number; activeCampaigns: number; partnerAgencies: number; inventoryReach: number }>({ totalRevenue: 0, activeCampaigns: 0, partnerAgencies: 0, inventoryReach: 0 });
  const [revenueChartData, setRevenueChartData] = useState<Array<{ name: string; revenue: number; dateKey: string }>>([]);
  const [inventoryFillData, setInventoryFillData] = useState<Array<{ name: string; sold: number; remaining: number; total: number }>>([]);

  // NEW: Agency Detail Modal State
  const [selectedAgency, setSelectedAgency] = useState<User | null>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutRef, setPayoutRef] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [sheetsExporting, setSheetsExporting] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketFilter, setTicketFilter] = useState<'All' | 'Open' | 'Resolved' | 'Rejected'>('All');
  const [ticketSearch, setTicketSearch] = useState('');
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  const loadedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const lastFetchedAt = useRef<Record<string, number>>({});
  const fetchSeqRef = useRef(0);
  const fetchAbortRef = useRef<AbortController | null>(null);

  const tabDataNeeds = useMemo<string[]>(() => {
    switch (activeTab) {
      case 'dashboard': return ['dashboardStats', 'revenueChart', 'inventoryFill'];
      case 'campaigns': return ['campaigns', 'agencies'];
      case 'orders': return ['orders'];
      case 'agencies': return ['agencies', 'transactions'];
      case 'requests': return ['agencies'];
      case 'tickets': return ['tickets'];
      case 'profile': return [];
      default: return [];
    }
  }, [activeTab]);

  // Keep a ref so fetchData callback stays stable across tab switches
  const tabDataNeedsRef = useRef(tabDataNeeds);
  tabDataNeedsRef.current = tabDataNeeds;

  const fetchData = useCallback(async (opts?: { force?: boolean; silent?: boolean; keys?: string[] }) => {
    if (!user) return;
    const force = opts?.force ?? false;
    const silent = opts?.silent ?? false;
    const invalidateKeys = opts?.keys;

    if (invalidateKeys) {
      for (const k of invalidateKeys) loadedRef.current.delete(k);
    }

    const currentNeeds = tabDataNeedsRef.current;
    if (force && !invalidateKeys) {
      for (const k of currentNeeds) loadedRef.current.delete(k);
      invalidateGetCache('/brand');
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
    if (!silent) setIsDataLoading(true);
    // Abort any previous in-flight batch and start fresh
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const seq = ++fetchSeqRef.current;
    try {
      const promises: Promise<any>[] = [];
      const keys: string[] = [];

      if (needed.includes('dashboardStats')) { promises.push(api.brand.getDashboardStats(user.id)); keys.push('dashboardStats'); }
      if (needed.includes('revenueChart')) { promises.push(api.brand.getRevenueTrend(user.id)); keys.push('revenueChart'); }
      if (needed.includes('inventoryFill')) { promises.push(api.brand.getInventoryFill(user.id)); keys.push('inventoryFill'); }
      if (needed.includes('campaigns')) { promises.push(api.brand.getBrandCampaigns(user.id)); keys.push('campaigns'); }
      if (needed.includes('agencies')) { promises.push(api.brand.getConnectedAgencies(user.id)); keys.push('agencies'); }
      if (needed.includes('orders')) { promises.push(api.brand.getBrandOrders(user.name)); keys.push('orders'); }
      if (needed.includes('transactions')) { promises.push(api.brand.getTransactions(user.id)); keys.push('transactions'); }
      if (needed.includes('tickets')) { promises.push(api.tickets.getAll().catch(() => [])); keys.push('tickets'); }

      const settled = await Promise.allSettled(promises);

      // Discard stale results if a newer fetch was started (rapid tab switch) or if aborted
      if (fetchSeqRef.current !== seq || controller.signal.aborted) return;

      const now = Date.now();
      keys.forEach((key, i) => {
        const result = settled[i];
        if (result.status !== 'fulfilled') {
          if (process.env.NODE_ENV !== 'production') console.warn(`[BrandDashboard] fetch '${key}' failed`, result.reason);
          return;
        }
        loadedRef.current.add(key);
        lastFetchedAt.current[key] = now;
        switch (key) {
          case 'dashboardStats': setDashboardStats(result.value as any); break;
          case 'revenueChart': setRevenueChartData(asArray(result.value)); break;
          case 'inventoryFill': setInventoryFillData(asArray(result.value)); break;
          case 'campaigns': setCampaigns(asArray(result.value)); break;
          case 'agencies': setAgencies(asArray(result.value)); break;
          case 'orders': setOrders(asArray(result.value)); break;
          case 'transactions': setTransactions(asArray(result.value)); break;
          case 'tickets': setTickets(asArray<Ticket>(result.value).filter((t: Ticket) => t.issueType !== 'Feedback')); break;
        }
      });
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') console.error('Dashboard data fetch failed', e);
      if (!silent) toast.error(formatErrorMessage(e, 'Failed to load dashboard data'));
    } finally {
      for (const k of needed) inFlightRef.current.delete(k);
      if (inFlightRef.current.size === 0) setIsDataLoading(false);
    }
  }, [user?.id]);

  // Trigger data load on tab change — only fetches keys not already cached
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    const tabChanged = prevTabRef.current !== activeTab;
    prevTabRef.current = activeTab;
    // silent: true on tab switch suppresses spinner; no force so shared keys stay cached
    fetchData(tabChanged ? { silent: true } : undefined);
    return () => { fetchAbortRef.current?.abort(); };
  }, [fetchData, activeTab]);

  // Realtime: only invalidate data keys relevant to the SSE event, then refetch
  useEffect(() => {
    if (!user?.id) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const eventToKeys: Record<string, string[]> = {
      'orders.changed': ['orders', 'dashboardStats', 'revenueChart'],
      'deals.changed': ['campaigns', 'dashboardStats', 'inventoryFill'],
      'users.changed': ['agencies', 'dashboardStats'],
      'wallets.changed': ['transactions'],
      'tickets.changed': ['tickets'],
    };
    const schedule = (keysToInvalidate: string[]) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Skip keys that were just fetched by an explicit refresh (prevents double-fetch)
        const now = Date.now();
        const stale = keysToInvalidate.filter(k => (now - (lastFetchedAt.current[k] || 0)) > 2000);
        if (stale.length === 0) return;
        // Always invalidate globally so other tabs see fresh data on next visit
        for (const k of stale) loadedRef.current.delete(k);
        // Only re-fetch if current tab actually needs these keys
        const relevant = stale.filter(k => tabDataNeedsRef.current.includes(k));
        if (relevant.length > 0) fetchData({ silent: true });
      }, 900);
    };
    const unsub = subscribeRealtime((msg) => {
      const keys = eventToKeys[msg.type];
      if (keys && keys.length > 0) schedule(keys);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user?.id, fetchData]);

  const refreshData = useCallback((keys?: string[]) => {
    if (keys) return fetchData({ keys });
    return fetchData({ force: true });
  }, [fetchData]);

  const handlePayout = async () => {
    if (!selectedAgency || !payoutAmount || !payoutRef || !user) return;
    const amount = Number(payoutAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Enter a valid positive amount');
      return;
    }
    if (amount > 10_00_000) {
      toast.error('Payout cannot exceed \u20b910,00,000 per transaction');
      return;
    }
    setIsProcessing(true);
    try {
      await api.brand.payoutAgency(user.id, selectedAgency.id, amount, payoutRef);
      toast.success('Payment recorded');
      setPayoutAmount('');
      setPayoutRef('');
      setSelectedAgency(null);
      fetchData({ keys: ['transactions'] });
    } catch (e) {
      toast.error(formatErrorMessage(e, 'Payment failed'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExportPayouts = () => {

    const headers = [
      'Transaction ID',
      'Date',
      'Time',
      'Agency Name',
      'Amount (INR)',
      'Reference/UTR',
      'Status',
    ];

    const csvRows = [headers.join(',')];

    transactions.forEach((tx: any) => {
      const dateObj = new Date(tx.date);
      const date = dateObj.toLocaleDateString('en-GB');
      const time = dateObj.toLocaleTimeString('en-GB');

      const row = [
        csvSafe(tx.id),
        csvSafe(date),
        csvSafe(time),
        csvSafe(tx.agencyName || ''),
        tx.amount,
        csvSafe(tx.ref || ''),
        csvSafe(tx.status),
      ];
      csvRows.push(row.join(','));
    });

    const csvString = csvRows.join('\n');
    downloadCsv(`payout_ledger_report_${new Date().toISOString().slice(0, 10)}.csv`, csvString);
  };

  const handleExportPayoutsToSheets = () => {
    if (!transactions.length) { toast.info('No payouts to export'); return; }
    const payoutHeaders = ['Transaction ID','Date','Time','Agency Name','Amount (INR)','Reference/UTR','Status'];
    const payoutRows = transactions.map((tx: any) => {
      const dateObj = new Date(tx.date);
      return [
        tx.id,
        dateObj.toLocaleDateString('en-GB'),
        dateObj.toLocaleTimeString('en-GB'),
        tx.agencyName || '',
        tx.amount,
        tx.ref || '',
        tx.status || '',
      ] as (string | number)[];
    });
    import('../utils/exportToSheets').then(({ exportToGoogleSheet }) => exportToGoogleSheet({
      title: `Brand Payout Ledger - ${new Date().toISOString().slice(0, 10)}`,
      headers: payoutHeaders,
      rows: payoutRows,
      sheetName: 'Payouts',
      onStart: () => setSheetsExporting(true),
      onEnd: () => setSheetsExporting(false),
      onSuccess: () => toast.success('Exported to Google Sheets!'),
      onError: (msg) => toast.error(typeof msg === 'string' ? msg : 'Google Sheets export failed. Please try again.'),
    }));
  };

  const pendingRequests = user?.pendingConnections?.length || 0;

  return (
    <>
    <DesktopShell
      isSidebarOpen={isSidebarOpen}
      onSidebarOpenChange={setIsSidebarOpen}
      containerClassName="flex h-[100dvh] min-h-0 bg-[#F4F4F5] font-sans text-zinc-900 overflow-hidden relative"
      overlayClassName="fixed inset-0 bg-black/50 z-40 md:hidden backdrop-blur-sm"
      sidebarWidthClassName="w-80"
      asideClassName="bg-white flex flex-col border-r border-zinc-100 shadow-[4px_0_24px_rgba(0,0,0,0.02)]"
      mainClassName="flex-1 min-w-0 min-h-0 overflow-y-auto bg-[#FAFAFA] relative scrollbar-styled p-4 md:p-8"
      mobileHeader={
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-black text-lime-400 rounded-lg flex items-center justify-center">
            <Building2 size={16} />
          </div>
          <span className="font-extrabold text-lg">BUZZMA Brand</span>
        </div>
      }
      mobileMenuButton={
        <button
          onClick={() => setIsSidebarOpen(true)}
          aria-label="Open menu"
          className="p-2 bg-white rounded-xl shadow-sm border border-zinc-200"
        >
          <Menu size={20} />
        </button>
      }
      sidebar={
        <>
          <div className="p-8">
            <div className="flex items-center justify-between mb-10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-black text-lime-400 rounded-xl flex items-center justify-center shadow-xl shadow-lime-400/20">
                  <Building2 size={22} strokeWidth={2.5} />
                </div>
                <div>
                  <h1 className="font-extrabold text-xl tracking-tight leading-none">
                    BUZZMA<span className="text-lime-500">Brand</span>
                  </h1>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">
                      Partner Portal
                    </p>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setIsSidebarOpen(false)}
                aria-label="Close sidebar"
                className="md:hidden p-2 text-zinc-400 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                <X size={24} />
              </button>
            </div>
            <nav className="space-y-1">
              <SidebarItem
                icon={<LayoutDashboard />}
                label="Command Center"
                active={activeTab === 'dashboard'}
                onClick={() => {
                  setActiveTab('dashboard');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<Briefcase />}
                label="Campaigns"
                active={activeTab === 'campaigns'}
                onClick={() => {
                  setActiveTab('campaigns');
                  setIsSidebarOpen(false);
                }}
                badge={campaigns.filter((c) => c.status === 'Active').length}
              />
              <SidebarItem
                icon={<ShoppingBag />}
                label="Order Intelligence"
                active={activeTab === 'orders'}
                onClick={() => {
                  setActiveTab('orders');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<Users />}
                label="Agency Partners"
                active={activeTab === 'agencies'}
                onClick={() => {
                  setActiveTab('agencies');
                  setIsSidebarOpen(false);
                }}
              />
              <SidebarItem
                icon={<Bell />}
                label="Requests"
                active={activeTab === 'requests'}
                onClick={() => {
                  setActiveTab('requests');
                  setIsSidebarOpen(false);
                }}
                badge={pendingRequests}
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
            <button
              onClick={() => setTicketOpen(true)}
              className="w-full mt-3 py-2.5 flex items-center justify-center gap-2 text-orange-600 hover:bg-orange-50 rounded-xl font-bold text-xs transition-colors border border-orange-200"
            >
              <AlertTriangleIcon size={14} /> Raise a Ticket
            </button>
          </div>

          <div className="mt-auto p-6">
            {/* Brand Profile Card - Interactive */}
            <div
              onClick={() => {
                setActiveTab('profile');
                setIsSidebarOpen(false);
              }}
              className={`bg-zinc-50 rounded-2xl p-4 border border-zinc-100 mb-4 cursor-pointer transition-all hover:bg-zinc-100 hover:border-zinc-200 group ${activeTab === 'profile' ? 'ring-2 ring-lime-400 ring-offset-2' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-zinc-900 text-white flex items-center justify-center font-bold shadow-md text-sm shrink-0 overflow-hidden">
                  {user?.avatar ? (
                    <ProxiedImage src={user.avatar} alt={user?.name ? `${user.name} avatar` : 'Avatar'} className="w-full h-full object-cover" />
                  ) : (
                    user?.name?.charAt(0) || 'B'
                  )}
                </div>
                <div className="min-w-0 overflow-hidden flex-1">
                  <p className="text-sm font-bold text-zinc-900 truncate group-hover:text-black">
                    {user?.name}
                  </p>
                  <p className="text-[10px] text-zinc-500 font-mono bg-white px-1.5 py-0.5 rounded border border-zinc-200 inline-block mt-1 truncate max-w-full group-hover:bg-white/80">
                    {user?.brandCode}
                  </p>
                </div>
                <ChevronRight size={16} className="text-zinc-400 group-hover:text-zinc-600" />
              </div>
            </div>

            <button
              onClick={logout}
              className="w-full py-3 flex items-center justify-center gap-2 text-zinc-400 hover:bg-red-50 hover:text-red-500 rounded-xl font-bold text-xs transition-colors"
            >
              <LogOut size={16} /> Sign Out
            </button>
          </div>
        </>
      }
    >

        {activeTab === 'dashboard' && (
          <DashboardView stats={dashboardStats} revenueData={revenueChartData} campaignPerformance={inventoryFillData} />
        )}
        {activeTab === 'campaigns' && (
          <CampaignsView
            campaigns={campaigns}
            agencies={agencies}
            user={user}
            loading={isDataLoading}
            onRefresh={refreshData}
          />
        )}
        {activeTab === 'orders' && <OrdersView orders={orders} isLoading={isDataLoading} />}
        {activeTab === 'profile' && <BrandProfileView />}
        {activeTab === 'tickets' && (
          <div className="max-w-3xl mx-auto animate-enter pb-12">
            <h2 className="text-2xl font-extrabold text-zinc-900 tracking-tight mb-6">Tickets</h2>
            {/* Export CSV */}
            {tickets && tickets.length > 0 && (
              <button type="button" onClick={() => {
                const supportTickets = tickets.filter(t => t.issueType !== 'Feedback');
                if (!supportTickets.length) { toast.error('No tickets to export'); return; }
                const header = ['Ticket ID','Status','Issue Type','Description','User','Role','Target Role','Order ID','Resolution Note','Resolved By','Resolved At','Created At'].map(csvSafe).join(',');
                const rows = supportTickets.map(t => [
                  csvSafe(t.id.slice(-8)), csvSafe(String(t.status)),
                  csvSafe(String(t.issueType)), csvSafe(String(t.description || '')), csvSafe(String((t as any).userName || '')),
                  csvSafe(String((t as any).role || '')), csvSafe(String((t as any).targetRole || '')), csvSafe(String(t.externalOrderId || t.orderId || '')),
                  csvSafe(String((t as any).resolutionNote || '')), csvSafe(String((t as any).resolvedByName || '')),
                  csvSafe((t as any).resolvedAt ? new Date((t as any).resolvedAt).toLocaleDateString('en-GB') : ''),
                  csvSafe(t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : ''),
                ].join(','));
                downloadCsv(`brand-tickets-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows].join('\n'));
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
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-zinc-200 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
              </div>
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                {(['All', 'Open', 'Resolved', 'Rejected'] as const).map(f => {
                  const count = f === 'All' ? tickets.length : tickets.filter(t => String(t.status) === f).length;
                  return (
                    <button key={f} type="button" onClick={() => setTicketFilter(f)}
                      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
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
                description="Support tickets assigned to your brand will appear here."
                icon={<HelpCircle size={22} className="text-zinc-400" />}
              />
            ) : (
              <div className="space-y-3 max-h-[65dvh] overflow-y-auto scrollbar-styled">
                {tickets.filter((t: Ticket) => {
                  if (ticketFilter !== 'All' && String(t.status) !== ticketFilter) return false;
                  if (ticketSearch.trim()) {
                    const q = ticketSearch.trim().toLowerCase();
                    return (String(t.issueType || '').toLowerCase().includes(q) ||
                      String(t.description || '').toLowerCase().includes(q) ||
                      String((t as any).userName || '').toLowerCase().includes(q) ||
                      String(t.externalOrderId || t.orderId || '').toLowerCase().includes(q) ||
                      t.id.toLowerCase().includes(q));
                  }
                  return true;
                }).map((t: Ticket) => (
                  <div key={t.id} className="rounded-xl border border-zinc-100 bg-white px-3 py-3 shadow-sm space-y-2 cursor-pointer hover:border-zinc-300 transition-colors" onClick={() => setSelectedTicket(t)}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-zinc-900 truncate">{String(t.issueType || 'Ticket')}</span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            String(t.status) === 'Resolved' ? 'bg-emerald-50 text-emerald-600' :
                            String(t.status) === 'Rejected' ? 'bg-red-50 text-red-600' :
                            'bg-amber-50 text-amber-600'
                          }`}>{String(t.status || 'Open')}</span>
                        </div>
                      </div>
                      <span className="text-[10px] text-zinc-400 shrink-0">{t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : ''}</span>
                    </div>
                    {t.description && (
                      <div className="text-xs text-zinc-600 bg-zinc-50 rounded-lg px-3 py-2 line-clamp-3">
                        &ldquo;{String(t.description)}&rdquo;
                      </div>
                    )}
                    {(t as any).userName && (
                      <div className="text-[10px] text-zinc-400">From: {String((t as any).userName)} ({String((t as any).userRole || '')})</div>
                    )}
                    {(t.externalOrderId || t.orderId) && (
                      <div className="text-[10px] text-zinc-400"><span className="font-bold">Order:</span> {String(t.externalOrderId || t.orderId)}</div>
                    )}
                    {(t as any).resolutionNote && (
                      <div className="text-[10px] text-green-700 bg-green-50 rounded-lg px-2 py-1.5">
                        <span className="font-bold">Resolution:</span> {String((t as any).resolutionNote)}
                      </div>
                    )}
                    {(String(t.status) === 'Resolved' || String(t.status) === 'Rejected') && ((t as any).resolvedByName || (t as any).resolvedAt) && (
                      <div className="text-[10px] text-zinc-400">
                        {String(t.status) === 'Resolved' ? 'Resolved' : 'Rejected'}
                        {(t as any).resolvedByName ? ` by ${String((t as any).resolvedByName)}` : ''}
                        {(t as any).resolvedAt ? ` on ${new Date(String((t as any).resolvedAt)).toLocaleDateString('en-GB')}` : ''}
                      </div>
                    )}
                    <div className="flex items-center gap-2 justify-end flex-wrap">
                      {String(t.status || '').toLowerCase() === 'open' && resolvingTicketId !== t.id && (
                        <>
                          <button type="button" onClick={() => { setResolvingTicketId(t.id); setResolutionNote(''); }}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100">
                            ✓ Resolve / Reject
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await api.tickets.escalate(t.id);
                                toast.success('Ticket escalated to admin.');
                                fetchData({ keys: ['tickets'] });
                              } catch (err: any) {
                                toast.error(formatErrorMessage(err, 'Failed to escalate ticket.'));
                              }
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-violet-50 border border-violet-200 text-violet-700 hover:bg-violet-100"
                          >
                            ↑ Escalate
                          </button>
                        </>
                      )}
                      {String(t.status || '').toLowerCase() === 'open' && resolvingTicketId === t.id && (
                        <div className="w-full mt-1 space-y-1.5">
                          <textarea placeholder="Resolution / rejection note (optional)..." value={resolutionNote} onChange={e => setResolutionNote(e.target.value)} rows={2}
                            className="w-full px-2 py-1.5 text-xs rounded-lg border border-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-none" />
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={async () => {
                              try { await api.tickets.update(t.id, 'Resolved', resolutionNote || undefined); toast.success('Ticket resolved.'); setResolvingTicketId(null); setResolutionNote(''); fetchData({ keys: ['tickets'] }); } catch (err: any) { toast.error(formatErrorMessage(err, 'Failed to resolve.')); }
                            }} className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-500 text-white hover:bg-emerald-600">✓ Resolve</button>
                            <button type="button" onClick={async () => {
                              try { await api.tickets.update(t.id, 'Rejected', resolutionNote || undefined); toast.success('Ticket rejected.'); setResolvingTicketId(null); setResolutionNote(''); fetchData({ keys: ['tickets'] }); } catch (err: any) { toast.error(formatErrorMessage(err, 'Failed to reject.')); }
                            }} className="px-3 py-1 rounded-lg text-xs font-bold bg-red-500 text-white hover:bg-red-600">✗ Reject</button>
                            <button type="button" onClick={() => { setResolvingTicketId(null); setResolutionNote(''); }}
                              className="px-3 py-1 rounded-lg text-xs font-bold bg-zinc-100 text-zinc-500 hover:bg-zinc-200">Cancel</button>
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
                                fetchData({ keys: ['tickets'] });
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
                                fetchData({ keys: ['tickets'] });
                              } catch (err: any) {
                                toast.error(formatErrorMessage(err, 'Failed to delete ticket.'));
                              }
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-zinc-50 border border-zinc-200 text-zinc-600 hover:text-red-600 hover:border-red-200"
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

        {activeTab === 'agencies' && (
          <div className="max-w-6xl mx-auto animate-enter pb-12">
            <h2 className="text-3xl font-extrabold text-zinc-900 tracking-tight mb-8">
              Partner Agencies
            </h2>
            {isDataLoading ? (
              <EmptyState
                title="Loading agencies"
                description="Fetching your connected agencies"
                icon={<Spinner className="w-6 h-6 text-zinc-400" />}
                className="bg-transparent"
              />
            ) : agencies.length === 0 ? (
              <EmptyState
                title="No agencies connected"
                description="Once an agency connects to your brand, it will show up here."
                icon={<Users size={22} className="text-zinc-400" />}
                className="bg-transparent"
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {agencies.map((ag: User) => (
                  <div
                    key={ag.id}
                    onClick={() => setSelectedAgency(ag)}
                    className="bg-white p-6 rounded-[2rem] border border-zinc-100 shadow-sm hover:shadow-xl transition-all group flex items-center gap-5 relative overflow-hidden cursor-pointer active:scale-[0.99]"
                  >
                    <div className="w-20 h-20 bg-zinc-50 rounded-[1.5rem] flex items-center justify-center font-bold text-2xl text-zinc-400 shadow-inner overflow-hidden">
                      {ag.avatar ? (
                        <ProxiedImage
                          src={ag.avatar}
                          alt={ag.name ? `${ag.name} avatar` : 'Avatar'}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        (ag.name || '?').charAt(0)
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <h3 className="text-xl font-bold text-zinc-900 truncate">{ag.name || 'Unknown'}</h3>
                      <p className="text-xs text-zinc-400 font-mono mt-1 mb-3 bg-zinc-50 px-2 py-0.5 rounded w-fit">
                        {ag.mediatorCode}
                      </p>

                      <div className="flex gap-2">
                        <span className="px-3 py-1 bg-green-50 text-green-700 text-[10px] font-bold rounded-full border border-green-100 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> Active
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!user) return;
                        if (await confirmDialog({ message: 'Disconnect this Agency?', confirmLabel: 'Disconnect', variant: 'destructive' })) {
                          api.brand.removeAgency(user.id, ag.mediatorCode!).then(() => refreshData(['agencies'])).catch((err: any) => toast.error(formatErrorMessage(err, 'Failed to disconnect agency')));
                        }
                      }}
                      aria-label="Disconnect agency"
                      className="w-10 h-10 rounded-full border border-zinc-100 flex items-center justify-center text-zinc-300 hover:text-red-500 hover:border-red-100 hover:bg-red-50 transition-colors absolute top-6 right-6"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* LEDGER SECTION */}
            <div className="mt-12">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-bold text-zinc-900 flex items-center gap-2">
                  <History size={24} className="text-zinc-400" /> Payout Ledger
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={handleExportPayouts}
                    className="flex items-center gap-2 px-5 py-2.5 bg-zinc-100 text-zinc-700 rounded-xl font-bold text-xs hover:bg-zinc-200 transition-colors border border-zinc-200"
                  >
                    <Download size={16} /> CSV
                  </button>
                  <button
                    onClick={handleExportPayoutsToSheets}
                    disabled={sheetsExporting}
                    className="flex items-center gap-2 px-5 py-2.5 bg-green-50 text-green-700 rounded-xl font-bold text-xs hover:bg-green-100 transition-colors border border-green-200 disabled:opacity-50"
                  >
                    <FileSpreadsheet size={16} /> {sheetsExporting ? 'Exporting...' : 'Google Sheets'}
                  </button>
                </div>
              </div>
              <div className="bg-white rounded-[2rem] border border-zinc-100 shadow-sm overflow-hidden">
                <div className="overflow-x-auto scrollbar-styled">
                  <table className="w-full text-left min-w-[600px]">
                    <thead className="bg-zinc-50 text-zinc-400 text-xs font-bold uppercase tracking-wider">
                      <tr>
                        <th className="p-6">Date</th>
                        <th className="p-6">Transaction ID</th>
                        <th className="p-6">Agency</th>
                        <th className="p-6">Reference/UTR</th>
                        <th className="p-6 text-right">Amount</th>
                        <th className="p-6 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-50">
                      {isDataLoading ? (
                        <tr>
                          <td colSpan={6} className="p-8">
                            <EmptyState
                              title="Loading transactions"
                              description="Fetching payout ledger"
                              icon={<Spinner className="w-6 h-6 text-zinc-400" />}
                              className="bg-transparent"
                            />
                          </td>
                        </tr>
                      ) : transactions.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-8">
                            <EmptyState
                              title="No transactions yet"
                              description="Recorded payouts will appear here."
                              icon={<History size={22} className="text-zinc-400" />}
                              className="bg-transparent"
                            />
                          </td>
                        </tr>
                      ) : (
                        transactions.map((tx) => (
                          <tr key={tx.id} className="hover:bg-zinc-50/50 transition-colors">
                            <td className="p-6 text-sm font-bold text-zinc-500">
                              {new Date(tx.date).toLocaleDateString('en-GB')}
                            </td>
                            <td className="p-6 font-mono text-xs font-bold text-zinc-400">
                              {tx.id || tx.ref}
                            </td>
                            <td className="p-6">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 bg-purple-50 text-purple-600 rounded-lg flex items-center justify-center font-bold text-xs">
                                  {tx.agencyName?.charAt(0)}
                                </div>
                                <span className="text-sm font-bold text-zinc-900">
                                  {tx.agencyName}
                                </span>
                              </div>
                            </td>
                            <td className="p-6 font-mono text-xs font-bold text-zinc-500">
                              {tx.ref || '—'}
                            </td>
                            <td className="p-6 text-right font-mono font-bold text-zinc-900">
                              {tx.amount}
                            </td>
                            <td className="p-6 text-right">
                              <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-[10px] font-bold uppercase border border-green-200">
                                {tx.status}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'requests' && (
          <div className="max-w-4xl mx-auto animate-enter">
            <h2 className="text-3xl font-extrabold text-zinc-900 tracking-tight mb-8">
              Connection Requests
            </h2>
            {isDataLoading ? (
              <EmptyState
                title="Loading requests"
                description="Fetching pending connection requests"
                icon={<Spinner className="w-6 h-6 text-zinc-400" />}
                className="bg-transparent"
              />
            ) : !user?.pendingConnections || user.pendingConnections.length === 0 ? (
              <EmptyState
                title="No pending requests"
                description={`Share your Brand Code: ${user?.brandCode || ''}`}
                icon={<LinkIcon size={22} className="text-zinc-400" />}
                className="bg-transparent rounded-[2.5rem] py-20"
              />
            ) : (
              <div className="space-y-4">
                {user.pendingConnections.map((req: any) => (
                  <div
                    key={req.agencyId}
                    className="bg-white p-3 rounded-[1.5rem] shadow-sm border border-zinc-100 flex flex-col sm:flex-row justify-between items-center pr-4 transition-all hover:shadow-md gap-4"
                  >
                    <div className="flex items-center gap-5 w-full sm:w-auto">
                      <div className="w-16 h-16 bg-purple-50 text-purple-600 rounded-2xl flex items-center justify-center text-xl font-bold shadow-sm">
                        {(req.agencyName || '?').charAt(0)}
                      </div>
                      <div>
                        <h4 className="font-bold text-zinc-900 text-lg">{req.agencyName}</h4>
                        <p className="text-sm text-zinc-400 font-medium">
                          Wants to connect with your brand.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-3 w-full sm:w-auto">
                      <button
                        onClick={async () => {
                          try {
                            await api.brand.resolveConnectionRequest(
                              user.id,
                              req.agencyId,
                              'reject'
                            );
                            const currentPending = user.pendingConnections || [];
                            const newPending = currentPending.filter(
                              (r: any) => r.agencyId !== req.agencyId
                            );
                            await updateUser({ pendingConnections: newPending });
                            fetchData({ keys: ['agencies'] });
                          } catch (e) {
                            if (process.env.NODE_ENV !== 'production') console.error('Failed to decline', e);
                            toast.error(formatErrorMessage(e, 'Failed to decline connection'));
                          }
                        }}
                        className="flex-1 sm:flex-none px-6 py-2.5 bg-white text-zinc-600 rounded-xl font-bold text-xs border border-zinc-200 hover:bg-zinc-50 transition-colors"
                      >
                        Decline
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            await api.brand.resolveConnectionRequest(
                              user.id,
                              req.agencyId,
                              'approve'
                            );
                            const currentPending = user.pendingConnections || [];
                            const newPending = currentPending.filter(
                              (r: any) => r.agencyId !== req.agencyId
                            );
                            const newConnected = [
                              ...(user.connectedAgencies || []),
                              req.agencyCode,
                            ];
                            await updateUser({
                              pendingConnections: newPending,
                              connectedAgencies: newConnected,
                            });
                            fetchData({ keys: ['agencies'] });
                          } catch (e) {
                            if (process.env.NODE_ENV !== 'production') console.error('Failed to approve', e);
                            toast.error(formatErrorMessage(e, 'Failed to approve connection'));
                          }
                        }}
                        className="flex-1 sm:flex-none px-8 py-2.5 bg-zinc-900 text-white rounded-xl font-bold text-xs hover:bg-black shadow-lg transition-all active:scale-95"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      {/* AGENCY DETAIL / PAYMENT MODAL */}
      {selectedAgency && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-enter"
          onClick={() => setSelectedAgency(null)}
        >
          <div
            className="bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl relative animate-enter flex flex-col max-h-[90dvh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close agency details"
              onClick={() => setSelectedAgency(null)}
              className="absolute top-6 right-6 p-2 bg-zinc-50 rounded-full hover:bg-zinc-100 transition-colors"
            >
              <X size={20} />
            </button>

            <div className="flex items-center gap-4 mb-8">
              <div className="w-16 h-16 bg-zinc-900 text-white rounded-2xl flex items-center justify-center font-bold text-2xl shadow-lg overflow-hidden">
                {selectedAgency.avatar ? (
                  <ProxiedImage
                    src={selectedAgency.avatar}
                    alt={selectedAgency.name ? `${selectedAgency.name} avatar` : 'Avatar'}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  (selectedAgency?.name || '?').charAt(0)
                )}
              </div>
              <div>
                <h3 className="text-2xl font-extrabold text-zinc-900 leading-tight">
                  {selectedAgency?.name || 'Unknown'}
                </h3>
                <p className="text-zinc-500 font-mono text-sm mt-0.5">
                  {selectedAgency.mediatorCode}
                </p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-styled space-y-6">
              {/* Profile Info */}
              <div className="bg-zinc-50 p-5 rounded-2xl border border-zinc-100 space-y-3">
                <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                  <Building2 size={14} /> Contact Details
                </h4>
                <div className="flex justify-between">
                  <span className="text-xs font-bold text-zinc-500">Mobile</span>
                  <span className="text-sm font-bold text-zinc-900">{maskMobile(selectedAgency.mobile)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs font-bold text-zinc-500">Status</span>
                  <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded uppercase">
                    {selectedAgency.status}
                  </span>
                </div>
              </div>

              {/* Payment Info */}
              <div className="bg-zinc-50 p-5 rounded-2xl border border-zinc-100 space-y-4">
                <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                  <CreditCard size={14} /> Payment Details
                </h4>

                <div className="space-y-3">
                  <div className="p-3 bg-white rounded-xl border border-zinc-200">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase">
                        Bank Account
                      </span>
                      <Landmark size={14} className="text-zinc-300" />
                    </div>
                    <p className="text-sm font-bold text-zinc-900 mb-1">
                      {selectedAgency.bankDetails?.bankName || 'N/A'}
                    </p>
                    <div className="flex justify-between items-end">
                      <p className="font-mono text-xs text-zinc-600 bg-zinc-50 px-2 py-1 rounded w-fit">
                        {selectedAgency.bankDetails?.accountNumber || 'Not Added'}
                      </p>
                      <p className="text-[10px] font-mono text-zinc-400">
                        {selectedAgency.bankDetails?.ifsc}
                      </p>
                    </div>
                  </div>

                  <div className="p-3 bg-white rounded-xl border border-zinc-200">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-bold text-zinc-400 uppercase">
                        UPI Address
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(selectedAgency.upiId || '');
                          toast.success('Copied');
                        }}
                        aria-label="Copy UPI address"
                        className="text-zinc-400 hover:text-black"
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                    <p className="text-sm font-bold text-zinc-900 font-mono">
                      {selectedAgency.upiId || 'Not Linked'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Payment Action */}
              <BetaLock>
              <div className="pt-2">
                <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">
                  Record Payment
                </h4>
                <div className="space-y-4">
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-zinc-400">
                      
                    </span>
                    <input
                      type="number"
                      value={payoutAmount}
                      onChange={(e) => setPayoutAmount(e.target.value)}
                      className="w-full pl-8 pr-4 py-4 bg-white border border-zinc-200 rounded-2xl font-bold text-lg outline-none focus:ring-2 focus:ring-lime-400 focus:border-transparent transition-all"
                      placeholder="0.00"
                    />
                  </div>
                  <input
                    type="text"
                    value={payoutRef}
                    onChange={(e) => setPayoutRef(e.target.value)}
                    className="w-full p-4 bg-white border border-zinc-200 rounded-2xl font-bold text-sm outline-none focus:ring-2 focus:ring-lime-400 focus:border-transparent transition-all"
                    placeholder="Transaction Reference (UTR)"
                  />
                  <button
                    onClick={handlePayout}
                    disabled={!payoutAmount || Number(payoutAmount) <= 0 || !payoutRef || isProcessing}
                    className="w-full py-4 bg-black text-white font-bold rounded-2xl shadow-xl hover:bg-lime-400 hover:text-black transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:scale-100"
                  >
                    {isProcessing ? (
                      <span className="animate-spin motion-reduce:animate-none w-5 h-5 border-2 border-current border-t-transparent rounded-full"></span>
                    ) : (
                      <>
                        <Send size={18} /> Confirm Transfer
                      </>
                    )}
                  </button>
                </div>
              </div>
              </BetaLock>
            </div>
          </div>
        </div>
      )}
    </DesktopShell>
    <Suspense fallback={null}>
      <RaiseTicketModal open={ticketOpen} onClose={() => setTicketOpen(false)} />
      <TicketDetailModal
        open={!!selectedTicket}
        onClose={() => setSelectedTicket(null)}
        ticket={selectedTicket}
        onRefresh={refreshData}
      />
    </Suspense>
    {BrandConfirmDialog}
    </>
  );
};
