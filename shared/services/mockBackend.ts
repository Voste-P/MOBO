import { User, Product, Order, Campaign, Invite, Ticket } from '../types';
import {
  SEED_USERS,
  SEED_PRODUCTS,
  SEED_CAMPAIGNS,
  SEED_ORDERS,
} from './mockData';

const MOCK_DELAY = 400;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STORAGE_KEY_PREFIX = 'mobo_v7_';

const canUseStorage = typeof window !== 'undefined' && !!window.localStorage;

const getItem = <T>(key: string, seed: T): T => {
  if (!canUseStorage) return seed;
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${key}`);
    if (!stored) {
      setItem(key, seed);
      return seed;
    }
    return JSON.parse(stored);
  } catch (e) {
    console.error(`Error reading ${key} from storage`, e);
    return seed;
  }
};

const setItem = (key: string, data: any) => {
  if (!canUseStorage) return;
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${key}`, JSON.stringify(data));
  } catch {}
};

// --- Recommendation 5: Fraud Registry (In-memory mock for session/local) ---
const getReceiptRegistry = (): string[] => getItem('receipt_registry', []);
const addToReceiptRegistry = (hash: string) => {
  const registry = getReceiptRegistry();
  registry.push(hash);
  setItem('receipt_registry', registry);
};

// Simple pseudo-hash for image content (Recommendation 5)
const generateImageHash = (base64: string): string => {
  if (!base64) return '';
  // Taking first 100 and last 100 chars + total length to simulate a unique-ish fingerprint
  const len = base64.length;
  const start = base64.slice(100, 200);
  const end = base64.slice(-200, -100);
  return `${len}-${start}-${end}`;
};

// --- Data Accessors ---
const getUsers = (): User[] => getItem('users', SEED_USERS);
const saveUsers = (users: User[]) => setItem('users', users);

const getProducts = (): Product[] => getItem('products', SEED_PRODUCTS);
const saveProducts = (products: Product[]) => setItem('products', products);

// --- Recommendation 3: Auto-Settlement Logic ---
const getOrders = (): Order[] => {
  const orders = getItem('orders', SEED_ORDERS);
  let changed = false;
  const now = new Date();

  const users = getUsers();
  const tickets = getTickets();

  const updatedOrders = orders.map((order) => {
    if (order.affiliateStatus === 'Pending_Cooling' && order.expectedSettlementDate) {
      const settleDate = new Date(order.expectedSettlementDate);
      const hasOpenDispute = tickets.find((t) => t.orderId === order.id && t.status === 'Open');

      if (settleDate <= now && !hasOpenDispute) {
        // AUTO-SETTLE (Recommendation 3)
        order.paymentStatus = 'Paid';
        order.affiliateStatus = 'Approved_Settled';

        // Update Mediator Wallet
        const mediator = users.find((u) => u.mediatorCode === order.managerName);
        const comm = order.items[0].commission || 0;
        if (mediator) {
          mediator.walletBalance = (mediator.walletBalance || 0) + comm;
          mediator.walletPending = Math.max(0, (mediator.walletPending || 0) - comm);
        }

        // Update Buyer Wallet
        const buyer = users.find((u) => u.id === order.userId);
        if (buyer) {
          buyer.walletBalance = (buyer.walletBalance || 0) + order.total;
          buyer.walletPending = Math.max(0, (buyer.walletPending || 0) - order.total);
        }
        changed = true;
      }
    }
    return order;
  });

  if (changed) {
    setItem('orders', updatedOrders);
    saveUsers(users);
  }
  return updatedOrders;
};
const saveOrders = (orders: Order[]) => setItem('orders', orders);

const getCampaigns = (): Campaign[] => getItem('campaigns', SEED_CAMPAIGNS);
const saveCampaigns = (campaigns: Campaign[]) => setItem('campaigns', campaigns);

const getInvites = (): Invite[] => getItem('invites', []);
const saveInvites = (invites: Invite[]) => setItem('invites', invites);

const getTickets = (): Ticket[] => getItem('tickets', []);
const saveTickets = (tickets: Ticket[]) => setItem('tickets', tickets);

const getLedger = (): any[] => getItem('agency_ledger', []);
const saveLedger = (ledger: any[]) => setItem('agency_ledger', ledger);

const getBrandLedger = (): any[] => getItem('brand_ledger', []);
const saveBrandLedger = (ledger: any[]) => setItem('brand_ledger', ledger);

// --- API Implementation ---

export const authAPI = {
  login: async (mobile: string, _pass: string): Promise<User> => {
    await delay(MOCK_DELAY);
    const users = getUsers();
    const user = users.find((u) => u.mobile === mobile);
    if (!user) throw new Error('User not found.');
    if (user.status === 'suspended') throw new Error('Account suspended.');
    return user;
  },
  register: async (
    name: string,
    mobile: string,
    _pass: string,
    mediatorCode: string
  ): Promise<User> => {
    await delay(MOCK_DELAY);
    const users = getUsers();
    if (users.find((u) => u.mobile === mobile)) throw new Error('User already exists');

    const mediator = users.find((u) => u.mediatorCode === mediatorCode && u.role === 'mediator');
    if (!mediator && mediatorCode !== 'ADMIN') throw new Error('Invalid Mediator Code');

    const newUser: User = {
      id: `u-${Date.now()}`,
      name,
      mobile,
      role: 'user',
      status: 'active',
      mediatorCode: mediator ? mediator.mediatorCode : 'ADMIN',
      isVerifiedByMediator: false,
      walletBalance: 0,
      walletPending: 0,
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    saveUsers(users);
    return newUser;
  },
  registerOps: async (
    name: string,
    mobile: string,
    _pass: string,
    role: 'agency' | 'mediator',
    code: string
  ): Promise<User> => {
    await delay(MOCK_DELAY);
    const users = getUsers();
    const invites = getInvites();
    const invite = invites.find((i) => i.code === code && i.status === 'active');
    let parentCode = 'ADMIN';

    if (invite) {
      if (invite.role !== role) throw new Error(`Role mismatch.`);
      parentCode = invite.parentCode || 'ADMIN';
    } else {
      if (role === 'mediator') {
        const agency = users.find((u) => u.mediatorCode === code && u.role === 'agency');
        if (agency) parentCode = agency.mediatorCode!;
        else throw new Error('Invalid Agency Code');
      }
    }

    const newUser: User = {
      id: `u-${Date.now()}`,
      name,
      mobile,
      role,
      status: 'active',
      mediatorCode:
        role === 'agency'
          ? `AGY_${name.substring(0, 3).toUpperCase()}_${Date.now().toString().slice(-4)}`
          : `MED_${name.substring(0, 3).toUpperCase()}_${Date.now().toString().slice(-4)}`,
      parentCode,
      walletBalance: 0,
      walletPending: 0,
      kycStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    saveUsers(users);
    if (invite) {
      invite.status = 'used';
      saveInvites(invites);
    }
    return newUser;
  },
  registerBrand: async (
    name: string,
    mobile: string,
    _pass: string,
    brandCode: string
  ): Promise<User> => {
    await delay(MOCK_DELAY);
    const users = getUsers();
    const newUser: User = {
      id: `u-brand-${Date.now()}`,
      name,
      mobile,
      role: 'brand',
      brandCode,
      status: 'active',
      walletBalance: 0,
      walletPending: 0,
    };
    users.push(newUser);
    saveUsers(users);
    return newUser;
  },
  updateProfile: async (userId: string, updates: Partial<User>): Promise<User> => {
    await delay(MOCK_DELAY);
    const users = getUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) throw new Error('User not found');
    users[idx] = { ...users[idx], ...updates };
    saveUsers(users);
    return users[idx];
  },
};

export const productsAPI = {
  getAll: async (mediatorCode?: string): Promise<Product[]> => {
    await delay(MOCK_DELAY);
    let products = getProducts();
    if (mediatorCode) products = products.filter((p) => p.mediatorCode === mediatorCode);
    return products.filter((p) => p.active);
  },
};

export const ordersAPI = {
  getUserOrders: async (userId: string): Promise<Order[]> => {
    await delay(MOCK_DELAY);
    return getOrders()
      .filter((o) => o.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },
  create: async (userId: string, items: any[], initialData?: any): Promise<Order> => {
    await delay(MOCK_DELAY);
    const orders = getOrders();
    const users = getUsers();
    const campaigns = getCampaigns();
    const user = users.find((u) => u.id === userId);

    // Anti-Fraud: Duplicate External Order ID Check
    if (initialData?.externalOrderId) {
      const dup = orders.find((o) => o.externalOrderId === initialData.externalOrderId);
      if (dup) throw new Error('This Order ID has already been submitted in our system.');
    }

    // Recommendation 5: Fraud Detection via Image Hashing
    if (initialData?.screenshots?.order) {
      const hash = generateImageHash(initialData.screenshots.order);
      const registry = getReceiptRegistry();
      if (registry.includes(hash)) {
        throw new Error(
          'This screenshot has already been used to claim an order by another account. [FRAUD ALERT]'
        );
      }
      addToReceiptRegistry(hash);
    }

    const item = items[0];
    // Recommendation 4: Commission Snapshot (immutable capture at creation)
    const products = getProducts();
    const sourceProd = products.find((p) => p.id === item.productId);
    const capturedCommission = sourceProd?.commission || item.commission || 0;

    if (item.campaignId) {
      const camp = campaigns.find((c) => c.id === item.campaignId);
      if (camp) {
        if (camp.usedSlots >= camp.totalSlots) throw new Error('Sold Out Globally');
        const mediatorCode = user?.mediatorCode;
        if (mediatorCode) {
          const assigned = camp.assignments[mediatorCode] || 0;
          const mediatorSales = orders.filter(
            (o) =>
              o.managerName === mediatorCode &&
              o.items[0].campaignId === camp.id &&
              o.status !== 'Cancelled'
          ).length;
          if (mediatorSales >= assigned)
            throw new Error(`Sold out for your partner (${mediatorCode}).`);
        }
        camp.usedSlots += 1;
        saveCampaigns(campaigns);
      }
    }

    const newOrder: Order = {
      id: `ORD-${Date.now()}`,
      userId,
      items: items.map((i) => ({ ...i, commission: capturedCommission })), // Recommendation 4
      total: items.reduce((acc, item) => acc + item.priceAtPurchase * item.quantity, 0),
      status: 'Ordered',
      paymentStatus: 'Pending',
      affiliateStatus: 'Unchecked',
      managerName: user?.mediatorCode || 'ADMIN',
      agencyName: 'Partner Agency',
      buyerName: user?.name || 'Guest',
      buyerMobile: user?.mobile || '',
      brandName: items[0]?.brandName || 'Brand',
      createdAt: new Date().toISOString(),
      externalOrderId: initialData?.externalOrderId,
      screenshots: initialData?.screenshots || {},
      reviewLink: initialData?.reviewLink,
    };
    orders.unshift(newOrder);
    saveOrders(orders);
    return newOrder;
  },
  submitClaim: async (
    orderId: string,
    proof: { type: 'review' | 'rating' | 'order'; data: string }
  ): Promise<void> => {
    await delay(MOCK_DELAY);
    const orders = getOrders();
    const order = orders.find((o) => o.id === orderId);
    if (order) {
      if (proof.type === 'review') order.reviewLink = proof.data;
      else if (proof.type === 'rating')
        order.screenshots = { ...order.screenshots, rating: proof.data };
      else if (proof.type === 'order') {
        // Recommendation 5 check for claim update too
        const hash = generateImageHash(proof.data);
        const registry = getReceiptRegistry();
        if (registry.includes(hash)) throw new Error('Duplicate screenshot detected.');
        addToReceiptRegistry(hash);
        order.screenshots = { ...order.screenshots, order: proof.data };
      }
      if (order.affiliateStatus === 'Rejected')
        order.affiliateStatus = 'Unchecked';
      saveOrders(orders);
    }
  },
  extractDetails: async (_file: File) => {
    return {
      orderId: 'MOCK-123-4567890-1234567',
      amount: 1000,
      orderDate: '15 January 2026',
      soldBy: 'Mock Seller Store',
      productName: 'Mock Product — Premium Quality Item (Size M, Black)',
    };
  },
};

export const opsAPI = {
  getMediators: async (agencyCode: string) => {
    await delay(MOCK_DELAY);
    return getUsers().filter((u) => u.role === 'mediator' && u.parentCode === agencyCode);
  },
  getCampaigns: async (_agencyCode?: string) => {
    await delay(MOCK_DELAY);
    return getCampaigns();
  },
  getMediatorOrders: async (mediatorCode: string, role: string) => {
    await delay(MOCK_DELAY);
    const orders = getOrders(); // Recommendation 3 auto-settle runs here
    if (role === 'agency') {
      const users = getUsers();
      const agents = users.filter((u) => u.parentCode === mediatorCode).map((u) => u.mediatorCode);
      return orders.filter((o) => agents.includes(o.managerName));
    }
    return orders.filter((o) => o.managerName === mediatorCode);
  },
  getPendingUsers: async (code: string) => {
    await delay(MOCK_DELAY);
    return getUsers().filter(
      (u) => u.role === 'user' && u.mediatorCode === code && !u.isVerifiedByMediator
    );
  },
  getVerifiedUsers: async (code: string) => {
    await delay(MOCK_DELAY);
    return getUsers().filter(
      (u) => u.role === 'user' && u.mediatorCode === code && u.isVerifiedByMediator
    );
  },
  getAgencyLedger: async () => {
    await delay(MOCK_DELAY);
    return getLedger();
  },

  approveMediator: async (id: string) => {
    const users = getUsers();
    const u = users.find((u) => u.id === id);
    if (u) {
      u.kycStatus = 'verified';
      u.status = 'active';
      saveUsers(users);
    }
  },
  approveUser: async (id: string) => {
    const users = getUsers();
    const u = users.find((u) => u.id === id);
    if (u) {
      u.isVerifiedByMediator = true;
      saveUsers(users);
    }
  },
  rejectUser: async (id: string) => {
    const users = getUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx !== -1) {
      users.splice(idx, 1);
      saveUsers(users);
    }
  },

  settleOrderPayment: async (
    orderId: string,
    settlementRef?: string,
    _settlementMode?: 'wallet' | 'external'
  ): Promise<void> => {
    await delay(MOCK_DELAY);
    const orders = getOrders();
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error('Order not found');

    if (settlementRef) (order as any).settlementRef = settlementRef;

    // [Support] Dispute Resolution Check
    const tickets = getTickets();
    const hasOpenDispute = tickets.find((t) => t.orderId === orderId && t.status === 'Open');
    if (hasOpenDispute) {
      order.affiliateStatus = 'Frozen_Disputed';
      saveOrders(orders);
      throw new Error('This transaction is currently FROZEN due to an open support ticket.');
    }

    const users = getUsers();
    const campaigns = getCampaigns();
    const campaign = campaigns.find((c) => c.id === order.items[0].campaignId);
    const mediatorCode = order.managerName;

    let isOverLimit = false;
    if (campaign && mediatorCode) {
      const assignedLimit = campaign.assignments[mediatorCode] || 0;
      const settledCount = orders.filter(
        (o) =>
          o.managerName === mediatorCode &&
          o.items[0].campaignId === campaign.id &&
          (o.affiliateStatus === 'Approved_Settled' || o.paymentStatus === 'Paid') &&
          o.id !== order.id
      ).length;
      if (settledCount >= assignedLimit) isOverLimit = true;
    }

    order.paymentStatus = 'Paid';
    const commissionToPay = order.items[0].commission || 0; // Uses the snapshot

    if (isOverLimit) {
      order.affiliateStatus = 'Cap_Exceeded';
      const mediator = users.find((u) => u.mediatorCode === order.managerName);
      if (mediator)
        mediator.walletPending = Math.max(0, (mediator.walletPending || 0) - commissionToPay);
    } else {
      order.affiliateStatus = 'Approved_Settled';
      const mediator = users.find((u) => u.mediatorCode === order.managerName);
      if (mediator) {
        mediator.walletBalance = (mediator.walletBalance || 0) + commissionToPay;
        mediator.walletPending = Math.max(0, (mediator.walletPending || 0) - commissionToPay);
      }
    }

    const buyer = users.find((u) => u.id === order.userId);
    if (buyer) {
      buyer.walletBalance = (buyer.walletBalance || 0) + order.total;
      buyer.walletPending = Math.max(0, (buyer.walletPending || 0) - order.total);
    }

    saveOrders(orders);
    saveUsers(users);
  },

  verifyOrderClaim: async (orderId: string): Promise<void> => {
    await delay(MOCK_DELAY);
    const orders = getOrders();
    const order = orders.find((o) => o.id === orderId);
    if (order) {
      order.affiliateStatus = 'Pending_Cooling';
      const settleDate = new Date();
      settleDate.setDate(settleDate.getDate() + 14);
      order.expectedSettlementDate = settleDate.toISOString();
      saveOrders(orders);
    }
  },

  createCampaign: async (data: any) => {
    const c = getCampaigns();
    const n = {
      id: `cmp-${Date.now()}`,
      ...data,
      usedSlots: 0,
      assignments: {},
      createdAt: Date.now(),
    };
    c.push(n);
    saveCampaigns(c);
    return n;
  },
  updateCampaignStatus: async (campaignId: string, status: string) => {
    const campaigns = getCampaigns();
    const campaign = campaigns.find((c) => c.id === campaignId);
    if (!campaign) throw new Error('Campaign not found');

    const normalized = String(status || '').toLowerCase();
    const uiStatus =
      normalized === 'active'
        ? 'Active'
        : normalized === 'paused'
          ? 'Paused'
          : normalized === 'completed'
            ? 'Completed'
            : 'Draft';

    campaign.status = uiStatus as any;
    saveCampaigns(campaigns);

    const products = getProducts();
    products.forEach((p) => {
      if (p.campaignId === campaignId) p.active = normalized === 'active';
    });
    saveProducts(products);

    return campaign;
  },
  // Fix: Updated assignSlots signature to accept price and payout configuration for more granular slot control
  assignSlots: async (
    id: string,
    assign: any,
    dealType?: string,
    price?: number,
    payout?: number
  ) => {
    const c = getCampaigns();
    const t = c.find((x) => x.id === id);
    if (t) {
      t.assignments = { ...t.assignments, ...assign };
      if (dealType) t.dealType = dealType as any;
      if (price !== undefined && !isNaN(price)) t.price = price;
      if (payout !== undefined && !isNaN(payout)) t.payout = payout;
      saveCampaigns(c);
    }
  },
  publishDeal: async (id: string, comm: number, med: string) => {
    const c = getCampaigns();
    const p = getProducts();
    const t = c.find((x) => x.id === id);
    if (t) {
      p.push({
        id: `prod-${Date.now()}`,
        title: t.title,
        price: t.price + comm,
        originalPrice: t.originalPrice,
        commission: comm,
        image: t.image,
        productUrl: t.productUrl,
        rating: 5,
        category: 'General',
        platform: t.platform,
        dealType: t.dealType as any,
        brandName: t.brand,
        mediatorCode: med,
        campaignId: t.id,
        active: true,
        description: 'Exclusive',
      });
      saveProducts(p);
    }
  },
  uploadPaymentProof: async (
    orderId: string,
    proofUrl: string,
    externalOrderId?: string
  ): Promise<void> => {
    await delay(MOCK_DELAY);
    const orders = getOrders();
    const users = getUsers();
    const order = orders.find((o) => o.id === orderId);
    if (order) {
      order.paymentStatus = 'Paid';
      order.affiliateStatus = 'Pending_Cooling';
      const settleDate = new Date();
      settleDate.setDate(settleDate.getDate() + 14);
      order.expectedSettlementDate = settleDate.toISOString();
      if (proofUrl && proofUrl !== 'verified')
        order.screenshots = { ...order.screenshots, payment: proofUrl };
      if (externalOrderId) order.externalOrderId = externalOrderId;

      const mediator = users.find((u) => u.mediatorCode === order.managerName);
      if (mediator)
        mediator.walletPending = (mediator.walletPending || 0) + (order.items[0].commission || 0);
      const buyer = users.find((u) => u.id === order.userId);
      if (buyer) buyer.walletPending = (buyer.walletPending || 0) + order.total;

      saveOrders(orders);
      saveUsers(users);
    }
  },
  payoutMediator: async (mediatorId: string, amount: number): Promise<void> => {
    await delay(MOCK_DELAY);
    const users = getUsers();
    const user = users.find((u) => u.id === mediatorId);
    if (user) {
      if (user.walletBalance < amount) throw new Error('Insufficient Funds');
      user.walletBalance -= amount;
      saveUsers(users);
      const ledger = getLedger();
      ledger.unshift({
        id: `TXN-${Date.now()}`,
        mediatorName: user.name,
        mediatorCode: user.mediatorCode,
        amount,
        date: new Date().toISOString(),
        status: 'Success',
      });
      saveLedger(ledger);
    }
  },
  generateMediatorInvite: async (_id: string) => {
    return `INV-${Math.random().toString(36).substring(7).toUpperCase()}`;
  },
  requestBrandConnection: async (_agencyId: string, _brandCode: string) => {},
};

export const brandAPI = {
  getConnectedAgencies: async (_brandId: string) => {
    await delay(MOCK_DELAY);
    return getUsers().filter((u) => u.role === 'agency');
  },
  getBrandCampaigns: async (id: string) => {
    return getCampaigns().filter((c) => c.brandId === id);
  },
  getBrandOrders: async (_name: string) => {
    return getOrders();
  },
  getTransactions: async (_id: string) => {
    return getBrandLedger();
  },
  payoutAgency: async (_bid: string, _aid: string, amt: number, ref: string) => {
    const l = getBrandLedger();
    l.unshift({
      id: `TX-${Date.now()}`,
      amount: amt,
      date: new Date().toISOString(),
      status: 'Success',
      ref,
    });
    saveBrandLedger(l);
  },
  resolveConnectionRequest: async (_brandId: string, _agencyId: string, _action: string) => {},
  removeAgency: async (_brandId: string, _agencyCode: string) => {},
  createCampaign: async (d: any) => opsAPI.createCampaign(d),
  updateCampaign: async (campaignId: string, data: any) => {
    if (typeof data?.status !== 'undefined') {
      await opsAPI.updateCampaignStatus(campaignId, data.status);
    }
  },
  connectAgency: async (_brandId: string, _agencyCode: string) => {},
  getAnalytics: async (_brandId: string) => ({}),
  getAgencyFinancials: async (_brandId: string) => [],
  assignCampaignToAgency: async (_campaignId: string, _agencyCode: string) => {},
};

export const adminAPI = {
  getUsers: async (_r: string) => getUsers(),
  getFinancials: async () => getOrders(),
  getStats: async () => ({}),
  getGrowthAnalytics: async () => [],
  getInvites: async () => getInvites(),
  generateInvite: async (_role?: string, _label?: string) => ({ code: '123' }) as any,
  updateUserStatus: async (_userId: string, _status: string) => {},
};

export const supportAPI = {
  createTicket: async (t: any) => {
    const tickets = getTickets();
    tickets.push({
      id: `TK-${Date.now()}`,
      ...t,
      status: 'Open',
      createdAt: new Date().toISOString(),
    });
    saveTickets(tickets);
  },
  getTickets: async () => getTickets(),
  updateTicket: async (id: string, s: any) => {
    const tickets = getTickets();
    const t = tickets.find((x) => x.id === id);
    if (t) t.status = s;
    saveTickets(tickets);
  },
};
