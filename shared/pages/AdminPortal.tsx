import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { api, asArray, extractPaginationMeta } from '../services/api';
import type { PaginationMeta } from '../services/api';
import { getDirectBackendUrl } from '../utils/apiBaseUrl';
import { maskMobile } from '../utils/mobiles';
import { formatErrorMessage } from '../utils/errors';
import { ProxiedImage } from '../components/ProxiedImage';

import { exportToGoogleSheet } from '../utils/exportToSheets';
import { subscribeRealtime } from '../services/realtime';
import { Button, EmptyState, IconButton, Input, Spinner, Pagination } from '../components/ui';
import { ProofImage } from '../components/ProofImage';
import { RatingVerificationBadge, ReturnWindowVerificationBadge } from '../components/AiVerificationBadge';
import { DesktopShell } from '../components/DesktopShell';
import {
  LayoutGrid,
  Users,
  ShoppingCart,
  Package,
  DollarSign,
  Settings,
  LogOut,
  Menu,
  Download,
  Database,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Ban,
  AlertTriangle,
  Key,
  Copy,
  Plus,
  IndianRupee,
  Wallet,
  Save,
  Terminal,
  HeadphonesIcon,
  Trash2,
  ClipboardList,
  FileSpreadsheet,
  Star,
  MessageCircle,
  ExternalLink,
  AlertCircle,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ChartSuspense,
} from '../components/LazyCharts';
import { User, Order, Product, Invite, Ticket } from '../types';
import { formatCurrency as formatCurrencyBase } from '../utils/formatCurrency';
import { csvSafe, downloadCsv } from '../utils/csvHelpers';
import TicketDetailModal from '../components/TicketDetailModal';

// --- TYPES & CONSTANTS ---
type ViewMode =
  | 'dashboard'
  | 'users'
  | 'orders'
  | 'inventory'
  | 'finance'
  | 'settings'
  | 'invites'
  | 'support'
  | 'feedback'
  | 'audit-logs';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

// --- COMPONENTS ---

const SidebarItem = ({ icon: Icon, label, active, onClick, badge }: any) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 group relative overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 motion-reduce:transition-none motion-reduce:transform-none ${
      active
        ? 'bg-white/10 text-white shadow-lg backdrop-blur-sm border border-white/5'
        : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
    }`}
  >
    {active && (
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-indigo-500 rounded-r-full"></div>
    )}
    <div className="flex items-center gap-3">
      <Icon
        size={18}
        className={active ? 'text-indigo-400' : 'text-slate-500 group-hover:text-slate-300'}
      />
      <span className="font-medium text-sm tracking-wide">{label}</span>
    </div>
    {badge > 0 && (
      <span className="bg-indigo-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm">
        {badge}
      </span>
    )}
  </button>
);

const StatCard = ({ title, value, subtext, icon: Icon, colorClass }: any) => (
  <div className="bg-white p-6 rounded-[1.5rem] shadow-[0_2px_20px_-12px_rgba(0,0,0,0.1)] border border-slate-100 relative overflow-hidden flex flex-col justify-between group hover:-translate-y-1 transition-all duration-300">
    <div
      className={`absolute -right-6 -top-6 w-24 h-24 rounded-full opacity-[0.08] group-hover:opacity-[0.15] transition-opacity ${colorClass.replace('text-', 'bg-')}`}
    ></div>

    <div className="flex justify-between items-start z-10">
      <div
        className={`p-3 rounded-2xl ${colorClass.replace('text-', 'bg-').replace('600', '50')} ${colorClass}`}
      >
        <Icon size={24} />
      </div>
      {subtext && (
        <div
          className={`flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-slate-50 text-slate-500`}
        >
          {subtext}
        </div>
      )}
    </div>

    <div className="mt-4 z-10">
      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">{title}</p>
      <h3 className="text-3xl font-black text-slate-900 tracking-tight">{value}</h3>
    </div>
  </div>
);

const StatusBadge = ({ status }: { status: string }) => {
  const styles: any = {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    suspended: 'bg-rose-50 text-rose-700 border-rose-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    Paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    Pending: 'bg-slate-100 text-slate-600 border-slate-200',
    Pending_Cooling: 'bg-blue-50 text-blue-700 border-blue-200',
    Delivered: 'bg-blue-50 text-blue-700 border-blue-200',
    Ordered: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    Shipped: 'bg-violet-50 text-violet-700 border-violet-200',
    Approved_Settled: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    used: 'bg-slate-100 text-slate-400 border-slate-200 line-through',
    Cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
    Open: 'bg-blue-50 text-blue-700 border-blue-200',
    Resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    Rejected: 'bg-slate-100 text-slate-500 border-slate-200',
  };

  const labels: any = {
    Pending_Cooling: 'Cooling Period',
    Approved_Settled: 'Settled',
  };

  return (
    <span
      className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-wide border ${styles[status] || styles['Pending']}`}
    >
      {labels[status] || status.replace(/_/g, ' ')}
    </span>
  );
};

// --- MAIN PAGE ---

export const AdminPortal: React.FC<{ onBack?: () => void }> = ({ onBack: _onBack }) => {
  const { user, loginAdmin, logout } = useAuth();
  const { toast } = useToast();
  const { confirm, ConfirmDialogElement } = useConfirm();
  const [view, setView] = useState<ViewMode>('dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingWalletId, setDeletingWalletId] = useState<string | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null);
  const [sheetsExporting, setSheetsExporting] = useState(false);


  const switchView = (next: ViewMode) => {
    setView(next);
    setIsSidebarOpen(false);
  };

  // Data Stores
  const [users, setUsers] = useState<User[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [chartData, setChartData] = useState<any[]>([]);

  // Admin Auth
  const [adminId, setAdminId] = useState('');
  const [passkey, setPasskey] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  // Filters
  const [userRoleFilter, setUserRoleFilter] = useState<string>('All');
  const [userSearch, setUserSearch] = useState('');
  const [ticketRoleFilter, setTicketRoleFilter] = useState<string>('All');
  const [ticketStatusFilter, setTicketStatusFilter] = useState<string>('All');
  const [ticketSearch, setTicketSearch] = useState('');
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [inviteRole, setInviteRole] = useState<'agency' | 'brand'>('agency');
  const [inviteLabel, setInviteLabel] = useState('');

  // Order/inventory filters
  const [orderSearch, setOrderSearch] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('All');
  const [inventorySearch, setInventorySearch] = useState('');
  const [proofModal, setProofModal] = useState<Order | null>(null);

  // --- Pagination state per tab ---
  const PAGE_SIZE = 50;
  const [usersPage, setUsersPage] = useState(1);
  const [usersPagination, setUsersPagination] = useState<PaginationMeta | null>(null);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersPagination, setOrdersPagination] = useState<PaginationMeta | null>(null);
  const [productsPage, setProductsPage] = useState(1);
  const [productsPagination, setProductsPagination] = useState<PaginationMeta | null>(null);
  const [invitesPage, setInvitesPage] = useState(1);
  const [invitesPagination, setInvitesPagination] = useState<PaginationMeta | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPagination, setAuditPagination] = useState<PaginationMeta | null>(null);


  // Admin-specific: show up to 2 decimal places
  const formatCurrency = (amount: number) => formatCurrencyBase(amount, { maximumFractionDigits: 2 });



  // Settings State
  const [configEmail, setConfigEmail] = useState('admin@buzzma.world');

  // Audit Logs State
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditFilter, setAuditFilter] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditDateFrom, setAuditDateFrom] = useState('');
  const [auditDateTo, setAuditDateTo] = useState('');

  // Debounced user search: input state for immediate UI, debounced value for API calls
  const [debouncedUserSearch, setDebouncedUserSearch] = useState('');
  const userSearchTimerRef = useRef<any>(null);
  const handleUserSearchChange = (value: string) => {
    setUserSearch(value);
    if (userSearchTimerRef.current) clearTimeout(userSearchTimerRef.current);
    userSearchTimerRef.current = setTimeout(() => {
      setDebouncedUserSearch(value);
      setUsersPage(1);
    }, 350);
  };

  // Ref to always call the latest refreshCurrentView (avoids stale closures in realtime handler)
  const refreshCurrentViewRef = useRef<() => void>(() => {});
  // Guard: only run initial data fetch once when admin session is established
  const initialLoadRef = useRef(false);

  const fetchSystemConfig = async () => {
    try {
      const cfg = await api.admin.getConfig();
      if (cfg?.adminContactEmail) setConfigEmail(String(cfg.adminContactEmail));
    } catch (e) {
      console.error('Admin Config Fetch Error:', e);
      toast.error(formatErrorMessage(e, 'Failed to load system configuration.'));
    }
  };

  useEffect(() => {
    if (user?.role === 'admin' && !initialLoadRef.current) {
      initialLoadRef.current = true;
      refreshCurrentView();
    }
  }, [user?.role]);

  // Realtime: only refresh when the event is relevant to the current view
  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    let timer: any = null;
    const viewRelevantEvents: Record<string, string[]> = {
      dashboard: ['orders.changed', 'users.changed', 'wallets.changed'],
      users: ['users.changed'],
      orders: ['orders.changed'],
      finance: ['orders.changed', 'wallets.changed'],
      inventory: ['deals.changed'],
      support: ['tickets.changed'],
      feedback: ['tickets.changed'],
      invites: ['invites.changed'],
      'audit-logs': [],
      settings: [],
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshCurrentViewRef.current();
      }, 800);
    };
    const unsub = subscribeRealtime((msg) => {
      const relevant = viewRelevantEvents[view] || [];
      if (relevant.includes(msg.type)) {
        schedule();
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [user?.id, view]);

  // Auto-fetch audit logs when switching to audit-logs view or when filters change
  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    if (view !== 'audit-logs') return;
    setAuditLoading(true);
    const params: any = { limit: PAGE_SIZE, page: auditPage };
    if (auditActionFilter) params.action = auditActionFilter;
    if (auditDateFrom) params.from = new Date(auditDateFrom).toISOString();
    if (auditDateTo) params.to = new Date(auditDateTo + 'T23:59:59').toISOString();
    api.admin
      .getAuditLogs(params)
      .then((res) => {
        setAuditLogs(asArray(res));
        setAuditPagination(extractPaginationMeta(res));
      })
      .catch((e) => { console.error('Audit Logs Fetch Error:', e); toast.error(formatErrorMessage(e, 'Failed to load audit logs.')); })
      .finally(() => setAuditLoading(false));
  }, [user?.id, view, auditActionFilter, auditDateFrom, auditDateTo, auditPage]);

  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    if (view !== 'users') return;
    const role = userRoleFilter === 'All' ? 'all' : userRoleFilter.toLowerCase();
    const search = debouncedUserSearch.trim() || undefined;
    api.admin
      .getUsers(role, { page: usersPage, limit: PAGE_SIZE, search })
      .then((res) => {
        setUsers(asArray(res));
        setUsersPagination(extractPaginationMeta(res));
      })
      .catch((e) => { console.error('Admin Users Fetch Error:', e); toast.error(formatErrorMessage(e, 'Failed to refresh users list.')); });
  }, [user?.id, view, usersPage, userRoleFilter, debouncedUserSearch]);

  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    if (view !== 'invites') return;
    api.admin
      .getInvites({ page: invitesPage, limit: PAGE_SIZE })
      .then((res) => {
        setInvites(asArray(res));
        setInvitesPagination(extractPaginationMeta(res));
      })
      .catch((e) => { console.error('Admin Invites Fetch Error:', e); toast.error(formatErrorMessage(e, 'Failed to refresh invites.')); });
  }, [user?.id, view, invitesPage]);

  // Fetch orders when switching to orders/finance view or when page changes
  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    if (view !== 'orders' && view !== 'finance') return;
    api.admin.getFinancials({ page: ordersPage, limit: PAGE_SIZE }).then((res) => {
      const safeOrders = asArray<Order>(res);
      setOrders(safeOrders);
      setOrdersPagination(extractPaginationMeta(res));
      setProofModal((prev) => {
        if (!prev) return prev;
        const updated = safeOrders.find((ord: Order) => ord.id === prev.id);
        return updated || null;
      });
    }).catch((e) => { console.error('Admin Orders Fetch Error:', e); toast.error(formatErrorMessage(e, 'Failed to refresh orders.')); });
  }, [user?.id, view, ordersPage]);

  // Fetch products when switching to inventory view or when page changes
  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    if (view !== 'inventory') return;
    api.admin.getProducts({ page: productsPage, limit: PAGE_SIZE }).then((res) => {
      setProducts(asArray(res));
      setProductsPagination(extractPaginationMeta(res));
    }).catch((e) => { console.error('Admin Products Fetch Error:', e); toast.error(formatErrorMessage(e, 'Failed to refresh products.')); });
  }, [user?.id, view, productsPage]);

  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    if (view !== 'settings') return;
    fetchSystemConfig();
  }, [user?.id, view]);

  // Fetch tickets when switching to support/feedback view
  useEffect(() => {
    if (!user?.id || user.role !== 'admin') return;
    if (view !== 'support' && view !== 'feedback') return;
    api.tickets.getAll({ issueType: view === 'feedback' ? 'Feedback' : 'Support' })
      .then((res) => setTickets(asArray(res)))
      .catch((e) => { console.error('Admin Tickets Fetch Error:', e); toast.error(formatErrorMessage(e, 'Failed to load tickets.')); });
  }, [user?.id, view]);

  /** Refresh only the data needed for the active tab/view (instead of ALL endpoints). */
  const refreshCurrentView = async () => {
    try {
      switch (view) {
        case 'dashboard':
          Promise.allSettled([api.admin.getStats(), api.admin.getGrowthAnalytics()]).then(([s, g]) => {
            if (s.status === 'fulfilled') setStats(s.value);
            if (g.status === 'fulfilled') setChartData(asArray(g.value));
          });
          break;
        case 'users': {
          const role = userRoleFilter === 'All' ? 'all' : userRoleFilter.toLowerCase();
          const search = debouncedUserSearch.trim() || undefined;
          api.admin.getUsers(role, { page: usersPage, limit: PAGE_SIZE, search }).then((res) => {
            setUsers(asArray(res));
            setUsersPagination(extractPaginationMeta(res));
          }).catch(() => {});
          break;
        }
        case 'orders':
        case 'finance':
          api.admin.getFinancials({ page: ordersPage, limit: PAGE_SIZE }).then((res) => {
            const safeOrders = asArray<Order>(res);
            setOrders(safeOrders);
            setOrdersPagination(extractPaginationMeta(res));
            setProofModal((prev) => {
              if (!prev) return prev;
              const updated = safeOrders.find((ord: Order) => ord.id === prev.id);
              return updated || null;
            });
          }).catch(() => {});
          break;
        case 'inventory':
          api.admin.getProducts({ page: productsPage, limit: PAGE_SIZE }).then((res) => {
            setProducts(asArray(res));
            setProductsPagination(extractPaginationMeta(res));
          }).catch(() => {});
          break;
        case 'support':
        case 'feedback':
          api.tickets.getAll({ issueType: view === 'feedback' ? 'Feedback' : 'Support' }).then((t) => setTickets(asArray(t))).catch(() => {});
          break;
        case 'invites':
          api.admin.getInvites({ page: invitesPage, limit: PAGE_SIZE }).then((res) => {
            setInvites(asArray(res));
            setInvitesPagination(extractPaginationMeta(res));
          }).catch(() => {});
          break;
        default:
          break;
      }
    } catch (e) {
      console.error('Admin Realtime Refresh Error:', e);
    }
  };
  refreshCurrentViewRef.current = refreshCurrentView;

  /** Refresh only the current tab's data (used by DesktopShell onRefresh) */
  const fetchAllData = async () => {
    setIsLoading(true);
    try {
      await refreshCurrentView();
    } catch (e) {
      console.error('Admin Data Fetch Error:', e);
      toast.error(formatErrorMessage(e, 'Failed to load admin data. Please refresh the page.'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    const trimmedPasskey = String(passkey || '').trim();
    if (!trimmedPasskey || trimmedPasskey.length < 8) {
      setAuthError('Security key must be at least 8 characters.');
      return;
    }
    if (trimmedPasskey.length > 200) {
      setAuthError('Security key must not exceed 200 characters.');
      return;
    }
    setIsAuthLoading(true);
    try {
      const u = await loginAdmin(String(adminId || '').trim(), trimmedPasskey);
      if (u?.role !== 'admin') {
        logout();
        setAuthError('This account is not an admin. Please use the correct portal.');
      }
    } catch (err: any) {
      const msg = String(err?.message || '').trim();
      setAuthError(msg || 'Invalid Admin Credentials');
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleGenerateInvite = async () => {
    if (!inviteLabel.trim()) {
      toast.error("Label required (e.g. 'Nike India')");
      return;
    }
    setIsLoading(true);
    try {
      await api.admin.generateInvite(inviteRole, inviteLabel);
      const updated = await api.admin.getInvites({ page: invitesPage, limit: PAGE_SIZE });
      setInvites(asArray(updated));
      setInvitesPagination(extractPaginationMeta(updated));
      setInviteLabel('');
      toast.success('Invite generated');
    } catch (e) {
      toast.error(formatErrorMessage(e, 'Failed to generate invite'));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleUserStatus = async (target: User) => {
    if (target.role === 'admin') return;
    const newStatus = target.status === 'active' ? 'suspended' : 'active';
    try {
      await api.admin.updateUserStatus(target.id, newStatus);
      setUsers(users.map((u) => (u.id === target.id ? { ...u, status: newStatus } : u)));
    } catch (err) {
      toast.error(formatErrorMessage(err, 'Failed to update user status'));
    }
  };

  const deleteWallet = async (target: User) => {
    if (target.role === 'admin') return;
    const hasBalance = Number(target.walletBalance || 0) > 0 || Number(target.walletPending || 0) > 0;
    if (hasBalance) {
      toast.error('Wallet has funds; cannot delete');
      return;
    }
    const ok = await confirm({ message: 'Delete this wallet? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!ok) return;
    setDeletingWalletId(target.id);
    try {
      await api.admin.deleteWallet(target.id);
      toast.success('Wallet deleted');
      const updated = await api.admin.getUsers('all', { page: usersPage, limit: PAGE_SIZE });
      setUsers(asArray(updated));
      setUsersPagination(extractPaginationMeta(updated));
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to delete wallet'));
    } finally {
      setDeletingWalletId(null);
    }
  };

  const deleteUser = async (target: User) => {
    if (target.role === 'admin') return;
    const ok = await confirm({ message: 'Delete this user? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!ok) return;
    setDeletingUserId(target.id);
    try {
      await api.admin.deleteUser(target.id);
      toast.success('User deleted');
      const updated = await api.admin.getUsers('all', { page: usersPage, limit: PAGE_SIZE });
      setUsers(asArray(updated));
      setUsersPagination(extractPaginationMeta(updated));
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to delete user'));
    } finally {
      setDeletingUserId(null);
    }
  };

  const deleteProduct = async (productId: string) => {
    const ok = await confirm({ message: 'Delete this product/deal? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!ok) return;
    setDeletingProductId(productId);
    try {
      await api.admin.deleteProduct(productId);
      toast.success('Product deleted');
      const updated = await api.admin.getProducts({ page: productsPage, limit: PAGE_SIZE });
      setProducts(asArray(updated));
      setProductsPagination(extractPaginationMeta(updated));
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to delete product'));
    } finally {
      setDeletingProductId(null);
    }
  };

  const resolveTicket = async (id: string, status: 'Resolved' | 'Rejected', note?: string) => {
    try {
      await api.tickets.update(id, status, note || undefined);
      setTickets(tickets.map((t) => (t.id === id ? { ...t, status, resolutionNote: note || undefined } : t)));
      toast.success(`Ticket ${status.toLowerCase()} successfully`);
      setResolvingTicketId(null);
      setResolutionNote('');
    } catch (e: any) {
      toast.error(formatErrorMessage(e, `Failed to ${status.toLowerCase()} ticket`));
    }
  };

  const deleteTicket = async (id: string) => {
    const t = tickets.find((x) => x.id === id);
    if (!t) return;
    if (t.status === 'Open') {
      toast.error('Resolve or reject the ticket before deleting');
      return;
    }
    const ok = await confirm({ message: 'Delete this ticket? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!ok) return;
    try {
      await api.tickets.delete(id);
      setTickets(tickets.filter((x) => x.id !== id));
      toast.success('Ticket deleted');
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to delete ticket'));
    }
  };

  const reopenTicket = async (id: string) => {
    try {
      await api.tickets.update(id, 'Open');
      setTickets(tickets.map((t) => (t.id === id ? { ...t, status: 'Open' as const } : t)));
      toast.success('Ticket reopened');
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to reopen ticket'));
    }
  };

  const exportTicketsCsv = () => {
    const supportTickets = tickets.filter((t) => t.issueType !== 'Feedback');
    if (supportTickets.length === 0) { toast.error('No tickets to export'); return; }
    const header = ['Ticket ID', 'Status', 'Issue Type', 'Description', 'User', 'Role', 'Target Role', 'Order ID', 'Resolution Note', 'Resolved By', 'Resolved At', 'Created At'].map(csvSafe).join(',');
    const rows = supportTickets.map((t) => [
      csvSafe(t.id.slice(-8)),
      csvSafe(t.status),
      csvSafe(t.issueType),
      csvSafe(t.description),
      csvSafe(t.userName),
      csvSafe(t.role || ''),
      csvSafe((t as any).targetRole || ''),
      csvSafe(t.externalOrderId || t.orderId || ''),
      csvSafe((t as any).resolutionNote || ''),
      csvSafe((t as any).resolvedByName || ''),
      csvSafe((t as any).resolvedAt ? new Date((t as any).resolvedAt).toLocaleDateString('en-GB') : ''),
      csvSafe(t.createdAt ? new Date(t.createdAt).toLocaleDateString('en-GB') : ''),
    ].join(','));
    downloadCsv(`tickets_${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows].join('\n'));
    toast.success(`Exported ${supportTickets.length} tickets`);
  };

  const deleteInvite = async (code: string) => {
    const inv: any = invites.find((x: any) => x.code === code);
    if (!inv) return;
    const useCount = Number(inv.useCount ?? 0);
    if (String(inv.status) !== 'active' || useCount > 0) {
      toast.error('Only unused active codes can be deleted');
      return;
    }
    const ok = await confirm({ message: 'Delete this access code? This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive' });
    if (!ok) return;
    try {
      await api.admin.deleteInvite(code);
      setInvites(invites.filter((x) => x.code !== code));
      toast.success('Access code deleted');
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to delete access code'));
    }
  };

  const handleSaveConfig = async () => {
    setIsLoading(true);
    try {
      const saved = await api.admin.updateConfig({ adminContactEmail: configEmail });
      if (saved?.adminContactEmail) setConfigEmail(String(saved.adminContactEmail));
      toast.success('System configuration saved');
    } catch (e: any) {
      toast.error(formatErrorMessage(e, 'Failed to save system configuration'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleExport = async (reportType: 'orders' | 'finance') => {
    const dataToExport = filteredOrders;
    if (!dataToExport || dataToExport.length === 0) {
      toast.info('No data available to export.');
      return;
    }

    const apiBase = getDirectBackendUrl();

    // Fetch signed proof tokens so Excel/Sheets can open proof images without auth
    let proofTokens: Record<string, Record<string, string | null>> = {};
    try {
      proofTokens = await api.orders.batchProofUrls(dataToExport.map((o: any) => o.id));
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
    const hyperlinkYes = (url?: string) => (url ? csvEscape(`=HYPERLINK("${url}","Yes")`) : 'No');

    const headers = [
      'Order ID',
      'Date',
      'Time',
      'Customer Name',
      'Customer Mobile',
      'Reviewer Name',
      'Brand',
      'Product',
      'Platform',
      'Deal Type',
      'Quantity',
      'Unit Price',
      'Total Amount',
      'Settlement Date',
      'Order Status',
      'Payment Status',
      'Verification Status',
      'Mediator Name',
      'Mediator Code',
      'Agency Name',
      'Internal Ref',
      'Sold By',
      'Order Date',
      'Extracted Product',
      'UTR/Reference',
      'Payment Mode',
      'Proof: Order',
      'Proof: Payment',
      'Proof: Rating',
      'Proof: Review',
      'Proof: Return Window',
    ];

    const csvRows = [headers.join(',')];

    dataToExport.forEach((order) => {
      const dateObj = new Date(order.createdAt);
      const dateStr = dateObj.toLocaleDateString('en-GB');
      const timeStr = dateObj.toLocaleTimeString('en-GB');
      const item = order.items?.[0];

      const row = [
        csvSafe(order.externalOrderId || order.id),
        dateStr,
        timeStr,
        csvSafe(order.buyerName || ''),
        csvSafe(order.buyerMobile || ''),
        csvSafe((order as any).reviewerName || ''),
        csvSafe(order.brandName ?? item?.brandName ?? ''),
        csvSafe(item?.title ?? ''),
        csvSafe(item?.platform ?? ''),
        csvSafe(item?.dealType ?? 'Discount'),
        item?.quantity ?? 1,
        item?.priceAtPurchase ?? 0,
        order.total,
        (order as any).expectedSettlementDate ? new Date((order as any).expectedSettlementDate).toLocaleDateString('en-GB') : '',
        csvSafe(order.status || ''),
        csvSafe(order.paymentStatus || ''),
        csvSafe(order.affiliateStatus || ''),
        csvSafe(order.managerName || ''),
        csvSafe((order as any).mediatorCode || (order as any).managerCode || ''),
        csvSafe(order.agencyName || 'Direct'),
        order.id,
        csvSafe(order.soldBy || ''),
        order.orderDate ? new Date(order.orderDate).toLocaleDateString('en-GB') : '',
        csvSafe(order.extractedProductName || ''),
        csvSafe(order.settlementRef || ''),
        csvSafe(order.settlementMode || ''),
        order.screenshots?.order ? hyperlinkYes(buildSignedProofUrl(order.id, 'order')) : 'No',
        order.screenshots?.payment ? hyperlinkYes(buildSignedProofUrl(order.id, 'payment')) : 'No',
        order.screenshots?.rating ? hyperlinkYes(buildSignedProofUrl(order.id, 'rating')) : 'No',
        (order.reviewLink || order.screenshots?.review)
          ? hyperlinkYes(buildSignedProofUrl(order.id, 'review'))
          : 'No',
        (order.screenshots as any)?.returnWindow
          ? hyperlinkYes(buildSignedProofUrl(order.id, 'returnWindow'))
          : 'No',
      ];
      csvRows.push(row.join(','));
    });

    const csvString = csvRows.join('\n');
    downloadCsv(`buzzma_admin_${reportType}_report_${new Date().toISOString().slice(0, 10)}.csv`, csvString);
  };

  const handleExportToSheets = (reportType: 'orders' | 'finance') => {
    const dataToExport = filteredOrders;
    if (!dataToExport || dataToExport.length === 0) {
      toast.info('No data available to export.');
      return;
    }
    const sheetHeaders = ['Order ID','Date','Time','Customer Name','Customer Mobile','Reviewer Name','Brand','Product','Platform','Deal Type','Quantity','Unit Price','Total Amount','Settlement Date','Order Status','Payment Status','Verification Status','Mediator Name','Mediator Code','Agency Name','Internal Ref','Sold By','Order Date','Extracted Product','UTR/Reference','Payment Mode'];
    const sheetRows = dataToExport.map((order) => {
      const dateObj = new Date(order.createdAt);
      const item = order.items?.[0];
      return [
        order.externalOrderId || order.id,
        dateObj.toLocaleDateString('en-GB'),
        dateObj.toLocaleTimeString('en-GB'),
        order.buyerName || '',
        order.buyerMobile || '',
        (order as any).reviewerName || '',
        order.brandName ?? item?.brandName ?? '',
        item?.title ?? '',
        item?.platform ?? '',
        item?.dealType ?? 'Discount',
        item?.quantity ?? 1,
        item?.priceAtPurchase ?? 0,
        order.total,
        (order as any).expectedSettlementDate ? new Date((order as any).expectedSettlementDate).toLocaleDateString('en-GB') : '',
        order.status,
        order.paymentStatus,
        order.affiliateStatus || '',
        order.managerName || '',
        (order as any).mediatorCode || (order as any).managerCode || '',
        order.agencyName || 'Direct',
        order.id,
        order.soldBy || '',
        order.orderDate ? new Date(order.orderDate).toLocaleDateString('en-GB') : '',
        order.extractedProductName || '',
        order.settlementRef || '',
        order.settlementMode || '',
      ] as (string | number)[];
    });
    exportToGoogleSheet({
      title: `Buzzma Admin ${reportType} Report - ${new Date().toISOString().slice(0, 10)}`,
      headers: sheetHeaders,
      rows: sheetRows,
      sheetName: reportType === 'finance' ? 'Finance' : 'Orders',
      onStart: () => setSheetsExporting(true),
      onEnd: () => setSheetsExporting(false),
      onSuccess: () => toast.success('Exported to Google Sheets!'),
      onError: (msg) => toast.error(typeof msg === 'string' ? msg : 'Google Sheets export failed. Please try again.'),
    });
  };

  const filteredUsers = useMemo(() => {
    let result = users;
    if (userRoleFilter !== 'All') {
      result = result.filter((u) => u.role.toLowerCase() === userRoleFilter.toLowerCase());
    }
    if (userSearch.trim()) {
      const q = userSearch.trim().toLowerCase();
      result = result.filter(
        (u) =>
          (u.name || '').toLowerCase().includes(q) ||
          (u.mobile || '').toLowerCase().includes(q) ||
          (u.email || '').toLowerCase().includes(q) ||
          (u.mediatorCode || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [users, userRoleFilter, userSearch]);

  const filteredOrders = useMemo(() => {
    let result = orders;
    if (orderStatusFilter !== 'All') {
      result = result.filter((o) => {
        const status = o.affiliateStatus === 'Unchecked' ? o.paymentStatus : o.affiliateStatus;
        return String(status).toLowerCase() === orderStatusFilter.toLowerCase();
      });
    }
    if (orderSearch.trim()) {
      const q = orderSearch.trim().toLowerCase();
      result = result.filter(
        (o) =>
          (o.externalOrderId || o.id || '').toLowerCase().includes(q) ||
          (o.buyerName || '').toLowerCase().includes(q) ||
          (o.items?.[0]?.title || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [orders, orderStatusFilter, orderSearch]);

  const filteredProducts = useMemo(() => {
    if (!inventorySearch.trim()) return products;
    const q = inventorySearch.trim().toLowerCase();
    return products.filter(
      (p) =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.platform || '').toLowerCase().includes(q)
    );
  }, [products, inventorySearch]);

  // Campaign title map: campaignId → product title (for order table display)
  const campaignTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    products.forEach((p) => { if (p.campaignId && p.title) map.set(p.campaignId, p.title); });
    return map;
  }, [products]);

  // --- AUTH GUARD ---
  if (!user || user.role !== 'admin') {
    return (
      <div className="min-h-[100dvh] bg-[#0F172A] flex items-center justify-center p-6 font-sans relative overflow-hidden">
        {/* Background Grid */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] opacity-20"></div>

        <div className="bg-[#1E293B] p-10 rounded-[2rem] w-full max-w-md border border-slate-700 shadow-2xl relative z-10">
          <div className="flex justify-center mb-8">
            <div className="w-20 h-20 bg-indigo-500/10 rounded-3xl flex items-center justify-center border border-indigo-500/20 shadow-[0_0_40px_-10px_rgba(99,102,241,0.5)]">
              <ShieldAlert size={40} className="text-indigo-400" />
            </div>
          </div>

          <h1 className="text-3xl font-extrabold text-white text-center mb-2 tracking-tight">
            System Admin
          </h1>
          <p className="text-slate-400 text-center text-sm mb-8 font-medium">
            Restricted Access Environment
          </p>

          <form onSubmit={handleLogin} className="space-y-5">
            {authError && (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-bold rounded-xl text-center flex items-center justify-center gap-2">
                <AlertTriangle size={14} /> {authError}
              </div>
            )}
            <Input
              tone="dark"
              label="Username"
              type="text"
              value={adminId}
              onChange={(e) => setAdminId(e.target.value)}
              placeholder="root"
              leftIcon={<Terminal size={18} />}
              className="font-mono text-sm"
              autoCapitalize="none"
              autoComplete="username"
            />

            <Input
              tone="dark"
              label="Security Key"
              type="password"
              value={passkey}
              onChange={(e) => setPasskey(e.target.value)}
              placeholder="••••••••"
              leftIcon={<Key size={18} />}
              className="font-mono text-sm"
              minLength={8}
              maxLength={200}
              autoComplete="current-password"
            />

            <Button
              type="submit"
              size="lg"
              disabled={isAuthLoading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/20"
              rightIcon={isAuthLoading ? <Spinner className="w-5 h-5 text-current" /> : null}
            >
              Authenticate Session
            </Button>
          </form>

          
        </div>
      </div>
    );
  }

  return (
    <>
    {ConfirmDialogElement}
    <DesktopShell
      isSidebarOpen={isSidebarOpen}
      onSidebarOpenChange={setIsSidebarOpen}
      showMobileHeader={false}
      containerClassName="flex h-[100dvh] min-h-0 bg-[#F8F9FA] font-sans overflow-hidden relative"
      sidebarWidthClassName="w-72"
      asideClassName="bg-[#0F172A] flex flex-col border-r border-slate-800"
      mainClassName="flex-1 min-w-0 min-h-0 overflow-hidden relative flex flex-col"
      sidebar={
        <>
          <div className="p-6 pb-2">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/20">
                  <Database size={20} />
                </div>
                <div>
                  <h1 className="text-white font-black text-lg tracking-tight">
                    BUZZMA<span className="text-indigo-500">Admin</span>
                  </h1>
                  <div className="flex items-center gap-2">
                    <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">
                      v3.0.1 Stable
                    </p>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsSidebarOpen(false)}
                aria-label="Close sidebar"
                className="md:hidden p-2 text-slate-400 hover:text-white rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              >
                <XCircle size={22} />
              </button>
            </div>

            <div className="space-y-1">
              <p className="px-4 py-2 text-[10px] font-extrabold text-slate-500 uppercase tracking-widest">
                Main
              </p>
              <SidebarItem
                icon={LayoutGrid}
                label="Overview"
                active={view === 'dashboard'}
                onClick={() => switchView('dashboard')}
              />
              <SidebarItem
                icon={Users}
                label="Users"
                active={view === 'users'}
                onClick={() => switchView('users')}
                badge={usersPagination?.total ?? users.length}
              />
              <SidebarItem
                icon={ShoppingCart}
                label="Orders"
                active={view === 'orders'}
                onClick={() => switchView('orders')}
                badge={ordersPagination?.total ?? orders.length}
              />
              <SidebarItem
                icon={Package}
                label="Inventory"
                active={view === 'inventory'}
                onClick={() => switchView('inventory')}
              />

              <p className="px-4 py-2 text-[10px] font-extrabold text-slate-500 uppercase tracking-widest mt-6">
                System
              </p>
              <SidebarItem
                icon={DollarSign}
                label="Financials"
                active={view === 'finance'}
                onClick={() => switchView('finance')}
              />
              <SidebarItem
                icon={HeadphonesIcon}
                label="Support Desk"
                active={view === 'support'}
                onClick={() => switchView('support')}
                badge={tickets.filter((t) => t.status === 'Open' && t.issueType !== 'Feedback').length}
              />
              <SidebarItem
                icon={Star}
                label="Feedbacks"
                active={view === 'feedback'}
                onClick={() => switchView('feedback')}
                badge={tickets.filter((t) => t.issueType === 'Feedback').length}
              />
              <SidebarItem
                icon={Key}
                label="Access Codes"
                active={view === 'invites'}
                onClick={() => switchView('invites')}
                badge={invites.filter((i) => i.status === 'active').length}
              />
              <SidebarItem
                icon={Settings}
                label="Settings"
                active={view === 'settings'}
                onClick={() => switchView('settings')}
              />
              <SidebarItem
                icon={ClipboardList}
                label="Audit Logs"
                active={view === 'audit-logs'}
                onClick={() => switchView('audit-logs')}
              />
            </div>
          </div>

          <div className="mt-auto p-4 border-t border-slate-800">
            <button
              type="button"
              onClick={logout}
              className="w-full py-3 flex items-center justify-center gap-2 text-rose-400 hover:bg-slate-800 rounded-xl transition-colors text-xs font-bold uppercase tracking-wider"
            >
              <LogOut size={16} /> Terminate
            </button>
          </div>
        </>
      }
    >
        {/* Header */}
        <header className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-8 flex-none z-10 sticky top-0">
          <div className="flex items-center gap-3 min-w-0">
            <IconButton
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open sidebar"
              title="Menu"
              className="md:hidden text-slate-400 hover:text-indigo-600 hover:border-indigo-200"
            >
              <Menu size={20} />
            </IconButton>
            <h2 className="text-2xl font-black text-slate-900 capitalize tracking-tight truncate">
              {view.replace('-', ' ')}
            </h2>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-px h-8 bg-slate-200"></div>
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-sm font-bold text-slate-900">Admin User</p>
                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wide">
                  Online
                </p>
              </div>
              <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-700 font-bold border-2 border-white shadow-sm">
                AD
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 scrollbar-styled bg-[#F8FAFC]">
          <div className="max-w-[1600px] mx-auto space-y-8 animate-enter">
            {/* DASHBOARD VIEW */}
            {view === 'dashboard' && stats && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <StatCard
                    title="Total Revenue"
                    value={`${((stats?.totalRevenue || 0) / 100000).toFixed(2)}L`}
                    subtext="Gross Volume"
                    icon={IndianRupee}
                    colorClass="text-emerald-600"
                  />
                  <StatCard
                    title="Pending Clearance"
                    value={`${((stats?.pendingRevenue || 0) / 100000).toFixed(2)}L`}
                    subtext="In Cooling Period"
                    icon={Wallet}
                    colorClass="text-blue-600"
                  />
                  <StatCard
                    title="Orders Processed"
                    value={(stats?.totalOrders || 0).toLocaleString('en-GB')}
                    subtext="Total"
                    icon={ShoppingCart}
                    colorClass="text-purple-600"
                  />
                  <StatCard
                    title="System Alerts"
                    value={stats?.riskOrders || 0}
                    subtext="Action Required"
                    icon={ShieldAlert}
                    colorClass="text-rose-500"
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  {/* Chart */}
                  <div className="lg:col-span-2 bg-white p-8 rounded-[2rem] border border-slate-100 shadow-sm flex flex-col h-[450px]">
                    <div className="flex justify-between items-center mb-8">
                      <div>
                        <h3 className="font-extrabold text-lg text-slate-900">Revenue Growth</h3>
                        <p className="text-xs font-bold text-slate-400 mt-1">
                          Real-time performance metrics
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <span className="px-3 py-1 bg-indigo-50 text-indigo-700 rounded-lg text-[10px] font-bold uppercase tracking-wide border border-indigo-100">
                          Weekly
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 w-full min-h-0">
                      <ChartSuspense>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData}>
                          <defs>
                            <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                          <XAxis
                            dataKey="date"
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 11, fontWeight: 600, fill: '#94a3b8' }}
                            dy={10}
                          />
                          <YAxis
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 11, fontWeight: 600, fill: '#94a3b8' }}
                            tickFormatter={(v: number) => `${v / 1000}k`}
                          />
                          <Tooltip
                            cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '4 4' }}
                            contentStyle={{
                              borderRadius: '16px',
                              border: 'none',
                              boxShadow: '0 10px 40px -10px rgba(0,0,0,0.1)',
                              padding: '12px 20px',
                            }}
                            itemStyle={{ color: '#1e293b', fontWeight: 'bold' }}
                          />
                          <Area
                            type="monotone"
                            dataKey="revenue"
                            stroke="#6366f1"
                            strokeWidth={3}
                            fillOpacity={1}
                            fill="url(#colorRev)"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                      </ChartSuspense>
                    </div>
                  </div>

                  {/* Quick Widgets */}
                  <div className="space-y-6">
                    <div className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm">
                      <h3 className="font-extrabold text-slate-900 mb-4">User Distribution</h3>
                      <div className="space-y-4">
                        {['User', 'Mediator', 'Agency', 'Brand'].map((role, i) => {
                          const count = stats?.counts?.[role.toLowerCase()] || 0;
                          const total = Math.max(0, stats?.counts?.total || 0);
                          const pctRaw = total > 0 ? Math.round((count / total) * 100) : 0;
                          const pct = Math.max(0, Math.min(100, pctRaw));
                          return (
                            <div key={role}>
                              <div className="flex justify-between text-xs font-bold text-slate-600 mb-1">
                                <span>{role === 'Agency' ? 'Agencies' : `${role}s`}</span>
                                <span>
                                  {count} ({pct}%)
                                </span>
                              </div>
                              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full"
                                  style={{ width: `${pct}%`, backgroundColor: COLORS[i] }}
                                ></div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="bg-indigo-900 p-6 rounded-[2rem] shadow-xl text-white relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-32 h-32 bg-white opacity-10 rounded-full blur-3xl -mr-10 -mt-10"></div>
                      <h3 className="font-bold text-lg relative z-10">System Status</h3>
                      <div className="flex items-center gap-2 mt-4 text-emerald-400 font-bold text-sm">
                        <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>{' '}
                        All Systems Operational
                      </div>
                      <p className="text-indigo-200 text-xs mt-2 font-medium">
                        Last check: Just now
                      </p>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* SUPPORT VIEW */}
            {view === 'support' && (() => {
              const supportTickets = tickets.filter((t) => t.issueType !== 'Feedback');
              // Normalize role for filtering: backend sends 'user' for shoppers, 'admin' for ops
              const normalizeRole = (r: string) => { const l = (r || '').toLowerCase(); return l === 'user' || l === 'shopper' ? 'shopper' : l === 'ops' ? 'admin' : l; };
              const filteredTickets = supportTickets.filter((t) => {
                if (ticketRoleFilter !== 'All' && normalizeRole(t.role) !== ticketRoleFilter.toLowerCase()) return false;
                if (ticketStatusFilter !== 'All' && t.status !== ticketStatusFilter) return false;
                if (ticketSearch.trim()) {
                  const q = ticketSearch.trim().toLowerCase();
                  if (
                    !(t.issueType || '').toLowerCase().includes(q) &&
                    !(t.description || '').toLowerCase().includes(q) &&
                    !(t.userName || '').toLowerCase().includes(q) &&
                    !(t.externalOrderId || t.orderId || '').toLowerCase().includes(q) &&
                    !t.id.toLowerCase().includes(q)
                  ) return false;
                }
                return true;
              });
              const roleCounts = {
                All: supportTickets.length,
                Shopper: supportTickets.filter((t) => normalizeRole(t.role) === 'shopper').length,
                Mediator: supportTickets.filter((t) => normalizeRole(t.role) === 'mediator').length,
                Agency: supportTickets.filter((t) => normalizeRole(t.role) === 'agency').length,
                Brand: supportTickets.filter((t) => normalizeRole(t.role) === 'brand').length,
                Admin: supportTickets.filter((t) => normalizeRole(t.role) === 'admin').length,
              };
              return (
              <div className="space-y-6 animate-enter">
                <div className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-indigo-50 text-indigo-600 rounded-2xl">
                      <HeadphonesIcon size={24} />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold text-slate-900">Support Desk</h3>
                      <p className="text-xs font-bold text-slate-400">
                        Manage user disputes and tickets
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="bg-indigo-50 text-indigo-700 px-4 py-2 rounded-xl text-xs font-bold">
                      {filteredTickets.filter((t) => t.status === 'Open').length} Pending
                    </div>
                    <button type="button" onClick={exportTicketsCsv} className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-all">
                      Export CSV
                    </button>
                  </div>
                </div>

                {/* Search Bar */}
                <input
                  type="text"
                  value={ticketSearch}
                  onChange={(e) => setTicketSearch(e.target.value)}
                  placeholder="Search tickets by name, issue, description, order ID..."
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 transition-all"
                />

                {/* Role Filter Tabs */}
                <div className="flex flex-wrap gap-2">
                  {(['All', 'Shopper', 'Mediator', 'Agency', 'Brand', 'Admin'] as const).map((role) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => setTicketRoleFilter(role)}
                      className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                        ticketRoleFilter === role
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'bg-white text-slate-500 border border-slate-200 hover:border-indigo-300 hover:text-indigo-600'
                      }`}
                    >
                      {role} {roleCounts[role] > 0 ? `(${roleCounts[role]})` : ''}
                    </button>
                  ))}
                  <div className="ml-auto flex gap-2">
                    {(['All', 'Open', 'Resolved', 'Rejected'] as const).map((status) => (
                      <button
                        key={status}
                        type="button"
                        onClick={() => setTicketStatusFilter(status)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${
                          ticketStatusFilter === status
                            ? status === 'Open' ? 'bg-amber-100 text-amber-700 border border-amber-200'
                              : status === 'Resolved' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                              : status === 'Rejected' ? 'bg-rose-100 text-rose-700 border border-rose-200'
                              : 'bg-slate-800 text-white'
                            : 'bg-white text-slate-400 border border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 max-h-[70dvh] overflow-y-auto scrollbar-styled">
                  {isLoading ? (
                    <div className="col-span-full">
                      <EmptyState
                        title="Loading tickets"
                        description="Loading the latest support queue"
                        icon={<Spinner className="w-6 h-6 text-slate-400" />}
                        className="border-slate-200"
                      />
                    </div>
                  ) : filteredTickets.length === 0 ? (
                    <div className="col-span-full">
                      <EmptyState
                        title="No tickets"
                        description={ticketRoleFilter !== 'All' || ticketStatusFilter !== 'All' ? 'No tickets match the current filters.' : 'When users raise disputes or issues, they\'ll appear here.'}
                        className="border-slate-200"
                      />
                    </div>
                  ) : (
                    filteredTickets.map((t) => (
                      <div
                        key={t.id}
                        className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm flex flex-col hover:shadow-md transition-all cursor-pointer"
                        onClick={() => setSelectedTicket(t)}
                      >
                        <div className="flex justify-between items-start mb-4">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[10px] font-mono text-slate-400">
                                #{t.id.slice(-6)}
                              </span>
                              <StatusBadge status={t.status} />
                            </div>
                            <h4 className="font-bold text-slate-900 text-sm">{t.issueType}</h4>
                          </div>
                          <span className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2 py-1 rounded">
                            {new Date(t.createdAt).toLocaleDateString('en-GB')}
                          </span>
                        </div>

                        <div className="bg-slate-50 p-3 rounded-xl mb-4 flex-1">
                          <p className="text-xs text-slate-600 font-medium leading-relaxed">
                            "{t.description}"
                          </p>
                          {(t.externalOrderId || t.orderId) && (
                            <p className="text-[10px] text-slate-400 mt-1.5"><span className="font-bold">Order:</span> {t.externalOrderId || t.orderId}</p>
                          )}
                        </div>

                        {/* Resolution Note */}
                        {t.status !== 'Open' && (t as any).resolutionNote && (
                          <div className="bg-emerald-50 border border-emerald-100 p-3 rounded-xl mb-4">
                            <p className="text-[10px] font-bold text-emerald-700 uppercase mb-1">Resolution Note</p>
                            <p className="text-xs text-emerald-600 font-medium">{(t as any).resolutionNote}</p>
                          </div>
                        )}

                        <div className="flex items-center justify-between mt-auto">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center font-bold text-xs text-slate-500">
                              {(t.userName || '?').charAt(0)}
                            </div>
                            <div className="text-[10px]">
                              <p className="font-bold text-slate-900">{t.userName}</p>
                              <p className="text-slate-400 font-mono capitalize">{normalizeRole(t.role)} → {normalizeRole((t as any).targetRole || 'admin')}</p>
                            </div>
                          </div>

                          {t.status === 'Open' && resolvingTicketId !== t.id && (
                            <div className="flex gap-2">
                              <button type="button" onClick={() => { setResolvingTicketId(t.id); setResolutionNote(''); }}
                                className="p-2 bg-emerald-100 text-emerald-600 rounded-lg hover:bg-emerald-200 transition-colors" title="Resolve / Reject">
                                <CheckCircle2 size={16} />
                              </button>
                            </div>
                          )}
                          {t.status === 'Open' && resolvingTicketId === t.id && (
                            <div className="w-full mt-1 space-y-1.5">
                              <textarea placeholder="Resolution / rejection note (optional)..." value={resolutionNote} onChange={e => setResolutionNote(e.target.value)} rows={2}
                                className="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-none" />
                              <div className="flex items-center gap-2">
                                <button type="button" onClick={() => resolveTicket(t.id, 'Resolved', resolutionNote)}
                                  className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-500 text-white hover:bg-emerald-600">✓ Resolve</button>
                                <button type="button" onClick={() => resolveTicket(t.id, 'Rejected', resolutionNote)}
                                  className="px-3 py-1 rounded-lg text-xs font-bold bg-red-500 text-white hover:bg-red-600">✗ Reject</button>
                                <button type="button" onClick={() => { setResolvingTicketId(null); setResolutionNote(''); }}
                                  className="px-3 py-1 rounded-lg text-xs font-bold bg-slate-100 text-slate-500 hover:bg-slate-200">Cancel</button>
                              </div>
                            </div>
                          )}

                          {t.status !== 'Open' && (
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => reopenTicket(t.id)}
                                className="p-2 bg-amber-100 text-amber-600 rounded-lg hover:bg-amber-200 transition-colors"
                                title="Reopen"
                              >
                                <RefreshCw size={16} />
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteTicket(t.id)}
                                className="p-2 bg-slate-100 text-slate-400 rounded-lg hover:bg-rose-100 hover:text-rose-500 transition-colors"
                                title="Delete"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
              );
            })()}

            {/* FEEDBACK VIEW */}
            {view === 'feedback' && (() => {
              const feedbacks = tickets.filter((t) => t.issueType === 'Feedback');
              const extractRating = (desc: string) => {
                const match = desc.match(/Rating:\s*(\d)/);
                return match ? parseInt(match[1], 10) : 0;
              };
              const extractComment = (desc: string) => {
                return desc.replace(/^Rating:\s*\d\/5\n?/, '').trim();
              };
              const avgRating = feedbacks.length > 0
                ? feedbacks.reduce((acc, f) => acc + extractRating(f.description), 0) / feedbacks.length
                : 0;
              return (
              <div className="space-y-6 animate-enter">
                <div className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="p-3 bg-amber-50 text-amber-600 rounded-2xl">
                      <Star size={24} />
                    </div>
                    <div>
                      <h3 className="text-lg font-extrabold text-slate-900">User Feedbacks</h3>
                      <p className="text-xs font-bold text-slate-400">
                        Reviews and ratings from all portal users
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="bg-amber-50 text-amber-700 px-4 py-2 rounded-xl text-xs font-bold">
                      {feedbacks.length} Total
                    </div>
                    {avgRating > 0 && (
                      <div className="bg-emerald-50 text-emerald-700 px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1">
                        <Star size={12} className="fill-amber-400 text-amber-400" /> {avgRating.toFixed(1)}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                  {isLoading ? (
                    <div className="col-span-full">
                      <EmptyState
                        title="Loading feedbacks"
                        description="Loading user feedbacks..."
                        icon={<Spinner className="w-6 h-6 text-slate-400" />}
                        className="border-slate-200"
                      />
                    </div>
                  ) : feedbacks.length === 0 ? (
                    <div className="col-span-full">
                      <EmptyState
                        title="No feedbacks yet"
                        description="When users submit feedback about the platform, their reviews will appear here."
                        className="border-slate-200"
                      />
                    </div>
                  ) : (
                    feedbacks.map((f) => {
                      const rating = extractRating(f.description);
                      const comment = extractComment(f.description);
                      return (
                        <div
                          key={f.id}
                          className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm flex flex-col hover:shadow-md transition-all"
                        >
                          <div className="flex justify-between items-start mb-3">
                            <div className="flex items-center gap-2">
                              <div className="w-10 h-10 bg-amber-50 rounded-full flex items-center justify-center font-bold text-sm text-amber-600">
                                {(f.userName || '?').charAt(0)}
                              </div>
                              <div>
                                <p className="font-bold text-slate-900 text-sm">{f.userName}</p>
                                <p className="text-[10px] text-slate-400 font-bold capitalize">{f.role || 'User'}</p>
                              </div>
                            </div>
                            <span className="text-[10px] font-bold text-slate-400 bg-slate-50 px-2 py-1 rounded">
                              {new Date(f.createdAt).toLocaleDateString('en-GB')}
                            </span>
                          </div>

                          {/* Star Rating */}
                          <div className="flex items-center gap-0.5 mb-3">
                            {[1, 2, 3, 4, 5].map((s) => (
                              <Star
                                key={s}
                                size={16}
                                className={s <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}
                              />
                            ))}
                            <span className="text-xs font-bold text-slate-600 ml-2">{rating}/5</span>
                          </div>

                          {comment && (
                            <div className="bg-slate-50 p-3 rounded-xl flex-1">
                              <p className="text-xs text-slate-600 font-medium leading-relaxed">
                                "{comment}"
                              </p>
                            </div>
                          )}

                          <div className="flex items-center justify-end mt-3">
                            <button
                              type="button"
                              onClick={() => deleteTicket(f.id)}
                              className="p-2 bg-slate-100 text-slate-400 rounded-lg hover:bg-rose-100 hover:text-rose-500 transition-colors"
                              title="Delete feedback"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              );
            })()}

            {/* USERS VIEW */}
            {view === 'users' && (
              <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden flex flex-col h-full min-h-0 animate-enter">
                <div className="p-5 border-b border-slate-100 flex flex-col gap-3 bg-slate-50/50">
                  <div className="flex justify-between items-center">
                    <div className="flex gap-2">
                      {['All', 'Brand', 'Agency', 'Mediator', 'User'].map((role) => (
                        <button
                          key={role}
                          type="button"
                          onClick={() => { setUserRoleFilter(role); setUsersPage(1); }}
                          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${
                            userRoleFilter === role
                              ? 'bg-slate-900 text-white border-slate-900 shadow-md'
                              : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          {role}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-widest">
                      {usersPagination ? `${usersPagination.total.toLocaleString()} Total` : `${filteredUsers.length} Records`}
                    </div>
                  </div>
                  <div className="relative">
                    <Users size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search by name, mobile, email, or code..."
                      value={userSearch}
                      onChange={(e) => handleUserSearchChange(e.target.value)}
                      className="w-full pl-10 pr-10 py-2.5 rounded-xl text-sm border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none transition-all bg-white placeholder:text-slate-400"
                    />
                    {userSearch && (
                      <button
                        type="button"
                        onClick={() => handleUserSearchChange('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                        aria-label="Clear search"
                      >
                        <XCircle size={16} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="overflow-x-auto max-h-[70dvh] overflow-y-auto scrollbar-styled">
                  <table className="w-full text-left">
                    <thead className="bg-slate-50/80 text-xs font-extrabold uppercase text-slate-400 tracking-wider sticky top-0 z-10 backdrop-blur-sm">
                      <tr>
                        <th className="p-5">User Profile</th>
                        <th className="p-5">Role</th>
                        <th className="p-5">Wallet Balance</th>
                        <th className="p-5">Status</th>
                        <th className="p-5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 text-sm font-medium">
                      {filteredUsers.length === 0 ? (
                        <tr><td colSpan={5} className="p-12 text-center text-slate-400 text-sm font-bold">No users match the current filter.</td></tr>
                      ) : filteredUsers.map((u) => (
                        <tr key={u.id} className="hover:bg-slate-50/50 transition-colors group">
                          <td className="p-5">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center font-bold text-slate-500 text-sm shadow-inner group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors overflow-hidden">
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
                                <p className="font-bold text-slate-900">{u.name || 'Unknown'}</p>
                                <p className="text-xs text-slate-400 font-mono mt-0.5">
                                  {maskMobile(u.mobile)}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="p-5">
                            <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold bg-slate-100 text-slate-600 uppercase tracking-wide border border-slate-200">
                              {u.role}
                            </span>
                          </td>
                          <td className="p-5 font-mono text-slate-700 font-bold">
                            {(u.walletBalance || 0).toLocaleString('en-GB')}
                          </td>
                          <td className="p-5">
                            <StatusBadge status={u.status} />
                          </td>
                          <td className="p-5 text-right">
                            {u.role !== 'admin' && (
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => toggleUserStatus(u)}
                                  className={`p-2 rounded-lg transition-colors border ${
                                    u.status === 'active'
                                      ? 'border-rose-100 text-rose-500 hover:bg-rose-50'
                                      : 'border-emerald-100 text-emerald-500 hover:bg-emerald-50'
                                  }`}
                                  title={u.status === 'active' ? 'Suspend user' : 'Activate user'}
                                >
                                  {u.status === 'active' ? (
                                    <Ban size={16} />
                                  ) : (
                                    <CheckCircle2 size={16} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteWallet(u)}
                                  disabled={
                                    deletingWalletId === u.id ||
                                    Number(u.walletBalance || 0) > 0 ||
                                    Number(u.walletPending || 0) > 0
                                  }
                                  className={`p-2 rounded-lg transition-colors border ${
                                    deletingWalletId === u.id
                                      ? 'border-slate-200 text-slate-400 bg-slate-100 cursor-not-allowed'
                                      : Number(u.walletBalance || 0) > 0 || Number(u.walletPending || 0) > 0
                                        ? 'border-slate-200 text-slate-300 bg-slate-50 cursor-not-allowed'
                                        : 'border-rose-100 text-rose-500 hover:bg-rose-50'
                                  }`}
                                  title="Delete wallet"
                                >
                                  <Trash2 size={16} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteUser(u)}
                                  disabled={deletingUserId === u.id}
                                  className={`p-2 rounded-lg transition-colors border ${
                                    deletingUserId === u.id
                                      ? 'border-slate-200 text-slate-400 bg-slate-100 cursor-not-allowed'
                                      : 'border-rose-100 text-rose-500 hover:bg-rose-50'
                                  }`}
                                  title="Delete user"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {usersPagination && usersPagination.totalPages > 1 && (
                  <Pagination
                    page={usersPage}
                    totalPages={usersPagination.totalPages}
                    total={usersPagination.total}
                    limit={usersPagination.limit}
                    onPageChange={(p) => { setUsersPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  />
                )}
              </div>
            )}

            {/* INVITES VIEW */}
            {view === 'invites' && (
              <div className="space-y-6 animate-enter">
                <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm flex flex-col md:flex-row items-end gap-6">
                  <div className="flex-1 w-full">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1 mb-2 block">
                      Create Invite For
                    </label>
                    <div className="flex gap-4">
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as any)}
                        aria-label="Invite role"
                        className="bg-slate-50 border border-slate-200 text-slate-700 text-sm font-bold rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      >
                        <option value="agency">Agency Partner</option>
                        <option value="brand">Brand Account</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Assignee Label (e.g. Nike)"
                        value={inviteLabel}
                        onChange={(e) => setInviteLabel(e.target.value)}
                        className="flex-1 bg-slate-50 border border-slate-200 text-slate-900 text-sm font-bold rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 placeholder:text-slate-400"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateInvite}
                    disabled={isLoading}
                    className="px-8 py-3.5 bg-slate-900 text-white rounded-xl font-bold text-sm shadow-lg hover:bg-indigo-600 transition-all active:scale-95 flex items-center gap-2 whitespace-nowrap"
                  >
                    <Plus size={18} />
                    Generate Code
                  </button>
                </div>

                <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-slate-50/80 text-xs font-extrabold uppercase text-slate-400 tracking-wider">
                      <tr>
                        <th className="p-6">Access Code</th>
                        <th className="p-6">Role</th>
                        <th className="p-6">Label</th>
                        <th className="p-6">Status</th>
                        <th className="p-6 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {invites.map((inv) => (
                        <tr key={inv.code} className="hover:bg-slate-50/50 transition-colors">
                          <td className="p-6 font-mono text-sm font-bold text-slate-800">
                            {inv.code}
                          </td>
                          <td className="p-6">
                            <StatusBadge status={inv.role} />
                          </td>
                          <td className="p-6 text-sm font-bold text-slate-600">{inv.label}</td>
                          <td className="p-6">
                            <StatusBadge status={inv.status} />
                          </td>
                          <td className="p-6 text-right">
                            <div className="flex items-center justify-end gap-3">
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(inv.code);
                                  toast.success('Copied');
                                }}
                                aria-label="Copy access code"
                                className="text-slate-400 hover:text-indigo-600 transition-colors"
                              >
                                <Copy size={18} />
                              </button>

                              {inv.status === 'active' && Number((inv as any).useCount ?? 0) === 0 && (
                                <button
                                  type="button"
                                  onClick={() => deleteInvite(inv.code)}
                                  aria-label="Delete access code"
                                  className="text-slate-400 hover:text-rose-500 transition-colors"
                                >
                                  <Trash2 size={18} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {invitesPagination && invitesPagination.totalPages > 1 && (
                  <Pagination
                    page={invitesPage}
                    totalPages={invitesPagination.totalPages}
                    total={invitesPagination.total}
                    limit={invitesPagination.limit}
                    onPageChange={(p) => { setInvitesPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  />
                )}
              </div>
            )}

            {/* FINANCE & ORDERS (Simplified Table Re-use) */}
            {(view === 'finance' || view === 'orders') && (
              <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden animate-enter">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                  <h3 className="font-extrabold text-lg text-slate-900">
                    {view === 'finance' ? 'Global Ledger' : 'Order Management'}
                  </h3>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleExport(view === 'finance' ? 'finance' : 'orders')}
                      className="flex items-center gap-2 text-xs font-bold text-indigo-600 bg-indigo-50 px-4 py-2 rounded-xl hover:bg-indigo-100 transition-colors"
                    >
                      <Download size={14} /> CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportToSheets(view === 'finance' ? 'finance' : 'orders')}
                      disabled={sheetsExporting}
                      className="flex items-center gap-2 text-xs font-bold text-green-600 bg-green-50 px-4 py-2 rounded-xl hover:bg-green-100 transition-colors disabled:opacity-50"
                    >
                      <FileSpreadsheet size={14} /> {sheetsExporting ? 'Exporting...' : 'Google Sheets'}
                    </button>
                  </div>
                </div>
                <div className="p-4 border-b border-slate-100 flex gap-3 flex-wrap items-center">
                  <div className="flex-1 min-w-[200px]">
                    <Input
                      placeholder="Search orders (ID, buyer, product)..."
                      value={orderSearch}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOrderSearch(e.target.value)}
                      className="text-sm"
                    />
                  </div>
                  <select
                    value={orderStatusFilter}
                    onChange={(e) => setOrderStatusFilter(e.target.value)}
                    aria-label="Filter by order status"
                    className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold bg-white"
                  >
                    <option value="All">All Statuses</option>
                    <option value="Pending">Pending</option>
                    <option value="Pending_Cooling">Cooling</option>
                    <option value="Approved_Settled">Settled</option>
                    <option value="Rejected_Expired">Expired</option>
                    <option value="Paid">Paid</option>
                  </select>
                  <span className="text-xs text-slate-400 font-bold">{ordersPagination ? `${ordersPagination.total.toLocaleString()} total` : `${filteredOrders.length} orders`}</span>
                </div>
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto scrollbar-styled">
                  <table className="w-full text-left">
                    <thead className="bg-slate-50/80 text-xs font-extrabold uppercase text-slate-400 tracking-wider sticky top-0 z-10">
                      <tr>
                        <th className="p-5">Order Ref</th>
                        <th className="p-5">Date</th>
                        <th className="p-5">Amount</th>
                        <th className="p-5">Customer</th>
                        <th className="p-5">Mediator</th>
                        <th className="p-5">Campaign</th>
                        <th className="p-5">Proofs</th>
                        <th className="p-5 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 text-sm font-medium">
                      {filteredOrders.length === 0 ? (
                        <tr><td colSpan={6} className="p-12 text-center text-slate-400 text-sm font-bold">No orders match the current filter.</td></tr>
                      ) : filteredOrders.map((o) => (
                        <tr key={o.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="p-5">
                            <div className="font-mono text-slate-500">
                              {o.externalOrderId || o.id}
                            </div>
                          </td>
                          <td className="p-5 text-slate-600">
                            {new Date(o.createdAt).toLocaleDateString('en-GB')}
                          </td>
                          <td className="p-5 font-mono text-slate-900 font-bold">{o.total}</td>
                          <td className="p-5 text-slate-700">{o.buyerName}</td>
                          <td className="p-5 text-slate-600 text-xs">{o.managerName || '-'}</td>
                          <td className="p-5 text-slate-600 text-xs truncate max-w-[160px]" title={o.items?.[0]?.campaignId || ''}>{o.items?.[0]?.campaignId ? (campaignTitleMap.get(o.items[0].campaignId) || o.items[0].campaignId.slice(-8)) : '-'}</td>
                          <td className="p-5">
                            <button
                              type="button"
                              onClick={() => setProofModal(o)}
                              className="text-xs font-bold text-indigo-600 hover:text-indigo-800 underline"
                            >
                              View
                            </button>
                          </td>
                          <td className="p-5 text-right">
                            <StatusBadge
                              status={
                                o.affiliateStatus === 'Unchecked'
                                  ? o.paymentStatus
                                  : o.affiliateStatus
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {ordersPagination && ordersPagination.totalPages > 1 && (
                  <Pagination
                    page={ordersPage}
                    totalPages={ordersPagination.totalPages}
                    total={ordersPagination.total}
                    limit={ordersPagination.limit}
                    onPageChange={(p) => { setOrdersPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  />
                )}
              </div>
            )}

            {/* INVENTORY VIEW */}
            {view === 'inventory' && (
              <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden animate-enter">
                <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                  <h3 className="font-extrabold text-lg text-slate-900">Live Inventory</h3>
                  <span className="text-xs text-slate-400 font-bold">{productsPagination ? `${productsPagination.total.toLocaleString()} total` : `${filteredProducts.length} products`}</span>
                </div>
                <div className="p-4 border-b border-slate-100">
                  <Input
                    placeholder="Search products (name, platform)..."
                    value={inventorySearch}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInventorySearch(e.target.value)}
                    className="text-sm"
                  />
                </div>
                <div className="overflow-x-auto max-h-[70dvh] overflow-y-auto scrollbar-styled">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-xs font-extrabold uppercase text-slate-400 tracking-wider sticky top-0 z-10">
                    <tr>
                      <th className="p-5">Product</th>
                      <th className="p-5">Platform</th>
                      <th className="p-5 text-right">Price</th>
                      <th className="p-5 text-right">Commission</th>
                      <th className="p-5 text-center">Slots</th>
                      <th className="p-5 text-center">Speed</th>
                      <th className="p-5 text-right">Status</th>
                      <th className="p-5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 text-sm font-medium">
                    {filteredProducts.length === 0 ? (
                      <tr><td colSpan={7} className="p-12 text-center text-slate-400 text-sm font-bold">No products match the current filter.</td></tr>
                    ) : filteredProducts.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-50/50 transition-colors">
                        <td className="p-5">
                          <div className="flex items-center gap-3">
                            <ProxiedImage src={p.image} alt={p.title ? String(p.title) : 'Product image'} className="w-8 h-8 rounded-lg object-contain bg-white border border-slate-100 p-1" />
                            <span className="truncate max-w-[200px] text-slate-900 font-bold">
                              {p.title}
                            </span>
                          </div>
                        </td>
                        <td className="p-5 text-slate-500 uppercase text-xs font-bold">
                          {p.platform || '-'}
                        </td>
                        <td className="p-5 text-right font-mono text-slate-900">{p.price}</td>
                        <td className="p-5 text-right font-mono text-emerald-600">
                          {p.commission}
                        </td>
                        <td className="p-5 text-center">
                          <div className="text-xs">
                            <span className="font-bold text-slate-900">{p.usedSlots || 0}</span>
                            <span className="text-slate-400">/{p.totalSlots || 0}</span>
                          </div>
                          {(p.totalSlots || 0) > 0 && (
                            <div className="w-full bg-slate-100 rounded-full h-1 mt-1">
                              <div className="bg-blue-500 h-1 rounded-full transition-all" style={{ width: `${Math.min(100, ((p.usedSlots || 0) / (p.totalSlots || 1)) * 100)}%` }} />
                            </div>
                          )}
                        </td>
                        <td className="p-5 text-center">
                          {(p.sellingSpeed || 0) > 0 ? (
                            <span className={`text-[10px] font-bold px-2 py-1 rounded ${(p.sellingSpeed || 0) >= 5 ? 'bg-emerald-50 text-emerald-600' : (p.sellingSpeed || 0) >= 2 ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-500'}`}>
                              {p.sellingSpeed}/day
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">—</span>
                          )}
                        </td>
                        <td className="p-5 text-right">
                          <span
                            className={`text-[10px] font-bold px-2 py-1 rounded ${p.active ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}
                          >
                            {p.active ? 'ACTIVE' : 'INACTIVE'}
                          </span>
                        </td>
                        <td className="p-5 text-right">
                          <button
                            type="button"
                            onClick={() => deleteProduct(p.id)}
                            disabled={deletingProductId === p.id}
                            className={`p-2 rounded-lg transition-colors border ${
                              deletingProductId === p.id
                                ? 'border-slate-200 text-slate-400 bg-slate-100 cursor-not-allowed'
                                : 'border-rose-100 text-rose-500 hover:bg-rose-50'
                            }`}
                            title="Delete product"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {productsPagination && productsPagination.totalPages > 1 && (
                  <Pagination
                    page={productsPage}
                    totalPages={productsPagination.totalPages}
                    total={productsPagination.total}
                    limit={productsPagination.limit}
                    onPageChange={(p) => { setProductsPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  />
                )}
              </div>
            )}

            {/* SETTINGS VIEW */}
            {view === 'settings' && (
              <div className="max-w-xl mx-auto bg-white rounded-[2rem] shadow-sm border border-slate-200 p-8 animate-enter">
                <h3 className="text-xl font-black text-slate-900 mb-6 flex items-center gap-2">
                  <Settings size={24} /> System Configuration
                </h3>
                <div className="space-y-6">
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1 mb-1.5 block">
                      Platform Name
                    </label>
                    <input
                      type="text"
                      readOnly
                      value="BUZZMA Ecosystem"
                      aria-label="Platform Name"
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 font-bold text-slate-700"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1 mb-1.5 block">
                      Admin Contact
                    </label>
                    <input
                      type="text"
                      value={configEmail}
                      onChange={(e) => setConfigEmail(e.target.value)}
                      aria-label="Admin Contact"
                      className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 font-bold text-slate-900 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div className="pt-4 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={handleSaveConfig}
                      className="w-full py-4 bg-indigo-600 text-white rounded-xl font-bold shadow-lg hover:bg-indigo-700 transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                      <Save size={18} /> Save Configuration
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* AUDIT LOGS VIEW */}
            {view === 'audit-logs' && (
              <div className="animate-enter">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-black text-slate-900 flex items-center gap-2">
                    <ClipboardList size={24} /> Audit Logs
                  </h3>
                  <button
                    type="button"
                    onClick={async () => {
                      setAuditLoading(true);
                      try {
                        const params: any = { limit: PAGE_SIZE, page: auditPage };
                        if (auditActionFilter) params.action = auditActionFilter;
                        if (auditDateFrom) params.from = new Date(auditDateFrom).toISOString();
                        if (auditDateTo) params.to = new Date(auditDateTo + 'T23:59:59').toISOString();
                        const res = await api.admin.getAuditLogs(params);
                        setAuditLogs(asArray(res));
                        setAuditPagination(extractPaginationMeta(res));
                      } catch (e) {
                        console.error(e);
                        toast.error(formatErrorMessage(e, 'Failed to load audit logs'));
                      } finally {
                        setAuditLoading(false);
                      }
                    }}
                    className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-700 transition-all"
                  >
                    {auditLoading ? 'Loading...' : 'Refresh'}
                  </button>
                </div>
                <div className="mb-4 flex flex-wrap gap-3">
                  <input
                    type="text"
                    value={auditFilter}
                    onChange={(e) => setAuditFilter(e.target.value)}
                    placeholder="Search by action, entity, actor..."
                    className="flex-1 min-w-[200px] px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-slate-300"
                  />
                  <select
                    value={auditActionFilter}
                    onChange={(e) => { setAuditActionFilter(e.target.value); setAuditPage(1); }}
                    aria-label="Filter by audit action"
                    className="px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-slate-300"
                  >
                    <option value="">All Actions</option>
                    <option value="AUTH_LOGIN_SUCCESS">Login Success</option>
                    <option value="AUTH_LOGIN_FAILED">Login Failed</option>
                    <option value="USER_STATUS_UPDATED">User Status</option>
                    <option value="USER_DELETED">User Deleted</option>
                    <option value="ORDER_SETTLED">Order Settled</option>
                    <option value="ORDER_REACTIVATED">Order Reactivated</option>
                    <option value="DEAL_DELETED">Deal Deleted</option>
                    <option value="INVITE_USED">Invite Used</option>
                    <option value="PROFILE_UPDATED">Profile Updated</option>
                    <option value="SYSTEM_CONFIG_UPDATED">Config Updated</option>
                    <option value="BRAND_CONNECTION_REQUESTED">Connection Request</option>
                  </select>
                  <input
                    type="date"
                    value={auditDateFrom}
                    onChange={(e) => setAuditDateFrom(e.target.value)}
                    className="px-3 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-slate-300"
                    title="From date"
                  />
                  <input
                    type="date"
                    value={auditDateTo}
                    onChange={(e) => setAuditDateTo(e.target.value)}
                    className="px-3 py-3 bg-white border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-slate-300"
                    title="To date"
                  />
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                  <div className="overflow-x-auto max-h-[70dvh] overflow-y-auto scrollbar-styled">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                        <th className="p-4 text-left text-[10px] font-bold text-slate-400 uppercase">Time</th>
                        <th className="p-4 text-left text-[10px] font-bold text-slate-400 uppercase">Action</th>
                        <th className="p-4 text-left text-[10px] font-bold text-slate-400 uppercase">Entity</th>
                        <th className="p-4 text-left text-[10px] font-bold text-slate-400 uppercase">Actor</th>
                        <th className="p-4 text-left text-[10px] font-bold text-slate-400 uppercase">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs
                        .filter((log) => {
                          if (!auditFilter.trim()) return true;
                          const q = auditFilter.toLowerCase();
                          return (
                            (log.action || '').toLowerCase().includes(q) ||
                            (log.entityType || '').toLowerCase().includes(q) ||
                            (log.entityId || '').toLowerCase().includes(q) ||
                            (log.actorUserId || '').toLowerCase().includes(q)
                          );
                        })
                        .map((log: any, idx: number) => (
                          <tr key={log.id || idx} className="border-b border-slate-100 hover:bg-slate-50">
                            <td className="p-4 text-xs text-slate-500 font-mono whitespace-nowrap">
                              {log.createdAt ? new Date(log.createdAt).toLocaleString('en-GB') : '-'}
                            </td>
                            <td className="p-4">
                              <span className="px-2 py-0.5 bg-slate-100 rounded text-[10px] font-bold uppercase">
                                {(log.action || '').replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td className="p-4 text-xs font-mono text-slate-600">
                              {log.entityType && <span className="text-slate-400">{log.entityType}/</span>}
                              <span className="text-slate-700 break-all">{log.entityId?.slice(-8) || '-'}</span>
                            </td>
                            <td className="p-4 text-xs font-mono text-slate-500">
                              {log.actorUserId?.slice(-8) || 'System'}
                            </td>
                            <td className="p-4 text-[10px] text-slate-400 max-w-[200px] truncate">
                              {log.metadata ? JSON.stringify(log.metadata).slice(0, 80) : '-'}
                            </td>
                          </tr>
                        ))}
                      {auditLogs.length === 0 && (
                        <tr>
                          <td colSpan={5} className="p-8 text-center text-sm text-slate-400 font-bold">
                            {auditLoading ? 'Loading audit logs…' : 'No audit logs found for the selected filters.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                </div>
                {auditPagination && auditPagination.totalPages > 1 && (
                  <Pagination
                    page={auditPage}
                    totalPages={auditPagination.totalPages}
                    total={auditPagination.total}
                    limit={auditPagination.limit}
                    onPageChange={(p) => { setAuditPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                    className="rounded-b-2xl"
                  />
                )}
              </div>
            )}
          </div>
        </div>

      {/* Proof Viewer Modal */}
      {proofModal && (
        <div className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => { setProofModal(null); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90dvh] overflow-y-auto scrollbar-styled" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <div>
                <h3 className="font-extrabold text-lg text-slate-900">Order Proofs</h3>
                <p className="text-xs text-slate-500 font-mono mt-1">{proofModal.externalOrderId || proofModal.id}</p>
              </div>
              <button type="button" aria-label="Close proof modal" onClick={() => { setProofModal(null); }} className="p-2 rounded-lg hover:bg-slate-100">
                <span className="text-slate-400 text-xl font-bold">&times;</span>
              </button>
            </div>
            <div className="p-6 space-y-6">
              {/* Order Summary */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-slate-400 font-bold text-xs uppercase">Buyer</span><p className="font-bold text-slate-900">{proofModal.buyerName}</p></div>
                <div><span className="text-slate-400 font-bold text-xs uppercase">Amount</span><p className="font-bold text-slate-900">{formatCurrency(proofModal.total)}</p></div>
                {proofModal.reviewerName && <div><span className="text-indigo-400 font-bold text-xs uppercase">Reviewer Name</span><p className="font-bold text-indigo-700">{proofModal.reviewerName}</p></div>}
                <div><span className="text-slate-400 font-bold text-xs uppercase">Status</span><p><StatusBadge status={proofModal.affiliateStatus === 'Unchecked' ? proofModal.paymentStatus : proofModal.affiliateStatus} /></p></div>
                <div><span className="text-slate-400 font-bold text-xs uppercase">Payment</span><p className="font-bold text-slate-900">{proofModal.paymentStatus}</p></div>
                {proofModal.soldBy && <div><span className="text-slate-400 font-bold text-xs uppercase">Sold By</span><p className="font-bold text-slate-900">{proofModal.soldBy}</p></div>}
                {proofModal.orderDate && <div><span className="text-slate-400 font-bold text-xs uppercase">Order Date</span><p className="font-bold text-slate-900">{new Date(proofModal.orderDate).toLocaleDateString('en-GB')}</p></div>}
                {proofModal.extractedProductName && <div className="col-span-2"><span className="text-slate-400 font-bold text-xs uppercase">Extracted Product</span><p className="font-bold text-slate-900">{proofModal.extractedProductName}</p></div>}
                <div><span className="text-slate-400 font-bold text-xs uppercase">Deal Type</span><p className="font-bold text-slate-900">{proofModal.items?.[0]?.dealType || 'Discount'}</p></div>
                {proofModal.managerName && <div><span className="text-slate-400 font-bold text-xs uppercase">Mediator</span><p className="font-bold text-slate-900">{proofModal.managerName}</p></div>}
                {proofModal.settlementRef && <div><span className="text-slate-400 font-bold text-xs uppercase">UTR / Reference</span><p className="font-bold text-slate-900 font-mono text-xs">{proofModal.settlementRef}</p></div>}
                {proofModal.settlementMode && <div><span className="text-slate-400 font-bold text-xs uppercase">Payment Mode</span><p className="font-bold text-slate-900 uppercase">{proofModal.settlementMode}</p></div>}
              </div>

              {/* 1. Purchase Proof */}
              <div>
                <h4 className="flex items-center gap-2 text-xs font-extrabold text-blue-500 uppercase tracking-wider mb-2"><ShoppingCart size={14} /> Purchase Proof</h4>
                {proofModal.screenshots?.order ? (
                  <>
                    <ProofImage orderId={proofModal.id} proofType="order" existingSrc={proofModal.screenshots.order !== 'exists' ? proofModal.screenshots.order : undefined} alt="Purchase Proof" className="w-full max-h-[300px] object-contain rounded-xl border border-blue-200 bg-blue-50" />
                    {/* AI Verification — stored from buyer's proof submission */}
                    {proofModal.orderAiVerification && (
                    <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-200 mt-3">
                      <div className="flex justify-between items-center mb-2">
                        <h5 className="font-bold text-indigo-600 flex items-center gap-2 text-[10px] uppercase tracking-widest">
                          <Sparkles size={12} className="text-indigo-500" /> AI Verification
                        </h5>
                      </div>
                        <div className="space-y-2">
                          {(() => {
                            const aiData = proofModal.orderAiVerification;
                            const n = Number(aiData?.confidenceScore);
                            const score = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
                            return (
                              <>
                                <div className="flex gap-2">
                                  <div className={`flex-1 p-2 rounded-lg border text-center ${aiData?.orderIdMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                                    <p className="text-[9px] font-bold text-slate-400 uppercase">Order ID</p>
                                    <p className={`text-xs font-bold ${aiData?.orderIdMatch ? 'text-green-600' : 'text-red-600'}`}>
                                      {aiData?.orderIdMatch ? '✓ Match' : '✗ Mismatch'}
                                    </p>
                                    {aiData?.detectedOrderId && <p className="text-[9px] text-slate-500 font-mono mt-0.5">Detected: {aiData.detectedOrderId}</p>}
                                  </div>
                                  <div className={`flex-1 p-2 rounded-lg border text-center ${aiData?.amountMatch ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                                    <p className="text-[9px] font-bold text-slate-400 uppercase">Amount</p>
                                    <p className={`text-xs font-bold ${aiData?.amountMatch ? 'text-green-600' : 'text-red-600'}`}>
                                      {aiData?.amountMatch ? '✓ Match' : '✗ Mismatch'}
                                    </p>
                                    {aiData?.detectedAmount != null && <p className="text-[9px] text-slate-500 font-mono mt-0.5">Detected: {formatCurrency(aiData.detectedAmount)}</p>}
                                  </div>
                                </div>
                                {aiData?.discrepancyNote && (
                                  <p className="text-[10px] text-slate-500 bg-white rounded-lg p-2 border border-slate-100">{aiData.discrepancyNote}</p>
                                )}
                                <div className="flex justify-between items-center pt-1">
                                  <span className="text-[9px] text-indigo-500 font-bold uppercase">Confidence</span>
                                  <div className="flex items-center gap-2">
                                    <div className="w-20 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                      <div className={`h-full rounded-full ${score > 80 ? 'bg-green-500' : score > 50 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${score}%` }} />
                                    </div>
                                    <span className="text-xs font-bold text-slate-700">{score}%</span>
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
                  <div className="py-4 text-center text-xs text-slate-400 font-bold bg-slate-50 rounded-xl border border-dashed border-slate-200"><AlertCircle size={16} className="inline mr-1" />Not uploaded</div>
                )}
              </div>

              {/* 2. Rating Proof (Conditional) */}
              {proofModal.items?.[0]?.dealType === 'Rating' && (
                <div>
                  <h4 className="flex items-center gap-2 text-xs font-extrabold text-orange-400 uppercase tracking-wider mb-2"><Star size={14} /> Rating Proof</h4>
                  {proofModal.screenshots?.rating ? (
                    <ProofImage orderId={proofModal.id} proofType="rating" existingSrc={proofModal.screenshots.rating !== 'exists' ? proofModal.screenshots.rating : undefined} alt="Rating Proof" className="w-full max-h-[300px] object-contain rounded-xl border border-orange-200 bg-orange-50" />
                  ) : (
                    <div className="py-4 text-center text-xs text-orange-400 font-bold bg-orange-50 rounded-xl border border-dashed border-orange-200">Waiting for rating screenshot...</div>
                  )}
                  {/* AI Rating Verification */}
                  {proofModal.ratingAiVerification && (
                    <RatingVerificationBadge
                      data={proofModal.ratingAiVerification}
                      className="mt-2 bg-orange-50 rounded-xl border border-orange-100 p-3 space-y-1.5"
                    />
                  )}
                </div>
              )}

              {/* 3. Review Link (Conditional) */}
              {proofModal.items?.[0]?.dealType === 'Review' && (
                <div>
                  <h4 className="flex items-center gap-2 text-xs font-extrabold text-purple-400 uppercase tracking-wider mb-2"><MessageCircle size={14} /> Live Review</h4>
                  {proofModal.reviewLink ? (
                    <a
                      href={proofModal.reviewLink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between p-4 bg-purple-50 text-purple-700 rounded-xl font-bold text-xs border border-purple-100 hover:bg-purple-100 transition-colors group"
                    >
                      <span className="truncate flex-1 mr-2">{proofModal.reviewLink}</span>
                      <ExternalLink size={16} className="group-hover:scale-110 transition-transform" />
                    </a>
                  ) : proofModal.screenshots?.review ? (
                    <ProofImage orderId={proofModal.id} proofType="review" existingSrc={proofModal.screenshots.review !== 'exists' ? proofModal.screenshots.review : undefined} alt="Review Proof" className="w-full max-h-[300px] object-contain rounded-xl border border-purple-200 bg-purple-50" />
                  ) : (
                    <div className="py-4 text-center text-xs text-purple-400 font-bold bg-purple-50 rounded-xl border border-dashed border-purple-200">Review not submitted</div>
                  )}
                </div>
              )}

              {/* 4. Return Window Proof */}
              {(proofModal.screenshots as any)?.returnWindow && (
                <div>
                  <h4 className="flex items-center gap-2 text-xs font-extrabold text-teal-500 uppercase tracking-wider mb-2"><Package size={14} /> Return Window Proof</h4>
                  <ProofImage orderId={proofModal.id} proofType="returnWindow" existingSrc={(proofModal.screenshots as any).returnWindow !== 'exists' ? (proofModal.screenshots as any).returnWindow : undefined} alt="Return Window Proof" className="w-full max-h-[300px] object-contain rounded-xl border border-teal-200 bg-teal-50" />
                  {/* AI Return Window Verification */}
                  {proofModal.returnWindowAiVerification && (
                    <ReturnWindowVerificationBadge
                      data={proofModal.returnWindowAiVerification}
                      className="mt-2 bg-teal-50 rounded-xl border border-teal-100 p-3 space-y-1.5"
                    />
                  )}
                </div>
              )}

              {/* 5. Payment Screenshot */}
              <div>
                <h4 className="flex items-center gap-2 text-xs font-extrabold text-green-500 uppercase tracking-wider mb-2"><DollarSign size={14} /> Payment Screenshot</h4>
                {proofModal.screenshots?.payment ? (
                  <ProofImage orderId={proofModal.id} proofType="payment" existingSrc={proofModal.screenshots.payment !== 'exists' ? proofModal.screenshots.payment : undefined} alt="Payment Proof" className="w-full max-h-[300px] object-contain rounded-xl border border-green-200 bg-green-50" />
                ) : (
                  <div className="py-4 text-center text-xs text-slate-400 font-bold bg-slate-50 rounded-xl border border-dashed border-slate-200">Not uploaded</div>
                )}
              </div>

            </div>
          </div>
        </div>
      )}
    </DesktopShell>
    <TicketDetailModal
      open={!!selectedTicket}
      onClose={() => setSelectedTicket(null)}
      ticket={selectedTicket}
      onRefresh={fetchAllData}
    />
    </>
  );
};
