import type { ReactNode } from 'react';

export type Role = 'user' | 'agency' | 'mediator' | 'brand' | 'admin';
export type KycStatus = 'pending' | 'verified' | 'rejected' | 'none';
export type OrderStatus = 'Ordered' | 'Shipped' | 'Delivered' | 'Cancelled' | 'Returned';
export type PaymentStatus = 'Pending' | 'Paid' | 'Refunded' | 'Failed';
export type AffiliateStatus =
  | 'Unchecked'
  | 'Pending_Cooling'
  | 'Approved_Settled'
  | 'Rejected'
  | 'Fraud_Alert'
  | 'Cap_Exceeded'
  | 'Frozen_Disputed';
export type WithdrawalStatus = 'Pending' | 'Approved' | 'Rejected' | 'Processed';
export type TicketStatus = 'Open' | 'Resolved' | 'Rejected';

export interface User {
  id: string;
  name: string;
  mobile: string;
  email?: string;
  token?: string;
  role: Role;
  status: 'active' | 'suspended' | 'pending';

  // Ops & Hierarchy
  mediatorCode?: string;
  parentCode?: string;
  generatedCodes?: string[];

  // Brand Specific
  brandCode?: string;
  connectedAgencies?: string[];
  pendingConnections?: Array<{
    agencyId: string;
    agencyName: string;
    agencyCode: string;
    timestamp: string;
  }>;

  // KYC & Verification
  kycStatus?: KycStatus;
  kycDocuments?: KycDocument[];

  // Consumer
  isVerifiedByMediator?: boolean;

  // Financials
  upiId?: string;
  qrCode?: string;
  bankDetails?: {
    accountNumber: string;
    ifsc: string;
    bankName: string;
    holderName: string;
  };
  walletBalance: number;
  walletPending: number;

  avatar?: string;
  createdAt?: string;
}

export interface AppNotification {
  id: string;
  title: string;
  message: ReactNode;
  type: 'success' | 'info' | 'alert';
  duration?: number;
  action?: { label: string; onClick: () => void };
  createdAt?: string;
  read?: boolean;
  source?: 'inbox' | 'local';
}

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  originalPrice: number;
  commission: number;
  image: string;
  productUrl: string;
  rating: number;
  category: string;
  platform: string;
  dealType: 'Discount' | 'Review' | 'Rating';
  brandName: string;
  mediatorCode: string;
  mediatorName?: string;
  campaignId: string;
  active: boolean;
  inventoryCount?: number;
}

export interface Order {
  id: string;
  userId: string;
  items: Array<{
    productId: string;
    title: string;
    image: string;
    priceAtPurchase: number;
    commission: number;
    campaignId: string;
    dealType: string;
    quantity: number;
    platform?: string;
    brandName?: string;
  }>;
  total: number;
  status: OrderStatus;
  workflowStatus?: string;
  paymentStatus: PaymentStatus;
  affiliateStatus: AffiliateStatus;
  externalOrderId?: string;
  orderDate?: string;
  soldBy?: string;
  extractedProductName?: string;
  frozen?: boolean;
  frozenAt?: string;
  frozenReason?: string;
  settlementRef?: string;
  screenshots: { order?: string; payment?: string; review?: string; rating?: string; returnWindow?: string };
  reviewLink?: string;
  managerName: string;
  agencyName?: string;
  buyerName: string;
  buyerMobile: string;
  /** Marketplace reviewer / profile name used by the buyer on the e-commerce platform */
  reviewerName?: string;
  brandName?: string;
  createdAt: string;
  expectedSettlementDate?: string;

  // Step-level verification / requirements (optional for backward compatibility)
  verification?: {
    orderVerified?: boolean;
    orderVerifiedAt?: string;
    reviewVerified?: boolean;
    reviewVerifiedAt?: string;
    ratingVerified?: boolean;
    ratingVerifiedAt?: string;
    returnWindowVerified?: boolean;
    returnWindowVerifiedAt?: string;
  };
  requirements?: {
    required?: Array<'review' | 'rating' | 'returnWindow'>;
    missingProofs?: Array<'review' | 'rating' | 'returnWindow'>;
    missingVerifications?: Array<'review' | 'rating' | 'returnWindow'>;
  };
  rejection?: {
    type?: 'order' | 'review' | 'rating' | 'returnWindow';
    reason?: string;
    rejectedAt?: string;
    rejectedBy?: string;
  };
  missingProofRequests?: Array<{
    type?: 'review' | 'rating' | 'returnWindow';
    note?: string;
    requestedAt?: string;
    requestedBy?: string;
  }>;

  // AI verification for purchase proof screenshot
  orderAiVerification?: {
    orderIdMatch?: boolean;
    amountMatch?: boolean;
    detectedOrderId?: string;
    detectedAmount?: number;
    confidenceScore?: number;
    discrepancyNote?: string;
  };
  // AI verification for rating screenshot
  ratingAiVerification?: {
    accountNameMatch?: boolean;
    productNameMatch?: boolean;
    detectedAccountName?: string;
    detectedProductName?: string;
    confidenceScore?: number;
  };
  // AI verification for return window screenshot
  returnWindowAiVerification?: {
    orderIdMatch?: boolean;
    productNameMatch?: boolean;
    amountMatch?: boolean;
    soldByMatch?: boolean;
    returnWindowClosed?: boolean;
    confidenceScore?: number;
    detectedReturnWindow?: string;
    discrepancyNote?: string;
  };
  // Return window cooling period
  returnWindowDays?: number;

  // Top-level convenience fields (derived from items / assignment)
  dealType?: string;
  commission?: number;
  mediatorCode?: string;
  managerCode?: string;

  // Audit trail - order event history
  events?: Array<{
    type: string;
    at: string;
    actorUserId?: string;
    metadata?: Record<string, any>;
  }>;
}

export interface Campaign {
  id: string;
  title: string;
  brand: string;
  brandId: string;
  platform: string;
  price: number;
  originalPrice: number;
  payout: number;
  assignmentCommission?: number;
  assignmentPayout?: number;
  assignmentDetails?: Record<string, { limit: number; payout: number; commission: number }>;
  image: string;
  productUrl: string;
  totalSlots: number;
  usedSlots: number;
  status: 'Active' | 'Paused' | 'Completed' | 'Draft';
  assignments: Record<string, number>;
  allowedAgencies: string[];
  createdAt: number;
  returnWindowDays?: number;
  dealType?: 'Discount' | 'Review' | 'Rating';
}

export interface WithdrawalRequest {
  id: string;
  userId: string;
  amount: number;
  upiId: string;
  status: WithdrawalStatus;
  requestedAt: string;
}

export interface Invite {
  code: string;
  role: 'agency' | 'brand' | 'mediator' | 'shopper';
  label: string;
  status: 'active' | 'used' | 'revoked' | 'expired';
  createdAt: string;
  parentCode?: string;

  maxUses?: number;
  useCount?: number;
  expiresAt?: string;
}

export interface Ticket {
  id: string;
  userId: string;
  userName: string;
  role: Role;
  orderId?: string;
  issueType: string;
  description: string;
  status: TicketStatus;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  image?: string;
  timestamp: number;
  isError?: boolean;
  relatedProducts?: Product[];
  relatedOrders?: Order[];
}

// ─── AI Response Types ───────────────────────────────────
export type AiIntent =
  | 'greeting'
  | 'search_deals'
  | 'check_order_status'
  | 'check_ticket_status'
  | 'navigation'
  | 'unknown';

export type AiNavigateTo = 'home' | 'explore' | 'orders' | 'profile';

export interface ChatResponse {
  text: string;
  intent: AiIntent;
  navigateTo?: AiNavigateTo;
  uiType?: 'product_card' | 'order_card';
  data?: Product[] | Order[];
}

export interface AiProofVerificationResult {
  orderIdMatch: boolean;
  amountMatch: boolean;
  confidenceScore: number;
  detectedOrderId?: string;
  detectedAmount?: number;
  discrepancyNote?: string;
}

export interface AiRatingVerificationResult {
  accountNameMatch: boolean;
  productNameMatch: boolean;
  detectedAccountName?: string;
  detectedProductName?: string;
  confidenceScore: number;
  discrepancyNote?: string;
}

export interface AiReturnWindowVerificationResult {
  orderIdMatch: boolean;
  productNameMatch: boolean;
  amountMatch: boolean;
  soldByMatch: boolean;
  returnWindowClosed: boolean;
  confidenceScore: number;
  detectedReturnWindow?: string;
  discrepancyNote?: string;
}

export interface ExtractedOrderDetails {
  orderId?: string | null;
  amount?: number | null;
  orderDate?: string | null;
  soldBy?: string | null;
  productName?: string | null;
  confidenceScore: number;
  notes?: string;
}

// ─── Financial / Backtracking Types ──────────────────────
export type TransactionType =
  | 'brand_deposit'
  | 'agency_payout'
  | 'agency_receipt'
  | 'commission_settle'
  | 'payout_complete'
  | 'order_settlement_debit'
  | 'cashback_credit'
  | 'cashback_reversal'
  | 'platform_fee'
  | 'refund_credit'
  | 'refund_debit'
  | 'manual_credit'
  | 'manual_debit'
  | 'escrow_lock'
  | 'escrow_release';

export interface Transaction {
  id: string;
  idempotencyKey: string;
  type: TransactionType;
  status: 'completed' | 'pending' | 'failed' | 'reversed';
  amountPaise: number;
  currency: string;
  walletId: string;
  fromUserId?: string;
  toUserId?: string;
  orderId?: string;
  campaignId?: string;
  payoutId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface Wallet {
  id: string;
  ownerUserId: string;
  currency: string;
  availablePaise: number;
  pendingPaise: number;
  lockedPaise: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PayoutRecord {
  id: string;
  userId: string;
  amountPaise: number;
  status: 'requested' | 'processing' | 'paid' | 'failed' | 'canceled';
  providerRef?: string;
  beneficiaryName?: string;
  upiId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface LedgerEntry {
  id: string;
  type: TransactionType;
  amountPaise: number;
  fromUser?: { id: string; name: string; role: string };
  toUser?: { id: string; name: string; role: string };
  orderId?: string;
  campaignId?: string;
  notes?: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actor: string;
  actorRole?: string;
  action: string;
  entity: string;
  entityId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ─── KYC Types ───────────────────────────────────────────
export interface KycDocument {
  type: 'aadhaar' | 'pan' | 'gst' | 'business_license' | 'other';
  documentId: string;
  verified: boolean;
  verifiedAt?: string;
  uploadedAt: string;
  fileUrl?: string;
}

// ─── System Config Types ─────────────────────────────────
export interface SystemConfig {
  adminContactEmail?: string;
  platformName?: string;
  maintenanceMode?: boolean;
  features?: Record<string, boolean>;
}
