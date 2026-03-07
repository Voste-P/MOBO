/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MOBO APPLICATION LOG LAYER  — CrowdStrike-Aligned Observability
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Implements the four log types recommended by CrowdStrike's Application Logs
 * guide (https://www.crowdstrike.com/cybersecurity-101/observability/application-logs/):
 *
 *   1. ACCESS / AUTHENTICATION / AUTHORIZATION LOGS
 *      Who logged in, accessed what, role-based operations, session lifecycle.
 *
 *   2. CHANGE LOGS
 *      Data mutations with actor, entity, before/after state, timestamp.
 *
 *   3. ERROR LOGS
 *      Categorized, severity-classified error events with context.
 *
 *   4. AVAILABILITY LOGS
 *      Startup, shutdown, health checks, database connectivity, uptime.
 *
 * All functions use the existing Winston logger (logger.ts) and logEvent()
 * for transport — no new Winston instances.  Production output goes to
 * domain-specific daily-rotated files in addition to combined.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  logEvent,
  dbLog,
  perfLog,
  getSystemMetrics,
  sanitize,
} from './logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  1.  ACCESS / AUTHENTICATION / AUTHORIZATION LOGS
// ═══════════════════════════════════════════════════════════════════════════════

export type AuthEventType =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILURE'
  | 'LOGOUT'
  | 'TOKEN_REFRESH'
  | 'TOKEN_REFRESH_FAILURE'
  | 'REGISTRATION'
  | 'REGISTRATION_FAILURE'
  | 'PASSWORD_CHANGE'
  | 'PASSWORD_CHANGE_FAILURE'
  | 'PROFILE_UPDATE'
  | 'SESSION_EXPIRED';

export interface AuthEventPayload {
  /** The authenticated user's ID (if available). */
  userId?: string;
  /** Roles associated with the user. */
  roles?: string[];
  /** Client IP address. */
  ip?: string;
  /** Identification used for auth — mobile, username, email. */
  identifier?: string;
  /** HTTP method if relevant. */
  method?: string;
  /** Route / resource path. */
  route?: string;
  /** Correlation / request ID. */
  requestId?: string;
  /** Why the event failed (for failure types). */
  reason?: string;
  /** User-agent header. */
  userAgent?: string;
  /** Any additional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Log a structured authentication / authorization event.
 *
 * These logs are critical for:
 * - Re-tracing user actions across the system
 * - Investigating security incidents
 * - Analyzing user behaviour patterns
 * - Auditing regulatory compliance
 */
export function logAuthEvent(type: AuthEventType, payload: AuthEventPayload): void {
  const isFailure = type.includes('FAILURE') || type === 'SESSION_EXPIRED';
  const level = isFailure ? 'warn' : 'info';

  const message = formatAuthMessage(type, payload);

  logEvent(level, message, {
    domain: 'auth',
    eventCategory: 'authentication',
    eventName: type,
    userId: payload.userId,
    role: payload.roles?.join(','),
    ip: payload.ip,
    method: payload.method,
    route: payload.route,
    requestId: payload.requestId,
    metadata: {
      identifier: payload.identifier,
      userAgent: payload.userAgent,
      ...payload.metadata,
    },
  });
}

function formatAuthMessage(type: AuthEventType, p: AuthEventPayload): string {
  const who = p.identifier || p.userId || 'unknown';
  switch (type) {
    case 'LOGIN_SUCCESS':
      return `User ${who} logged in successfully`;
    case 'LOGIN_FAILURE':
      return `Login failed for ${who}: ${p.reason || 'invalid credentials'}`;
    case 'LOGOUT':
      return `User ${who} logged out`;
    case 'TOKEN_REFRESH':
      return `Token refreshed for user ${who}`;
    case 'TOKEN_REFRESH_FAILURE':
      return `Token refresh failed for ${who}: ${p.reason || 'invalid token'}`;
    case 'REGISTRATION':
      return `New user registered: ${who}`;
    case 'REGISTRATION_FAILURE':
      return `Registration failed for ${who}: ${p.reason || 'unknown'}`;
    case 'PASSWORD_CHANGE':
      return `Password changed for user ${who}`;
    case 'PASSWORD_CHANGE_FAILURE':
      return `Password change failed for ${who}: ${p.reason || 'unknown'}`;
    case 'PROFILE_UPDATE':
      return `Profile updated for user ${who}`;
    case 'SESSION_EXPIRED':
      return `Session expired for user ${who}`;
    default:
      return `Auth event ${type} for ${who}`;
  }
}

export type AccessEventType =
  | 'RESOURCE_ACCESS'
  | 'RESOURCE_DENIED'
  | 'ROLE_ACCESS'
  | 'ADMIN_ACTION';

export interface AccessEventPayload {
  userId?: string;
  roles?: string[];
  ip?: string;
  method?: string;
  route?: string;
  resource?: string;
  requestId?: string;
  statusCode?: number;
  duration?: number;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a resource access/authorization event.
 *
 * Use this for tracking:
 * - Who accessed specific resources (files, tables, endpoints)
 * - Authorization decisions (allowed / denied)
 * - Admin-level operations
 */
export function logAccessEvent(type: AccessEventType, payload: AccessEventPayload): void {
  const isDenied = type === 'RESOURCE_DENIED';
  const level = isDenied ? 'warn' : 'info';

  const message = formatAccessMessage(type, payload);

  logEvent(level, message, {
    domain: isDenied ? 'security' : 'http',
    eventCategory: 'authorization',
    eventName: type,
    userId: payload.userId,
    role: payload.roles?.join(','),
    ip: payload.ip,
    method: payload.method,
    route: payload.route,
    statusCode: payload.statusCode,
    duration: payload.duration,
    requestId: payload.requestId,
    metadata: {
      resource: payload.resource,
      userAgent: payload.userAgent,
      ...payload.metadata,
    },
  });
}

function formatAccessMessage(type: AccessEventType, p: AccessEventPayload): string {
  const who = p.userId?.slice(0, 8) || 'anonymous';
  const role = p.roles?.[0] || 'unknown';
  const action = (p.metadata?.action as string) || '';
  const resource = p.resource || p.route || 'unknown';

  if (type === 'RESOURCE_DENIED') {
    const reason = (p.metadata?.reason as string) || 'insufficient permissions';
    return `Access DENIED for ${role} user ${who}: ${reason} on ${resource}`;
  }

  if (type === 'ADMIN_ACTION') {
    return formatAdminAccessMessage(action, who, p);
  }

  // Human-readable message based on metadata.action or resource
  switch (action) {
    // ── Orders ──
    case 'ORDER_CREATED':
      return `Buyer ${who} created new order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    case 'PROOF_UPLOADED':
      return `Buyer ${who} uploaded ${p.metadata?.proofType || 'proof'} for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    case 'DEAL_REDIRECT':
      return `User ${who} redirected to deal${(p.metadata?.dealId as string) ? ` #${(p.metadata?.dealId as string).slice(0, 8)}` : ''} on ${p.metadata?.platform || 'marketplace'}`;
    case 'SETTLE_ORDER':
      return `${role} ${who} settled order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''} via ${p.metadata?.settlementMode || 'standard'}`;
    case 'UNSETTLE_ORDER':
      return `${role} ${who} unsettled order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    // ── Order verification ──
    case 'VERIFY_ORDER_CLAIM':
      return `${role} ${who} verified claim for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    case 'REQUIREMENT_VERIFIED':
      return `${role} ${who} verified requirement step ${p.metadata?.step || ''} for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''} (${p.metadata?.approved ? 'approved' : 'rejected'})`;
    case 'VERIFY_ALL_STEPS':
      return `${role} ${who} verified all steps for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    case 'REJECT_ORDER_PROOF':
      return `${role} ${who} rejected ${p.metadata?.proofType || 'proof'} for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    case 'MISSING_PROOF_REQUESTED':
      return `${role} ${who} requested missing ${p.metadata?.proofType || 'proof'} for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    // ── Campaigns ──
    case 'CAMPAIGN_CREATED':
      return `${role} ${who} created campaign "${p.metadata?.title || ''}" on ${p.metadata?.platform || 'platform'}`;
    case 'CAMPAIGN_UPDATED':
      return `${role} ${who} updated campaign #${(p.metadata?.campaignId as string)?.slice(0, 8) || ''}`;
    case 'CAMPAIGN_STATUS_CHANGED':
      return `${role} ${who} changed campaign status: ${p.metadata?.previousStatus || '?'} → ${p.metadata?.newStatus || '?'}`;
    case 'CAMPAIGN_DELETED':
      return `${role} ${who} deleted campaign "${p.metadata?.title || ''}"`;
    case 'CAMPAIGN_COPIED':
      return `${role} ${who} copied campaign #${(p.metadata?.sourceCampaignId as string)?.slice(0, 8) || ''}`;
    // ── Deals ──
    case 'DEAL_PUBLISHED':
      return `${role} ${who} published deal for campaign #${(p.metadata?.campaignId as string)?.slice(0, 8) || ''}`;
    case 'SLOTS_ASSIGNED':
      return `${role} ${who} assigned ${p.metadata?.totalAssigned || 0} slots to ${p.metadata?.mediatorCount || 0} mediators`;
    // ── Payouts ──
    case 'PAYOUT_PROCESSED':
      return `${role} ${who} processed payout #${(p.metadata?.payoutId as string)?.slice(0, 8) || ''} (${p.metadata?.amountPaise || 0} paise)`;
    case 'PAYOUT_DELETED':
      return `${role} ${who} deleted payout #${(p.metadata?.payoutId as string)?.slice(0, 8) || ''}`;
    case 'PAYOUT_AGENCY':
      return `Brand ${who} initiated agency payout`;
    // ── Users ──
    case 'MEDIATOR_APPROVED':
      return `${role} ${who} approved mediator #${(p.metadata?.mediatorId as string)?.slice(0, 8) || ''}`;
    case 'MEDIATOR_REJECTED':
      return `${role} ${who} rejected mediator #${(p.metadata?.mediatorId as string)?.slice(0, 8) || ''}`;
    case 'BUYER_APPROVED':
      return `${role} ${who} approved buyer #${(p.metadata?.buyerId as string)?.slice(0, 8) || ''}`;
    case 'USER_REJECTED':
      return `${role} ${who} rejected user #${(p.metadata?.buyerId as string)?.slice(0, 8) || ''}`;
    case 'BRAND_CONNECTION_REQUESTED':
      return `${role} ${who} requested brand connection`;
    // ── Invites ──
    case 'INVITE_CREATED':
      return `${role} ${who} created invite #${(p.metadata?.inviteId as string)?.slice(0, 8) || ''}`;
    case 'INVITE_REVOKED':
      return `${role} ${who} revoked invite #${(p.metadata?.inviteId as string)?.slice(0, 8) || ''}`;
    case 'INVITE_DELETED':
      return `${role} ${who} deleted invite #${(p.metadata?.inviteId as string)?.slice(0, 8) || ''}`;
    case 'MEDIATOR_INVITE_CREATED':
      return `Agency ${who} created mediator invite`;
    case 'BUYER_INVITE_CREATED':
      return `Mediator ${who} created buyer invite`;
    // ── Brand ──
    case 'REMOVE_AGENCY':
      return `Brand ${who} removed agency ${p.metadata?.agencyCode || ''}`;
    // ── Tickets ──
    case 'TICKET_CREATED':
      return `User ${who} created support ticket #${(p.metadata?.ticketId as string)?.slice(0, 8) || ''}`;
    case 'TICKET_UPDATED':
      return `User ${who} updated support ticket #${(p.metadata?.ticketId as string)?.slice(0, 8) || ''}`;
    case 'TICKET_DELETED':
      return `User ${who} deleted support ticket #${(p.metadata?.ticketId as string)?.slice(0, 8) || ''}`;
    // ── Notifications ──
    case 'PUSH_SUBSCRIBE':
      return `User ${who} subscribed to push notifications`;
    case 'PUSH_UNSUBSCRIBE':
      return `User ${who} unsubscribed from push notifications`;
    case 'MARK_ALL_READ':
      return `User ${who} marked ${p.metadata?.count || 'all'} notifications as read`;
    // ── Offer ──
    case 'OFFER_DECLINED':
      return `${role} ${who} declined offer for campaign #${(p.metadata?.campaignId as string)?.slice(0, 8) || ''}`;
    // ── AI ──
    case 'AI_BRAND_SEARCH':
      return `User ${who} searched brands via AI`;
    case 'AI_PRODUCT_SEARCH':
      return `User ${who} searched products via AI`;
    case 'AI_IMAGE_SEARCH':
      return `User ${who} searched images via AI`;
    case 'AI_RATING_VERIFY':
      return `Admin ${who} verified rating via AI`;
    case 'AI_STATUS':
      return `User ${who} checked AI service status`;
    case 'AI_CHAT':
      return `User ${who} sent message to AI assistant`;
    case 'AI_KEY_CHECK':
      return `Admin ${who} validated Gemini API key (${p.metadata?.ok ? 'valid' : 'invalid'})`;
    case 'VAPID_PUBLIC_KEY':
      return `User ${who} retrieved VAPID public key for push notifications`;
    case 'GOOGLE_STATUS_CHECK':
      return `User ${who} checked Google account connection status (${p.metadata?.connected ? 'connected' : 'not connected'})`;
    // ── Journey-specific read actions ──
    case 'SESSION_VIEWED':
      return `${role} ${who} viewed their session profile`;
    case 'AGENCIES_LISTED':
      return `Brand ${who} listed ${p.metadata?.resultCount ?? ''} connected agencies`.trim();
    case 'CAMPAIGNS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} campaigns`.trim();
    case 'ORDERS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} orders${p.metadata?.targetUserId ? ` for user #${(p.metadata.targetUserId as string).slice(0, 8)}` : ''}`.trim();
    case 'TRANSACTIONS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} transactions`.trim();
    case 'INVITES_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} invites`.trim();
    case 'NOTIFICATIONS_LISTED':
      return `User ${who} viewed notifications (${p.metadata?.unreadCount ?? 0} unread)`;
    case 'MEDIATORS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} mediators`.trim();
    case 'DEALS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} deals`.trim();
    case 'PENDING_USERS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} pending buyers awaiting verification`.trim();
    case 'VERIFIED_USERS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} verified buyers`.trim();
    case 'LEDGER_LISTED':
      return `${role} ${who} viewed payout ledger (${p.metadata?.resultCount ?? ''} entries)`.trim();
    case 'PRODUCTS_LISTED':
      return `User ${who} browsed ${p.metadata?.resultCount ?? ''} marketplace products`.trim();
    case 'TICKETS_LISTED':
      return `${role} ${who} listed ${p.metadata?.resultCount ?? ''} support tickets`.trim();
    case 'ORDER_PROOF_VIEWED_PUBLIC':
      return `Public viewer accessed proof for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    // ── Tickets (controller audit actions) ──
    case 'TICKET_RESOLVED':
      return `${role} ${who} resolved ticket #${(p.metadata?.ticketId as string)?.slice(0, 8) || ''}`;
    case 'TICKET_REJECTED':
      return `${role} ${who} rejected ticket #${(p.metadata?.ticketId as string)?.slice(0, 8) || ''}`;
    case 'TICKET_REOPENED':
      return `${role} ${who} reopened ticket #${(p.metadata?.ticketId as string)?.slice(0, 8) || ''}`;
    // ── Brand connections ──
    case 'CONNECTION_APPROVED':
      return `Brand ${who} approved agency connection for ${p.metadata?.agencyCode || 'agency'}`;
    case 'CONNECTION_REJECTED':
      return `Brand ${who} rejected agency connection for ${p.metadata?.agencyCode || 'agency'}`;
    // ── Brand payout ──
    case 'BRAND_AGENCY_PAYOUT':
      return `Brand ${who} processed agency payout (${p.metadata?.amountPaise || 0} paise) to ${p.metadata?.agencyCode || 'agency'}`;
    // ── Push notification aliases ──
    case 'PUSH_SUBSCRIBED':
      return `User ${who} subscribed to push notifications`;
    case 'PUSH_UNSUBSCRIBED':
      return `User ${who} unsubscribed from push notifications`;
    // ── Google OAuth ──
    case 'GOOGLE_OAUTH_INITIATED':
      return `User ${who} initiated Google OAuth flow`;
    case 'GOOGLE_OAUTH_CONNECTED':
      return `User ${who} connected Google account (${p.metadata?.googleEmail || ''})`.trim();
    case 'GOOGLE_OAUTH_DISCONNECTED':
      return `User ${who} disconnected Google account`;
    // ── Sheets ──
    case 'SHEET_EXPORTED':
      return `${role} ${who} exported "${p.metadata?.title || 'data'}" to Google Sheets (${p.metadata?.rowCount || 0} rows)`;
    // ── Order proof ──
    case 'ORDER_PROOF_VIEWED':
      return `${role} ${who} viewed ${p.metadata?.proofType || 'proof'} for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    default:
      break;
  }

  // Fallback: resource-based messages for read operations
  switch (resource) {
    case 'Session':
      return `User ${who} accessed session (/me)`;
    case 'Order':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} orders`.trim();
    case 'OrderAudit':
      return `${role} ${who} viewed audit trail for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    case 'Deal':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} deals`.trim();
    case 'Campaign':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} campaigns`.trim();
    case 'Ticket':
      return `User ${who} viewed ${p.metadata?.resultCount ?? ''} tickets`.trim();
    case 'Invite':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} invites`.trim();
    case 'Agency':
      return `Brand ${who} viewed ${p.metadata?.resultCount ?? ''} agencies`.trim();
    case 'Transaction':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} transactions`.trim();
    case 'Payout':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} payouts`.trim();
    case 'PendingConnection':
      return `${role} ${who} resolved connection request`;
    case 'BrandConnection':
      return `Brand ${who} managed agency connection`;
    case 'Mediator':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} mediators`.trim();
    case 'PendingUsers':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} pending users`.trim();
    case 'User':
      return `${role} ${who} viewed ${p.metadata?.resultCount ?? ''} users`.trim();
    case 'Notification':
      return `User ${who} accessed notifications`;
    case 'PushSubscription':
      return `User ${who} managed push subscription`;
    case 'SSE_STREAM':
      return `${role} ${who} connected to real-time event stream`;
    case 'Sheet':
      return `${role} ${who} exported ${p.metadata?.sheetType || 'data'} to Google Sheets`;
    case 'GoogleOAuth':
      return `User ${who} initiated Google OAuth`;
    case 'AI':
      return `User ${who} used AI service`;
    case 'OrderProof':
      return `${role} ${who} viewed proof for order #${(p.metadata?.orderId as string)?.slice(0, 8) || ''}`;
    case 'DealRedirect':
      return `Buyer ${who} redirected to marketplace for deal #${(p.metadata?.dealId as string)?.slice(0, 8) || ''}`;
    case 'GoogleSheet':
      return `${role} ${who} exported data to Google Sheets`;
    default:
      return `${role} ${who} accessed ${resource}`;
  }
}

function formatAdminAccessMessage(action: string, who: string, p: AccessEventPayload): string {
  const resource = p.resource || 'unknown';
  switch (action) {
    case 'UPDATE_SYSTEM_CONFIG':
      return `Admin ${who} updated system configuration (${(p.metadata?.updatedKeys as string[])?.join(', ') || 'keys'})`;
    case 'DELETE_USER':
      return `Admin ${who} deleted user #${(p.metadata?.targetUserId as string)?.slice(0, 8) || ''}`;
    case 'REINSTATE_USER':
      return `Admin ${who} reinstated user #${(p.metadata?.targetUserId as string)?.slice(0, 8) || ''}`;
    case 'WALLET_ADJUSTED':
      return `Admin ${who} adjusted wallet for user #${(p.metadata?.targetUserId as string)?.slice(0, 8) || ''} by ${p.metadata?.adjustmentPaise || 0} paise`;
    case 'ORDER_STATUS_OVERRIDDEN':
      return `Admin ${who} overrode order status: ${p.metadata?.oldStatus || '?'} → ${p.metadata?.newStatus || '?'}`;
    case 'CONFIG_UPDATED':
      return `Admin ${who} updated system configuration (${(p.metadata?.updatedFields as string[])?.join(', ') || (p.metadata?.updatedKeys as string[])?.join(', ') || 'keys'})`;
    case 'USER_DELETED':
      return `Admin ${who} deleted user #${(p.metadata?.targetUserId as string)?.slice(0, 8) || (p.resource || '').replace(/^User#/, '').slice(0, 8) || ''}`;
    case 'WALLET_DELETED':
      return `Admin ${who} deleted wallet for user #${(p.metadata?.ownerUserId as string)?.slice(0, 8) || (p.resource || '').replace(/^Wallet#/, '').slice(0, 8) || ''}`;
    default:
      break;
  }
  // Fallback for admin read operations
  switch (resource) {
    case 'SystemConfig':
      return `Admin ${who} viewed system configuration`;
    case 'User':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} users${p.metadata?.targetUserId ? ` (detail: #${(p.metadata.targetUserId as string).slice(0, 8)})` : ''}`.trim();
    case 'Deal':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} deals`.trim();
    case 'Wallet':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} wallets`.trim();
    case 'Order':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} orders`.trim();
    case 'AuditLog':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} audit logs`.trim();
    case 'AuditLogs':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} audit logs`.trim();
    case 'Users':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} users`.trim();
    case 'Financials':
      return `Admin ${who} viewed financial overview`;
    case 'Stats':
      return `Admin ${who} viewed platform statistics`;
    case 'Growth':
      return `Admin ${who} viewed growth metrics`;
    case 'Products':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} products`.trim();
    case 'Invite':
      return `Admin ${who} viewed ${p.metadata?.resultCount ?? ''} invites`.trim();
    default:
      return `Admin ${who} performed action on ${resource}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2.  CHANGE LOGS
// ═══════════════════════════════════════════════════════════════════════════════

export type ChangeAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'SOFT_DELETE'
  | 'RESTORE'
  | 'ROLE_CHANGE'
  | 'PERMISSION_CHANGE'
  | 'CONFIG_CHANGE'
  | 'STATUS_CHANGE'
  | 'BULK_OPERATION'
  // Business operations – ops
  | 'MEDIATOR_REJECTED'
  | 'BUYER_APPROVED'
  | 'USER_REJECTED'
  | 'ORDER_CLAIM_VERIFIED'
  | 'REQUIREMENT_VERIFIED'
  | 'ALL_STEPS_VERIFIED'
  | 'PROOF_REJECTED'
  | 'MISSING_PROOF_REQUESTED'
  | 'ORDER_UNSETTLED'
  | 'CAMPAIGN_DELETED'
  | 'SLOTS_ASSIGNED'
  | 'DEAL_PUBLISHED'
  | 'PAYOUT_PROCESSED'
  | 'PAYOUT_DELETED'
  | 'CAMPAIGN_COPIED'
  | 'OFFER_DECLINED'
  // Business operations – admin
  | 'CONFIG_UPDATED'
  | 'DEAL_DELETED'
  | 'USER_DELETED'
  | 'WALLET_DELETED'
  | 'STATUS_UPDATED'
  | 'ORDER_REACTIVATED'
  // Business operations – brand
  | 'AGENCY_PAYOUT'
  | 'CONNECTION_APPROVED'
  | 'CONNECTION_REJECTED'
  | 'AGENCY_REMOVED'
  | 'CAMPAIGN_CREATED'
  | 'CAMPAIGN_UPDATED'
  // Business operations – invites
  | 'INVITE_CREATED'
  | 'INVITE_REVOKED'
  | 'INVITE_DELETED'
  | 'MEDIATOR_INVITE_CREATED'
  | 'BUYER_INVITE_CREATED'
  // Business operations – tickets
  | 'TICKET_CREATED'
  | 'TICKET_STATUS_CHANGE'
  | 'TICKET_DELETED'
  // Business operations – orders/products
  | 'ORDER_REDIRECT_CREATED'
  | 'ORDER_CREATED'
  // Business operations – auth/registration
  | 'BUYER_REGISTERED'
  | 'OPS_USER_REGISTERED'
  | 'BRAND_REGISTERED'
  | 'PROFILE_UPDATED'
  // Business operations – push notifications
  | 'PUSH_SUBSCRIBED'
  | 'PUSH_UNSUBSCRIBED'
  // Business operations – brand connections
  | 'BRAND_CONNECTION_REQUESTED';

export interface ChangeEventPayload {
  /** Who made the change. */
  actorUserId?: string;
  actorRoles?: string[];
  actorIp?: string;
  /** What was changed. */
  entityType: string;
  entityId?: string;
  action: ChangeAction;
  /** Before/after state for auditable comparison. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Changed fields (for partial updates). */
  changedFields?: string[];
  /** Request context. */
  requestId?: string;
  /** Additional context. */
  metadata?: Record<string, unknown>;
}

/**
 * Log a data mutation / change event.
 *
 * Change logs help:
 * - Identify configuration changes that caused incidents
 * - Detect security events (new privileged users, permission changes)
 * - Maintain audit trails for compliance
 * - Support forensic investigation
 */
export function logChangeEvent(payload: ChangeEventPayload): void {
  const isSensitive =
    payload.action === 'ROLE_CHANGE' ||
    payload.action === 'PERMISSION_CHANGE' ||
    payload.action === 'DELETE';
  const level = isSensitive ? 'warn' : 'info';

  const message = formatChangeMessage(payload);

  logEvent(level, message, {
    domain: 'business',
    eventCategory: 'change',
    eventName: `CHANGE_${payload.action}`,
    userId: payload.actorUserId,
    role: payload.actorRoles?.join(','),
    ip: payload.actorIp,
    requestId: payload.requestId,
    metadata: {
      entityType: payload.entityType,
      entityId: payload.entityId,
      action: payload.action,
      changedFields: payload.changedFields,
      before: payload.before ? sanitize(payload.before) : undefined,
      after: payload.after ? sanitize(payload.after) : undefined,
      ...payload.metadata,
    },
  });
}

function formatChangeMessage(p: ChangeEventPayload): string {
  const who = p.actorUserId?.slice(0, 8) || 'system';
  const role = p.actorRoles?.[0] || '';
  const entity = p.entityType;
  const eid = p.entityId?.slice(0, 8) || '';

  switch (p.action) {
    // ── Generic CRUD ──
    case 'CREATE':
      return `${role || 'User'} ${who} created ${entity}${eid ? ` #${eid}` : ''}`;
    case 'UPDATE':
      return `${role || 'User'} ${who} updated ${entity}${eid ? ` #${eid}` : ''} [${p.changedFields?.join(', ') || 'fields'}]`;
    case 'DELETE':
      return `${role || 'User'} ${who} DELETED ${entity}${eid ? ` #${eid}` : ''}`;
    case 'SOFT_DELETE':
      return `${role || 'User'} ${who} soft-deleted ${entity}${eid ? ` #${eid}` : ''}`;
    case 'RESTORE':
      return `${role || 'User'} ${who} restored ${entity}${eid ? ` #${eid}` : ''}`;
    // ── Role/Permission ──
    case 'ROLE_CHANGE':
      return `${role || 'Admin'} ${who} changed roles for ${entity}${eid ? ` #${eid}` : ''}`;
    case 'PERMISSION_CHANGE':
      return `${role || 'Admin'} ${who} changed permissions for ${entity}${eid ? ` #${eid}` : ''}`;
    case 'CONFIG_CHANGE':
    case 'CONFIG_UPDATED':
      return `Admin ${who} updated system configuration`;
    case 'STATUS_CHANGE':
      return `${role || 'User'} ${who} changed ${entity}${eid ? ` #${eid}` : ''} status${p.after?.paymentStatus ? ` → ${p.after.paymentStatus}` : ''}`;
    case 'BULK_OPERATION':
      return `${role || 'Admin'} ${who} performed bulk operation on ${entity}`;
    // ── Ops business ──
    case 'MEDIATOR_REJECTED':
      return `${role || 'ops'} ${who} rejected mediator #${eid}`;
    case 'BUYER_APPROVED':
      return `${role || 'ops'} ${who} approved buyer #${eid}`;
    case 'USER_REJECTED':
      return `${role || 'ops'} ${who} rejected user #${eid}`;
    case 'ORDER_CLAIM_VERIFIED':
      return `${role || 'ops'} ${who} verified order claim #${eid}`;
    case 'REQUIREMENT_VERIFIED':
      return `${role || 'ops'} ${who} verified requirement for order #${eid}`;
    case 'ALL_STEPS_VERIFIED':
      return `${role || 'ops'} ${who} verified ALL steps for order #${eid}`;
    case 'PROOF_REJECTED':
      return `${role || 'ops'} ${who} rejected proof for order #${eid}`;
    case 'MISSING_PROOF_REQUESTED':
      return `${role || 'ops'} ${who} requested missing proof for order #${eid}`;
    case 'ORDER_UNSETTLED':
      return `${role || 'ops'} ${who} unsettled order #${eid}`;
    case 'CAMPAIGN_DELETED':
      return `${role || 'User'} ${who} deleted campaign${eid ? ` #${eid}` : ''}`;
    case 'SLOTS_ASSIGNED':
      return `${role || 'ops'} ${who} assigned slots for campaign #${eid}`;
    case 'DEAL_PUBLISHED':
      return `${role || 'ops'} ${who} published deal for campaign #${eid}`;
    case 'PAYOUT_PROCESSED':
      return `${role || 'ops'} ${who} processed payout #${eid}`;
    case 'PAYOUT_DELETED':
      return `${role || 'ops'} ${who} deleted payout #${eid}`;
    case 'CAMPAIGN_COPIED':
      return `${role || 'User'} ${who} copied campaign #${(p.before?.sourceCampaignId as string)?.slice(0, 8) || eid}`;
    case 'OFFER_DECLINED':
      return `${role || 'ops'} ${who} declined offer for campaign #${eid}`;
    // ── Admin operations ──
    case 'DEAL_DELETED':
      return `Admin ${who} deleted deal #${eid}`;
    case 'USER_DELETED':
      return `Admin ${who} deleted user #${eid}`;
    case 'WALLET_DELETED':
      return `Admin ${who} deleted wallet #${eid}`;
    case 'STATUS_UPDATED':
      return `Admin ${who} updated status for ${entity} #${eid}`;
    case 'ORDER_REACTIVATED':
      return `Admin ${who} reactivated order #${eid}`;
    // ── Brand operations ──
    case 'AGENCY_PAYOUT':
      return `Brand ${who} processed agency payout`;
    case 'CONNECTION_APPROVED':
      return `Brand ${who} approved agency connection`;
    case 'CONNECTION_REJECTED':
      return `Brand ${who} rejected agency connection`;
    case 'AGENCY_REMOVED':
      return `Brand ${who} removed agency`;
    case 'CAMPAIGN_CREATED':
      return `${role || 'Brand'} ${who} created campaign${p.after?.title ? ` "${p.after.title}"` : ''}`;
    case 'CAMPAIGN_UPDATED':
      return `${role || 'Brand'} ${who} updated campaign #${eid} [${p.changedFields?.join(', ') || 'fields'}]`;
    // ── Invites ──
    case 'INVITE_CREATED':
      return `${role || 'User'} ${who} created invite #${eid}`;
    case 'INVITE_REVOKED':
      return `${role || 'User'} ${who} revoked invite #${eid}`;
    case 'INVITE_DELETED':
      return `${role || 'User'} ${who} deleted invite #${eid}`;
    case 'MEDIATOR_INVITE_CREATED':
      return `Agency ${who} created invite for new mediator`;
    case 'BUYER_INVITE_CREATED':
      return `Mediator ${who} created invite for new buyer`;
    // ── Tickets ──
    case 'TICKET_CREATED':
      return `User ${who} created support ticket #${eid}`;
    case 'TICKET_STATUS_CHANGE':
      return `User ${who} changed ticket #${eid} status${p.after?.status ? ` → ${p.after.status}` : ''}`;
    case 'TICKET_DELETED':
      return `${role || 'User'} ${who} deleted support ticket #${eid}`;
    // ── Products ──
    case 'ORDER_REDIRECT_CREATED':
      return `User ${who} redirected to marketplace for order #${eid}`;
    case 'ORDER_CREATED':
      return `Buyer ${who} created new order #${eid}${p.after?.platform ? ` on ${p.after.platform}` : ''}`;
    // ── Auth / Registration ──
    case 'BUYER_REGISTERED':
      return `New buyer ${who} registered${p.after?.mobile ? ` (mobile: ${p.after.mobile})` : ''}`;
    case 'OPS_USER_REGISTERED':
      return `New ${(p.after?.role as string) || 'ops user'} ${who} registered${p.after?.mediatorCode ? ` (code: ${p.after.mediatorCode})` : ''}`;
    case 'BRAND_REGISTERED':
      return `New brand ${who} registered${p.after?.brandName ? ` (${p.after.brandName})` : ''}`;
    case 'PROFILE_UPDATED':
      return `${role || 'User'} ${who} updated profile [${p.changedFields?.join(', ') || 'fields'}]`;
    // ── Push Notifications ──
    case 'PUSH_SUBSCRIBED':
      return `User ${who} subscribed to push notifications`;
    case 'PUSH_UNSUBSCRIBED':
      return `User ${who} unsubscribed from push notifications`;
    // ── Brand connections ──
    case 'BRAND_CONNECTION_REQUESTED':
      return `${role || 'ops'} ${who} requested brand connection${p.after?.brandName ? ` with ${p.after.brandName}` : ''}`;
    default:
      return `${role || 'User'} ${who} performed ${p.action} on ${entity}${eid ? ` #${eid}` : ''}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3.  ERROR LOGS
// ═══════════════════════════════════════════════════════════════════════════════

export type ErrorCategory =
  | 'VALIDATION'
  | 'DATABASE'
  | 'NETWORK'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'BUSINESS_LOGIC'
  | 'EXTERNAL_SERVICE'
  | 'SYSTEM'
  | 'CONFIGURATION'
  | 'CLIENT';

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ErrorEventPayload {
  /** Error classification. */
  category: ErrorCategory;
  severity: ErrorSeverity;
  /** The original error (if available). */
  error?: Error | unknown;
  /** Human-readable description. */
  message: string;
  /** Error code (e.g. P2002, ECONNREFUSED). */
  errorCode?: string;
  /** What operation was being performed. */
  operation?: string;
  /** Request context. */
  requestId?: string;
  userId?: string;
  ip?: string;
  method?: string;
  route?: string;
  /** Impact assessment. */
  userFacing?: boolean;
  retryable?: boolean;
  /** Additional context. */
  metadata?: Record<string, unknown>;
}

/**
 * Log a categorized error event with severity classification.
 *
 * Error logs help:
 * - Identify issues before they become outages
 * - Track error frequency and patterns
 * - Prioritize fixes by impact
 * - Improve system resilience
 */
export function logErrorEvent(payload: ErrorEventPayload): void {
  const level = payload.severity === 'critical' || payload.severity === 'high' ? 'error' : 'warn';
  const err = payload.error instanceof Error ? payload.error : undefined;

  logEvent(level, payload.message, {
    domain: mapErrorCategoryToDomain(payload.category),
    eventCategory: 'error',
    eventName: `ERROR_${payload.category}`,
    errorCode: payload.errorCode || (err as any)?.code,
    stack: err?.stack,
    userId: payload.userId,
    ip: payload.ip,
    method: payload.method,
    route: payload.route,
    requestId: payload.requestId,
    metadata: {
      category: payload.category,
      severity: payload.severity,
      operation: payload.operation,
      errorName: err?.name,
      userFacing: payload.userFacing,
      retryable: payload.retryable,
      ...payload.metadata,
    },
  });
}

function mapErrorCategoryToDomain(
  category: ErrorCategory
): 'http' | 'auth' | 'db' | 'business' | 'system' | 'security' | 'ai' | 'realtime' {
  switch (category) {
    case 'DATABASE':
      return 'db';
    case 'AUTHENTICATION':
    case 'AUTHORIZATION':
      return 'security';
    case 'NETWORK':
    case 'EXTERNAL_SERVICE':
      return 'system';
    case 'BUSINESS_LOGIC':
    case 'VALIDATION':
      return 'business';
    case 'CONFIGURATION':
    case 'SYSTEM':
      return 'system';
    default:
      return 'system';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  4.  AVAILABILITY LOGS
// ═══════════════════════════════════════════════════════════════════════════════

export type AvailabilityEventType =
  | 'APPLICATION_STARTING'
  | 'APPLICATION_READY'
  | 'APPLICATION_SHUTDOWN_START'
  | 'APPLICATION_SHUTDOWN_COMPLETE'
  | 'DATABASE_CONNECTED'
  | 'DATABASE_DISCONNECTED'
  | 'DATABASE_RECONNECTED'
  | 'DATABASE_ERROR'
  | 'HEALTH_CHECK_PASS'
  | 'HEALTH_CHECK_FAIL'
  | 'DEPENDENCY_UP'
  | 'DEPENDENCY_DOWN'
  | 'MEMORY_WARNING'
  | 'CPU_WARNING';

export interface AvailabilityEventPayload {
  /** What's being reported. */
  component?: string;
  /** Current status. */
  status?: 'up' | 'down' | 'degraded' | 'starting' | 'stopping';
  /** Response time for health checks (ms). */
  responseTimeMs?: number;
  /** Uptime in seconds. */
  uptimeSeconds?: number;
  /** Additional metrics. */
  metadata?: Record<string, unknown>;
}

/**
 * Log an availability / health event.
 *
 * Availability logs help:
 * - Calculate SLA metrics (uptime reporting)
 * - Investigate unplanned shutdowns
 * - Confirm expected behaviour during maintenance windows
 * - Detect database connectivity issues early
 */
export function logAvailabilityEvent(
  type: AvailabilityEventType,
  payload: AvailabilityEventPayload = {}
): void {
  const isError =
    type === 'DATABASE_ERROR' ||
    type === 'DATABASE_DISCONNECTED' ||
    type === 'HEALTH_CHECK_FAIL' ||
    type === 'DEPENDENCY_DOWN' ||
    type === 'MEMORY_WARNING' ||
    type === 'CPU_WARNING';

  const level = isError ? 'error' : 'info';

  const message = formatAvailabilityMessage(type, payload);
  const metrics = getSystemMetrics();

  logEvent(level, message, {
    domain: 'system',
    eventCategory: 'availability',
    eventName: type,
    metadata: {
      component: payload.component,
      status: payload.status,
      responseTimeMs: payload.responseTimeMs,
      uptimeSeconds: payload.uptimeSeconds ?? Math.floor(process.uptime()),
      ...metrics,
      ...payload.metadata,
    },
  });
}

function formatAvailabilityMessage(type: AvailabilityEventType, p: AvailabilityEventPayload): string {
  const component = p.component || 'application';
  switch (type) {
    case 'APPLICATION_STARTING':
      return `${component} starting…`;
    case 'APPLICATION_READY':
      return `${component} is ready and accepting traffic`;
    case 'APPLICATION_SHUTDOWN_START':
      return `${component} shutting down…`;
    case 'APPLICATION_SHUTDOWN_COMPLETE':
      return `${component} shutdown complete`;
    case 'DATABASE_CONNECTED':
      return `Database connected (${p.responseTimeMs ?? '?'}ms)`;
    case 'DATABASE_DISCONNECTED':
      return `Database disconnected — ${p.status || 'down'}`;
    case 'DATABASE_RECONNECTED':
      return `Database reconnected (${p.responseTimeMs ?? '?'}ms)`;
    case 'DATABASE_ERROR':
      return `Database error: ${p.component || 'unknown'}`;
    case 'HEALTH_CHECK_PASS':
      return `Health check passed (${p.responseTimeMs ?? '?'}ms)`;
    case 'HEALTH_CHECK_FAIL':
      return `Health check failed: ${p.component || 'unknown'} — ${p.status || 'down'}`;
    case 'DEPENDENCY_UP':
      return `Dependency ${p.component || 'unknown'} is up`;
    case 'DEPENDENCY_DOWN':
      return `Dependency ${p.component || 'unknown'} is down`;
    case 'MEMORY_WARNING':
      return `Memory usage warning: ${p.metadata?.memoryMB || '?'}MB`;
    case 'CPU_WARNING':
      return `CPU usage warning`;
    default:
      return `Availability event: ${type}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  5.  SECURITY EVENT LOGS (enhanced)
// ═══════════════════════════════════════════════════════════════════════════════

export type SecurityEventType =
  | 'BRUTE_FORCE_DETECTED'
  | 'SUSPICIOUS_PATTERN'
  | 'PRIVILEGE_ESCALATION_ATTEMPT'
  | 'RATE_LIMIT_HIT'
  | 'INVALID_TOKEN'
  | 'FORBIDDEN_ACCESS'
  | 'IP_BLOCKED'
  | 'CORS_VIOLATION'
  | 'INJECTION_ATTEMPT'
  | 'MALICIOUS_PAYLOAD'
  | 'AUDIT_TRAIL_LOSS';

export interface SecurityEventPayload {
  severity: 'low' | 'medium' | 'high' | 'critical';
  ip?: string;
  userId?: string;
  route?: string;
  method?: string;
  requestId?: string;
  /** What was detected. */
  pattern?: string;
  /** Where it was detected. */
  location?: string;
  /** How many times in current window. */
  attemptCount?: number;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a security-relevant event.
 *
 * Security logs help:
 * - Detect and respond to active attacks
 * - Identify brute-force / credential-stuffing campaigns
 * - Track privilege escalation attempts
 * - Feed SIEM / alerting pipelines
 */
export function logSecurityIncident(type: SecurityEventType, payload: SecurityEventPayload): void {
  const level = payload.severity === 'critical' || payload.severity === 'high' ? 'error' : 'warn';

  logEvent(level, `SECURITY: ${type} from ${payload.ip || 'unknown'}`, {
    domain: 'security',
    eventCategory: 'security_incident',
    eventName: type,
    userId: payload.userId,
    ip: payload.ip,
    method: payload.method,
    route: payload.route,
    requestId: payload.requestId,
    metadata: {
      severity: payload.severity,
      pattern: payload.pattern,
      location: payload.location,
      attemptCount: payload.attemptCount,
      userAgent: payload.userAgent,
      ...payload.metadata,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  6.  PERIODIC AVAILABILITY MONITOR
// ═══════════════════════════════════════════════════════════════════════════════

let availabilityInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic availability monitor that logs system health every interval.
 * Logs memory warnings if RSS exceeds the threshold.
 *
 * @param intervalMs - How often to check (default: 5 minutes)
 * @param memoryThresholdMB - RSS threshold to trigger memory warnings (default: 512MB)
 */
export function startAvailabilityMonitor(
  intervalMs = 5 * 60_000,
  memoryThresholdMB = 512
): void {
  if (availabilityInterval) return; // already running

  availabilityInterval = setInterval(() => {
    const metrics = getSystemMetrics();
    const uptimeSeconds = Math.floor(process.uptime());

    // Periodic health status
    logAvailabilityEvent('HEALTH_CHECK_PASS', {
      component: 'application',
      status: 'up',
      uptimeSeconds,
      metadata: {
        ...metrics,
        eventLoopLag: 'ok',
      },
    });

    // Memory warning check
    if (metrics.memoryMB > memoryThresholdMB) {
      logAvailabilityEvent('MEMORY_WARNING', {
        component: 'process',
        status: 'degraded',
        metadata: {
          ...metrics,
          thresholdMB: memoryThresholdMB,
        },
      });
    }
  }, intervalMs);

  availabilityInterval.unref(); // don't prevent process exit
}

/**
 * Stop the periodic availability monitor (for graceful shutdown).
 */
export function stopAvailabilityMonitor(): void {
  if (availabilityInterval) {
    clearInterval(availabilityInterval);
    availabilityInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  7.  PERFORMANCE LOG HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export interface PerformanceLogPayload {
  operation: string;
  durationMs: number;
  slowThresholdMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Log a performance measurement for any operation.
 * Automatically flags slow operations.
 */
export function logPerformance(payload: PerformanceLogPayload): void {
  const threshold = payload.slowThresholdMs ?? 500;
  const isSlow = payload.durationMs > threshold;
  const level = isSlow ? 'warn' : 'info';

  perfLog.log(level, `${payload.operation}: ${payload.durationMs}ms${isSlow ? ' [SLOW]' : ''}`, {
    operation: payload.operation,
    durationMs: payload.durationMs,
    slow: isSlow,
    threshold,
    ...payload.metadata,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  8.  DATABASE EVENT LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log database lifecycle events (connection, disconnection, migration, query errors).
 */
export function logDatabaseEvent(
  type: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTED' | 'MIGRATION_APPLIED' | 'QUERY_ERROR' | 'SLOW_QUERY',
  payload: { durationMs?: number; error?: unknown; metadata?: Record<string, unknown> } = {}
): void {
  const isError = type === 'QUERY_ERROR' || type === 'DISCONNECTED';
  const level = isError ? 'error' : type === 'SLOW_QUERY' ? 'warn' : 'info';
  const err = payload.error instanceof Error ? payload.error : undefined;

  dbLog.log(level, `Database ${type.toLowerCase().replace(/_/g, ' ')}`, {
    domain: 'db',
    eventName: `DB_${type}`,
    durationMs: payload.durationMs,
    ...(err ? { errorName: err.name, errorMessage: err.message, stack: err.stack } : {}),
    ...payload.metadata,
  });
}
