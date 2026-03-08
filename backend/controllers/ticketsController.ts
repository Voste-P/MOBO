import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { idWhere } from '../utils/idWhere.js';
import type { Role } from '../middleware/auth.js';
import { orderLog, businessLog } from '../config/logger.js';
import { logChangeEvent, logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import { prisma } from '../database/prisma.js';
import { sendPushToUser } from '../services/pushNotifications.js';
import { createTicketSchema, updateTicketSchema, TICKET_TARGET_ROLE, ESCALATION_PATH, ROLE_ISSUE_TYPES, ROLE_LEVEL } from '../validations/tickets.js';
import { toUiTicket, toUiTicketForBrand } from '../utils/uiMappers.js';
import { pgTicket } from '../utils/pgMappers.js';
import { getRequester, isPrivileged } from '../services/authz.js';
import { getAgencyCodeForMediatorCode, listMediatorCodesForAgency } from '../services/lineage.js';
import { publishRealtime } from '../services/realtimeHub.js';
import { writeAuditLog } from '../services/audit.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

/** Batch-resolve resolvedBy user IDs to user names for a list of tickets */
async function enrichTicketsWithResolverNames(tickets: any[]): Promise<any[]> {
  const db = prisma();
  const resolverIds = [...new Set(tickets.map(t => t.resolvedBy).filter(Boolean))];
  if (!resolverIds.length) return tickets;
  const resolvers = await db.user.findMany({
    where: { id: { in: resolverIds } },
    select: { id: true, name: true },
  });
  const nameMap = new Map(resolvers.map(r => [r.id, r.name]));
  return tickets.map(t => ({
    ...t,
    resolvedByName: t.resolvedBy ? (nameMap.get(t.resolvedBy) || null) : null,
  }));
}

async function buildTicketAudience(ticket: any) {
  const privilegedRoles: Role[] = ['admin', 'ops'];
  const userIds = new Set<string>();
  const ticketOwnerMongoId = String(ticket?._id || ticket?.mongoId || '').trim();

  let mediatorCodes: string[] | undefined;
  let agencyCodes: string[] | undefined;

  const orderId = String(ticket?.orderId || '').trim();
  if (orderId) {
    const db = prisma();
    const order = await db.order.findFirst({
      where: { ...idWhere(orderId), isDeleted: false },
      select: {
        managerName: true,
        user: { select: { mongoId: true } },
        brandUser: { select: { mongoId: true } },
      },
    });
    if (order) {
      if (order.user?.mongoId) userIds.add(order.user.mongoId);
      if (order.brandUser?.mongoId) userIds.add(order.brandUser.mongoId);
      const mediatorCode = String(order.managerName || '').trim();
      if (mediatorCode) {
        mediatorCodes = [mediatorCode];
        const agencyCode = (await getAgencyCodeForMediatorCode(mediatorCode)) || '';
        if (agencyCode) agencyCodes = [agencyCode];
      }
    }
  }

  // Add ticket owner's mongoId for realtime targeting
  if (ticketOwnerMongoId) userIds.add(ticketOwnerMongoId);

  return { roles: privilegedRoles, userIds: Array.from(userIds), mediatorCodes, agencyCodes };
}

async function getScopedOrderMongoIds(params: {
  roles: string[];
  pgUserId: string;
  requesterUser: any;
}): Promise<string[]> {
  const { roles, pgUserId, requesterUser } = params;
  const db = prisma();

  if (isPrivileged(roles)) return [];

  if (roles.includes('brand')) {
    const orders = await db.order.findMany({
      where: { brandUserId: pgUserId, isDeleted: false },
      select: { mongoId: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return orders.map((o) => o.mongoId!).filter(Boolean);
  }

  if (roles.includes('mediator')) {
    const mediatorCode = String(requesterUser?.mediatorCode || '').trim();
    if (!mediatorCode) return [];
    const orders = await db.order.findMany({
      where: { managerName: mediatorCode, isDeleted: false },
      select: { mongoId: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return orders.map((o) => o.mongoId!).filter(Boolean);
  }

  if (roles.includes('agency')) {
    const agencyCode = await resolveAgencyCode(pgUserId, requesterUser);
    if (!agencyCode) return [];
    const mediatorCodes = await listMediatorCodesForAgency(agencyCode);
    if (!mediatorCodes.length) return [];
    const orders = await db.order.findMany({
      where: { managerName: { in: mediatorCodes }, isDeleted: false },
      select: { mongoId: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return orders.map((o) => o.mongoId!).filter(Boolean);
  }

  return [];
}

async function assertCanReferenceOrder(params: { orderId: string; pgUserId: string; roles: string[]; user: any }) {
  const { orderId, pgUserId, roles, user } = params;
  const db = prisma();

  const order = await db.order.findFirst({
    where: { ...idWhere(orderId), isDeleted: false },
    select: { userId: true, managerName: true, brandUserId: true },
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

  if (isPrivileged(roles)) return;

  if (roles.includes('shopper')) {
    if (order.userId !== pgUserId) throw new AppError(403, 'FORBIDDEN', 'Cannot reference orders outside your account');
    return;
  }
  if (roles.includes('brand')) {
    if ((order.brandUserId || '') !== pgUserId) throw new AppError(403, 'FORBIDDEN', 'Cannot reference orders outside your brand');
    return;
  }
  if (roles.includes('mediator')) {
    const mediatorCode = String(user?.mediatorCode || '').trim();
    if (!mediatorCode || order.managerName !== mediatorCode) throw new AppError(403, 'FORBIDDEN', 'Cannot reference orders outside your network');
    return;
  }
  if (roles.includes('agency')) {
    const agencyCode = await resolveAgencyCode(pgUserId, user);
    const mediatorCodes = agencyCode ? await listMediatorCodesForAgency(agencyCode) : [];
    if (!mediatorCodes.includes(order.managerName)) throw new AppError(403, 'FORBIDDEN', 'Cannot reference orders outside your network');
    return;
  }
  throw new AppError(403, 'FORBIDDEN', 'Insufficient role');
}

/**
 * Resolve the agency code for an agency user.
 * Tries user.mediatorCode first (fast path), then falls back to the Agency model.
 */
async function resolveAgencyCode(pgUserId: string, user: any): Promise<string> {
  const fromUser = String(user?.mediatorCode || '').trim();
  if (fromUser) return fromUser;
  // Fallback: look up the Agency model by owner user ID
  const db = prisma();
  const agency = await db.agency.findFirst({
    where: { ownerUserId: pgUserId, isDeleted: false },
    select: { agencyCode: true },
  });
  return agency?.agencyCode || '';
}

/**
 * Check if the current user can manage (resolve/reject/escalate/comment) a ticket.
 *
 * This verifies NETWORK MEMBERSHIP — i.e. the ticket creator is within the
 * current user's hierarchy scope. The frontend decides which actions (resolve,
 * reject, escalate) to show based on the ticket's targetRole.
 *
 * Cascade routing: buyer→mediator→agency→brand→admin
 *
 * IMPORTANT: This function must never throw — always returns boolean.
 * Unhandled exceptions would bubble up as 500 in the caller.
 */
async function canManageTicketByRole(params: {
  ticket: any;
  roles: string[];
  pgUserId: string;
  user: any;
}): Promise<boolean> {
  try {
    const { ticket, roles, pgUserId, user } = params;

    if (isPrivileged(roles)) return true;
    if (ticket.userId === pgUserId) return true;

    const db = prisma();
    const ticketTargetRole = String(ticket.targetRole || '').trim();

    // ── Mediator: can manage tickets from buyers in their network ──
    if (roles.includes('mediator')) {
      const mediatorCode = String(user?.mediatorCode || '').trim();
      if (mediatorCode) {
        // Buyer registered under this mediator (parentCode)
        const registered = await db.user.findFirst({
          where: { id: ticket.userId, parentCode: mediatorCode, isDeleted: false },
          select: { id: true },
        });
        if (registered) return true;

        // Buyer has orders managed by this mediator
        const hasOrders = await db.order.count({
          where: { managerName: mediatorCode, userId: ticket.userId, isDeleted: false },
        });
        if (hasOrders > 0) return true;

        // Ticket's specific order is managed by this mediator
        if (ticket.orderId) {
          const order = await db.order.findFirst({
            where: { ...idWhere(ticket.orderId), managerName: mediatorCode, isDeleted: false },
          });
          if (order) return true;
        }
      }
    }

    // ── Agency: can manage tickets from mediators + buyers in their network ──
    if (roles.includes('agency')) {
      const agencyCode = await resolveAgencyCode(pgUserId, user);
      if (agencyCode) {
        const mediatorCodes = await listMediatorCodesForAgency(agencyCode);

        // Creator is directly registered under this agency (parentCode = agencyCode)
        const directReg = await db.user.findFirst({
          where: { id: ticket.userId, parentCode: agencyCode, isDeleted: false },
          select: { id: true },
        });
        if (directReg) return true;

        if (mediatorCodes.length > 0) {
          // Creator is a mediator in this agency's network
          const mediatorUser = await db.user.findFirst({
            where: { id: ticket.userId, mediatorCode: { in: mediatorCodes }, isDeleted: false },
            select: { id: true },
          });
          if (mediatorUser) return true;

          // Creator is a buyer under a mediator in this agency's network
          const buyerUnderMediator = await db.user.findFirst({
            where: { id: ticket.userId, parentCode: { in: mediatorCodes }, isDeleted: false },
            select: { id: true },
          });
          if (buyerUnderMediator) return true;
        }

        // Via order linkage — check ANY order managed by this agency or its mediators
        // (covers cases where buyer ticket was escalated and has no orderId, or orderId format differs)
        const allAgencyCodes = [agencyCode, ...mediatorCodes];
        if (ticket.orderId) {
          const order = await db.order.findFirst({
            where: { ...idWhere(ticket.orderId), managerName: { in: allAgencyCodes }, isDeleted: false },
          });
          if (order) return true;
        }
        // Fallback: check if ticket creator has ANY orders managed by this agency's network
        const hasAnyAgencyOrders = await db.order.count({
          where: { managerName: { in: allAgencyCodes }, userId: ticket.userId, isDeleted: false },
        });
        if (hasAnyAgencyOrders > 0) return true;
      }
    }

    // ── Brand: can manage tickets from connected agencies + their downstream ──
    if (roles.includes('brand')) {
      const brand = await db.brand.findFirst({
        where: { ownerUserId: pgUserId, isDeleted: false },
        select: { connectedAgencyCodes: true },
      });
      const connectedCodes = brand?.connectedAgencyCodes ?? [];
      if (connectedCodes.length) {
        // Creator is a connected agency owner
        const connectedAgencies = await db.agency.findMany({
          where: { agencyCode: { in: connectedCodes }, isDeleted: false },
          select: { ownerUserId: true },
        });
        if (connectedAgencies.some(a => a.ownerUserId === ticket.userId)) return true;

        // Creator is registered under any connected agency (or their mediators)
        const regUnderAgency = await db.user.findFirst({
          where: { id: ticket.userId, parentCode: { in: connectedCodes }, isDeleted: false },
          select: { id: true },
        });
        if (regUnderAgency) return true;

        // Resolve mediator codes under all connected agencies for deep lookup
        const allMediatorCodes: string[] = [];
        for (const code of connectedCodes) {
          const mCodes = await listMediatorCodesForAgency(code);
          allMediatorCodes.push(...mCodes);
        }
        if (allMediatorCodes.length) {
          // Creator is a mediator in a connected agency network
          const mediatorInNetwork = await db.user.findFirst({
            where: { id: ticket.userId, mediatorCode: { in: allMediatorCodes }, isDeleted: false },
            select: { id: true },
          });
          if (mediatorInNetwork) return true;

          // Creator is a buyer under mediators in connected agency networks
          const deepReg = await db.user.findFirst({
            where: { id: ticket.userId, parentCode: { in: allMediatorCodes }, isDeleted: false },
            select: { id: true },
          });
          if (deepReg) return true;
        }

        // Via order linkage — specific order check
        if (ticket.orderId) {
          const order = await db.order.findFirst({
            where: { ...idWhere(ticket.orderId), brandUserId: pgUserId, isDeleted: false },
          });
          if (order) return true;
        }
        // Fallback: check if ticket creator has ANY orders from this brand
        const hasAnyBrandOrders = await db.order.count({
          where: { brandUserId: pgUserId, userId: ticket.userId, isDeleted: false },
        });
        if (hasAnyBrandOrders > 0) return true;
      }
    }

    // ── Fallback: order reference check ──
    if (ticket.orderId) {
      try {
        await assertCanReferenceOrder({ orderId: ticket.orderId, pgUserId, roles, user });
        return true;
      } catch { /* not allowed via order */ }
    }

    // ── Broader network fallback for escalated tickets ──
    // When a ticket has been escalated, the original creator may not be
    // directly findable via the standard checks above. This fallback uses
    // the ticket creator's entire chain to see if ANY link exists.
    if (ticketTargetRole) {
      const actorRole = String(user?.role || roles[0] || 'shopper');
      const actorLevel = ROLE_LEVEL[actorRole] ?? 0;
      const tgtLevel = ROLE_LEVEL[ticketTargetRole] ?? 0;

      // Only apply this fallback when the actor is at the target level
      if (actorLevel === tgtLevel && tgtLevel > 0) {
        // Check if the ticket creator is anywhere in the actor's downstream hierarchy
        const creator = await db.user.findFirst({
          where: { id: ticket.userId, isDeleted: false },
          select: { id: true, parentCode: true, mediatorCode: true, role: true },
        });
        if (creator) {
          const creatorParent = String(creator.parentCode || '').trim();
          const creatorMediator = String(creator.mediatorCode || '').trim();

          if (roles.includes('mediator')) {
            const mediatorCode = String(user?.mediatorCode || '').trim();
            if (mediatorCode && (creatorParent === mediatorCode || creatorMediator === mediatorCode)) {
              return true;
            }
          }
          if (roles.includes('agency')) {
            const agencyCode = await resolveAgencyCode(pgUserId, user);
            if (agencyCode) {
              // Check if creator's parentCode or mediatorCode links to this agency
              if (creatorParent === agencyCode || creatorMediator === agencyCode) return true;
              const mediatorCodes = await listMediatorCodesForAgency(agencyCode);
              if (mediatorCodes.length > 0) {
                if (mediatorCodes.includes(creatorParent) || mediatorCodes.includes(creatorMediator)) return true;
                // Creator might be a buyer whose mediator's code maps back to this agency
                if (creatorParent) {
                  const parentUser = await db.user.findFirst({
                    where: { mediatorCode: creatorParent, isDeleted: false },
                    select: { parentCode: true },
                  });
                  if (parentUser && String(parentUser.parentCode || '') === agencyCode) return true;
                }
              }
            }
          }
          if (roles.includes('brand')) {
            const brand = await db.brand.findFirst({
              where: { ownerUserId: pgUserId, isDeleted: false },
              select: { connectedAgencyCodes: true },
            });
            const connectedCodes = brand?.connectedAgencyCodes ?? [];
            if (connectedCodes.length > 0) {
              if (connectedCodes.includes(creatorParent) || connectedCodes.includes(creatorMediator)) return true;
              // Check if creator is under a mediator whose agency is connected
              const allMediatorCodes: string[] = [];
              for (const code of connectedCodes) {
                const mCodes = await listMediatorCodesForAgency(code);
                allMediatorCodes.push(...mCodes);
              }
              if (allMediatorCodes.includes(creatorParent) || allMediatorCodes.includes(creatorMediator)) return true;
            }
          }
        }
      }
    }

    return false;
  } catch (err) {
    // Never throw from canManageTicketByRole — log and deny
    orderLog.error('[canManageTicketByRole] Unexpected error during permission check', { error: err, ticketId: params.ticket?.id, userId: params.pgUserId });
    return false;
  }
}

export function makeTicketsController(env: import('../config/env.js').Env) {
  return {
    getTicketById: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '').trim();
        if (!id) throw new AppError(400, 'INVALID_TICKET_ID', 'Invalid ticket id');

        const { roles, pgUserId, user } = getRequester(req);
        const db = prisma();

        const ticket = await db.ticket.findFirst({
          where: { ...idWhere(id), isDeleted: false },
          include: { comments: { where: { isDeleted: false }, orderBy: { createdAt: 'asc' } } },
        });
        if (!ticket) throw new AppError(404, 'TICKET_NOT_FOUND', 'Ticket not found');

        // Allow ticket owner, targeted role managers, or privileged roles
        const canAccess = await canManageTicketByRole({ ticket, roles, pgUserId, user });
        if (!canAccess) throw new AppError(403, 'FORBIDDEN', 'Not allowed');

        const mapped = pgTicket(ticket);
        const enriched = (await enrichTicketsWithResolverNames([mapped]))[0];
        const uiTicket = roles.includes('brand') ? toUiTicketForBrand(enriched) : toUiTicket(enriched);

        res.json({
          ...uiTicket,
          comments: (ticket.comments || []).map((c: any) => ({
            id: c.id,
            userId: c.userId,
            userName: c.userName,
            role: c.role,
            message: c.message,
            createdAt: c.createdAt,
          })),
        });
      } catch (err) {
        next(err);
      }
    },

    listComments: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ticketId = String(req.params.id || '').trim();
        if (!ticketId) throw new AppError(400, 'INVALID_TICKET_ID', 'Invalid ticket id');

        const { roles, pgUserId, user } = getRequester(req);
        const db = prisma();

        const ticket = await db.ticket.findFirst({ where: { ...idWhere(ticketId), isDeleted: false } });
        if (!ticket) throw new AppError(404, 'TICKET_NOT_FOUND', 'Ticket not found');

        // Access check — allow targeted role managers
        const canAccess = await canManageTicketByRole({ ticket, roles, pgUserId, user });
        if (!canAccess) throw new AppError(403, 'FORBIDDEN', 'Not allowed');

        const comments = await db.ticketComment.findMany({
          where: { ticketId: ticket.id, isDeleted: false },
          orderBy: { createdAt: 'asc' },
        });

        res.json({
          comments: comments.map((c) => ({
            id: c.id,
            userId: c.userId,
            userName: c.userName,
            role: c.role,
            message: c.message,
            createdAt: c.createdAt,
          })),
        });
      } catch (err) {
        next(err);
      }
    },

    addComment: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ticketId = String(req.params.id || '').trim();
        if (!ticketId) throw new AppError(400, 'INVALID_TICKET_ID', 'Invalid ticket id');

        const message = String(req.body.message || '').trim();
        if (!message || message.length > 2000) throw new AppError(400, 'INVALID_COMMENT', 'Comment must be 1-2000 characters');

        const { roles, pgUserId, user } = getRequester(req);
        const db = prisma();

        const ticket = await db.ticket.findFirst({ where: { ...idWhere(ticketId), isDeleted: false } });
        if (!ticket) throw new AppError(404, 'TICKET_NOT_FOUND', 'Ticket not found');

        // Access check — allow targeted role managers
        const canAccess = await canManageTicketByRole({ ticket, roles, pgUserId, user });
        if (!canAccess) throw new AppError(403, 'FORBIDDEN', 'Not allowed');

        const userName = String(user?.name || 'User');
        const role = String(user?.role || roles[0] || 'shopper');
        const comment = await db.ticketComment.create({
          data: {
            ticketId: ticket.id,
            userId: pgUserId,
            userName,
            role,
            message,
          },
        });

        // Publish realtime update for the ticket thread
        const mapped = pgTicket(ticket);
        const audience = await buildTicketAudience(mapped);
        publishRealtime({ type: 'tickets.changed', ts: new Date().toISOString(), payload: { ticketId: String(mapped._id), commentAdded: true }, audience });

        // Push notification to ticket creator if comment is from someone else
        if (ticket.userId !== pgUserId) {
          const ticketCreatorRole = String(ticket.role || 'shopper');
          const pushApp = ticketCreatorRole === 'mediator' ? 'mediator' as const
            : ticketCreatorRole === 'agency' ? 'agency' as const
            : ticketCreatorRole === 'brand' ? 'brand' as const
            : 'buyer' as const;
          sendPushToUser({
            env, userId: ticket.userId, app: pushApp,
            payload: { title: 'New Comment on Your Ticket', body: `${userName} replied: ${message.slice(0, 100)}`, url: '/' },
          }).catch(() => { /* best-effort */ });
        }

        businessLog.info(`[Comment] User ${req.auth?.userId} commented on ticket ${ticketId}`, { ticketId, userId: req.auth?.userId });
        await writeAuditLog({ req, action: 'TICKET_COMMENT_ADDED', entityType: 'Ticket', entityId: ticketId, metadata: { commentId: comment.id, role } });

        res.status(201).json({
          id: comment.id,
          userId: comment.userId,
          userName: comment.userName,
          role: comment.role,
          message: comment.message,
          createdAt: comment.createdAt,
        });
      } catch (err) {
        next(err);
      }
    },

    listTickets: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { roles, pgUserId, user } = getRequester(req);
        const db = prisma();

        const logTicketAccess = (count: number) => {
          businessLog.info(`[${String(req.auth?.roles?.[0] || 'User').charAt(0).toUpperCase() + String(req.auth?.roles?.[0] || 'User').slice(1)}] User ${req.auth?.userId} listed tickets — ${count} results`, { actorUserId: req.auth?.userId, roles: req.auth?.roles, resultCount: count, ip: req.ip });
          logAccessEvent('RESOURCE_ACCESS', {
            userId: req.auth?.userId,
            roles: req.auth?.roles,
            ip: req.ip,
            resource: 'Ticket',
            requestId: String((res as any).locals?.requestId || ''),
            metadata: { action: 'TICKETS_LISTED', endpoint: 'listTickets', resultCount: count },
          });
        };

        if (isPrivileged(roles)) {
          // Admin/ops can filter by role, status, targetRole, and priority query params
          const roleFilter = String(req.query.role || '').trim().toLowerCase();
          const statusFilter = String(req.query.status || '').trim();
          const targetRoleFilter = String(req.query.targetRole || '').trim().toLowerCase();
          const priorityFilter = String(req.query.priority || '').trim().toLowerCase();
          const ticketWhere: any = { isDeleted: false };
          if (roleFilter && roleFilter !== 'all') ticketWhere.role = roleFilter;
          if (statusFilter && statusFilter !== 'All' && statusFilter !== 'all') ticketWhere.status = statusFilter;
          if (targetRoleFilter && targetRoleFilter !== 'all') ticketWhere.targetRole = targetRoleFilter;
          if (priorityFilter && priorityFilter !== 'all') ticketWhere.priority = priorityFilter;
          const { page, limit, skip, isPaginated } = parsePagination(req.query as any, { limit: 200, maxLimit: 500 });
          const [tickets, total] = await Promise.all([
            db.ticket.findMany({ where: ticketWhere, orderBy: { createdAt: 'desc' }, skip, take: limit }),
            db.ticket.count({ where: ticketWhere }),
          ]);
          const enriched = await enrichTicketsWithResolverNames(tickets);
          res.json(paginatedResponse(enriched.map((t) => { try { return toUiTicket(pgTicket(t)); } catch (e) { orderLog.error(`[tickets] toUiTicket failed for ${t.id}`, { error: e }); return null; } }).filter(Boolean) as any[], total, page, limit, isPaginated));
          logTicketAccess(tickets.length);
          return;
        }

        if (roles.includes('shopper')) {
          const shopperWhere = { userId: pgUserId, isDeleted: false };
          const { page, limit, skip, isPaginated } = parsePagination(req.query as any);
          const [tickets, total] = await Promise.all([
            db.ticket.findMany({ where: shopperWhere, orderBy: { createdAt: 'desc' }, skip, take: limit }),
            db.ticket.count({ where: shopperWhere }),
          ]);
          const enriched = await enrichTicketsWithResolverNames(tickets);
          res.json(paginatedResponse(enriched.map((t) => { try { return toUiTicket(pgTicket(t)); } catch (e) { orderLog.error(`[tickets] toUiTicket failed for ${t.id}`, { error: e }); return null; } }).filter(Boolean) as any[], total, page, limit, isPaginated));
          logTicketAccess(tickets.length);
          return;
        }

        // Cascade routing: each role sees tickets created by them + tickets targeted TO their role
        const mediatorCode = String((user as any)?.mediatorCode || '').trim();
        const agencyCode = roles.includes('agency') ? (await resolveAgencyCode(pgUserId, user)) : '';
        const cascadeTargets: any[] = [{ userId: pgUserId }];

        if (roles.includes('mediator') && mediatorCode) {
          // Mediator sees buyer tickets targeted to 'mediator' from their buyers
          const mediatorOrders = await db.order.findMany({
            where: { managerName: mediatorCode, isDeleted: false },
            select: { userId: true },
          });
          const buyerUserIds = [...new Set(mediatorOrders.map(o => o.userId).filter(Boolean))];

          // Also include buyers registered under this mediator via parentCode
          const registeredBuyers = await db.user.findMany({
            where: { parentCode: mediatorCode, roles: { has: 'shopper' as any }, isDeleted: false },
            select: { id: true },
          });
          const registeredBuyerIds = registeredBuyers.map(b => b.id);
          const allBuyerIds = [...new Set([...buyerUserIds, ...registeredBuyerIds])];

          if (allBuyerIds.length) {
            cascadeTargets.push({ targetRole: 'mediator', userId: { in: allBuyerIds } });
          }
        }

        if (roles.includes('agency') && agencyCode) {
          // Agency sees tickets from mediators + buyers in their network at ALL relevant target levels
          const mediatorCodes = await listMediatorCodesForAgency(agencyCode);
          if (mediatorCodes.length) {
            const mediatorUsers = await db.user.findMany({
              where: { mediatorCode: { in: mediatorCodes }, isDeleted: false },
              select: { id: true },
            });
            const mediatorUserIds = mediatorUsers.map(u => u.id);

            const buyerUsers = await db.user.findMany({
              where: { parentCode: { in: mediatorCodes }, isDeleted: false },
              select: { id: true },
            });
            const buyerInMediatorNetwork = buyerUsers.map(b => b.id);

            // All users in this agency's network (mediators + their buyers)
            const allNetworkIds = [...new Set([...mediatorUserIds, ...buyerInMediatorNetwork])];

            if (allNetworkIds.length) {
              // Tickets targeted to agency from ANY user in the network (including escalated buyer tickets)
              cascadeTargets.push({ targetRole: 'agency', userId: { in: allNetworkIds } });
            }
            // Buyer tickets still at mediator level (oversight)
            if (buyerInMediatorNetwork.length) {
              cascadeTargets.push({ targetRole: 'mediator', userId: { in: buyerInMediatorNetwork } });
            }
          }
        }

        if (roles.includes('brand')) {
          // Brand sees tickets from connected agencies + their downstream at ALL relevant target levels
          const brand = await db.brand.findFirst({ where: { ownerUserId: pgUserId, isDeleted: false }, select: { connectedAgencyCodes: true } });
          const connectedCodes = brand?.connectedAgencyCodes ?? [];
          if (connectedCodes.length) {
            // Resolve agency owner user IDs from connected agency codes
            const connectedAgencies = await db.agency.findMany({ where: { agencyCode: { in: connectedCodes }, isDeleted: false }, select: { ownerUserId: true } });
            const agencyOwnerIds = connectedAgencies.map(a => a.ownerUserId).filter(Boolean);

            // Resolve all mediators and buyers under connected agencies
            const allMediatorCodes: string[] = [];
            for (const code of connectedCodes) {
              const mCodes = await listMediatorCodesForAgency(code);
              allMediatorCodes.push(...mCodes);
            }

            let mediatorUserIds: string[] = [];
            let buyerUserIds: string[] = [];
            if (allMediatorCodes.length) {
              const mediatorUsers = await db.user.findMany({
                where: { mediatorCode: { in: allMediatorCodes }, isDeleted: false },
                select: { id: true },
              });
              mediatorUserIds = mediatorUsers.map(u => u.id);

              const buyerUsers = await db.user.findMany({
                where: { parentCode: { in: allMediatorCodes }, isDeleted: false },
                select: { id: true },
              });
              buyerUserIds = buyerUsers.map(b => b.id);
            }

            // ALL users in this brand's connected network
            const allBrandNetworkIds = [...new Set([...agencyOwnerIds, ...mediatorUserIds, ...buyerUserIds])];

            if (allBrandNetworkIds.length) {
              // Tickets targeted to brand from ANY user in the network (including escalated tickets)
              cascadeTargets.push({ targetRole: 'brand', userId: { in: allBrandNetworkIds } });
            }

            // Oversight: tickets at agency level from mediators + buyers
            const agencyLevelIds = [...new Set([...mediatorUserIds, ...buyerUserIds])];
            if (agencyLevelIds.length) {
              cascadeTargets.push({ targetRole: 'agency', userId: { in: agencyLevelIds } });
            }

            // Oversight: tickets at mediator level from buyers
            if (buyerUserIds.length) {
              cascadeTargets.push({ targetRole: 'mediator', userId: { in: buyerUserIds } });
            }
          }
        }

        const orderMongoIds = await getScopedOrderMongoIds({ roles, pgUserId, requesterUser: user });
        if (orderMongoIds.length) {
          cascadeTargets.push({ orderId: { in: orderMongoIds } });
        }
        const ticketWhere = {
            isDeleted: false,
            OR: cascadeTargets,
        };
        const { page, limit, skip, isPaginated } = parsePagination(req.query as any);
        const [tickets, total] = await Promise.all([
          db.ticket.findMany({
            where: ticketWhere,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          db.ticket.count({ where: ticketWhere }),
        ]);

        const enriched = await enrichTicketsWithResolverNames(tickets);

        if (roles.includes('brand')) {
          res.json(paginatedResponse(enriched.map((t) => { try { return toUiTicketForBrand(pgTicket(t)); } catch (e) { orderLog.error(`[tickets] toUiTicketForBrand failed for ${t.id}`, { error: e }); return null; } }).filter(Boolean) as any[], total, page, limit, isPaginated));
          logTicketAccess(tickets.length);
          return;
        }
        res.json(paginatedResponse(enriched.map((t) => { try { return toUiTicket(pgTicket(t)); } catch (e) { orderLog.error(`[tickets] toUiTicket failed for ${t.id}`, { error: e }); return null; } }).filter(Boolean) as any[], total, page, limit, isPaginated));
        logTicketAccess(tickets.length);
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'tickets/listTickets' } });
        next(err);
      }
    },

    createTicket: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = createTicketSchema.parse(req.body);
        const { roles, pgUserId, user } = getRequester(req);
        const userName = String(user?.name || 'User');
        const role = String(user?.role || roles[0] || 'shopper');
        const db = prisma();

        // Server-side issueType validation against role-specific allowed types
        const allowedTypes = ROLE_ISSUE_TYPES[role];
        if (allowedTypes && !allowedTypes.includes(body.issueType)) {
          throw new AppError(400, 'INVALID_ISSUE_TYPE', `Invalid issue type "${body.issueType}" for role ${role}. Allowed: ${allowedTypes.join(', ')}`);
        }

        if (body.orderId) {
          await assertCanReferenceOrder({ orderId: body.orderId, pgUserId, roles, user });
        }

        const mongoId = randomUUID();
        const targetRole = TICKET_TARGET_ROLE[role] || 'admin';
        const ticket = await db.ticket.create({
          data: {
            mongoId,
            userId: pgUserId,
            userName,
            role,
            orderId: body.orderId,
            issueType: body.issueType,
            description: body.description,
            status: 'Open' as any,
            targetRole,
            priority: body.priority || 'medium',
            createdBy: pgUserId,
          },
        });

        const mapped = pgTicket(ticket);
        const audience = await buildTicketAudience(mapped);
        publishRealtime({ type: 'tickets.changed', ts: new Date().toISOString(), payload: { ticketId: String(mapped._id) }, audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        await writeAuditLog({ req, action: 'TICKET_CREATED', entityType: 'Ticket', entityId: String(mapped._id), metadata: { issueType: body.issueType, orderId: body.orderId, actorRole: role } });
        businessLog.info(`[${role.charAt(0).toUpperCase() + role.slice(1)}] User ${req.auth?.userId} created ticket ${String(mapped._id)} — issue: ${body.issueType}, order: ${body.orderId || 'none'}`, { actorUserId: req.auth?.userId, ticketId: String(mapped._id), issueType: body.issueType, orderId: body.orderId, role, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Ticket', entityId: String(mapped._id), action: 'TICKET_CREATED', changedFields: ['status', 'issueType'], before: {}, after: { status: 'Open', issueType: body.issueType } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Ticket', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'TICKET_CREATED', ticketId: String(mapped._id), issueType: body.issueType, orderId: body.orderId, role } });

        res.status(201).json(toUiTicket(mapped));
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'createTicket' } });
        next(err);
      }
    },

    updateTicket: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '');
        if (!id) throw new AppError(400, 'INVALID_TICKET_ID', 'Invalid ticket id');

        const body = updateTicketSchema.parse(req.body);
        const { roles, pgUserId, user } = getRequester(req);
        const db = prisma();

        const existing = await db.ticket.findFirst({ where: { ...idWhere(id), isDeleted: false } });
        if (!existing) throw new AppError(404, 'TICKET_NOT_FOUND', 'Ticket not found');

        const canManage = await canManageTicketByRole({ ticket: existing, roles, pgUserId, user });
        if (!canManage) throw new AppError(403, 'FORBIDDEN', 'Not allowed');

        // Determine the actor's effective role level
        const actorRole = String(user?.role || roles[0] || 'shopper');
        const actorLevel = ROLE_LEVEL[actorRole] ?? 0;
        const targetLevel = ROLE_LEVEL[existing.targetRole || ''] ?? 0;
        const isTicketOwner = existing.userId === pgUserId;

        const previousStatus = String(existing.status || '');
        const updatePayload: any = { status: body.status, updatedBy: pgUserId };

        // For resolve/reject/escalate: actor role must be >= ticket's targetRole level
        // Exception: ticket owner can always resolve/reject their own ticket
        if (body.status === 'Resolved' || body.status === 'Rejected' || body.escalate) {
          if (!isTicketOwner && !isPrivileged(roles) && actorLevel < targetLevel) {
            throw new AppError(403, 'ROLE_LEVEL_INSUFFICIENT', `Only ${existing.targetRole} or higher can ${body.escalate ? 'escalate' : body.status === 'Resolved' ? 'resolve' : 'reject'} this ticket`);
          }
        }

        // For reopening: allow owner OR anyone at/above target level
        if (previousStatus !== 'Open' && body.status === 'Open' && !body.escalate) {
          if (!isTicketOwner && !isPrivileged(roles) && actorLevel < targetLevel) {
            throw new AppError(403, 'ROLE_LEVEL_INSUFFICIENT', 'Only the ticket owner or a higher role can reopen this ticket');
          }
        }

        // Handle escalation: advance targetRole to the next tier
        if (body.escalate && existing.targetRole) {
          const nextRole = ESCALATION_PATH[existing.targetRole];
          if (!nextRole) throw new AppError(400, 'CANNOT_ESCALATE', 'Ticket cannot be escalated further');
          updatePayload.targetRole = nextRole;
          updatePayload.status = 'Open'; // keep open when escalating
        }

        if ((body.status === 'Resolved' || body.status === 'Rejected') && previousStatus === 'Open') {
          updatePayload.resolvedBy = pgUserId;
          updatePayload.resolvedAt = new Date();
          if ((body as any).resolutionNote) updatePayload.resolutionNote = String((body as any).resolutionNote).slice(0, 1000);
        }

        const ticket = await db.ticket.update({ where: { id: existing.id }, data: updatePayload });
        const mapped = pgTicket(ticket);
        const enriched = (await enrichTicketsWithResolverNames([mapped]))[0];

        const audience = await buildTicketAudience(enriched);
        publishRealtime({ type: 'tickets.changed', ts: new Date().toISOString(), payload: { ticketId: String(enriched._id), status: body.status }, audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        // ── Push notification to the ticket creator ──
        // Notify the original ticket creator when their ticket is resolved, rejected, or escalated
        // (but don't notify the person who performed the action on their own ticket).
        if (existing.userId && existing.userId !== pgUserId) {
          const resolverName = String(user?.name || 'Support team');
          const pushTitle = body.escalate ? 'Ticket Escalated'
            : body.status === 'Resolved' ? 'Ticket Resolved \u2705'
            : body.status === 'Rejected' ? 'Ticket Rejected'
            : previousStatus !== 'Open' && body.status === 'Open' ? 'Ticket Reopened'
            : null;
          const pushBody = body.escalate
            ? `Your ticket has been escalated to ${updatePayload.targetRole} for further review.`
            : body.status === 'Resolved'
            ? `${resolverName} resolved your "${existing.issueType}" ticket.${updatePayload.resolutionNote ? ` Note: ${updatePayload.resolutionNote.slice(0, 100)}` : ''}`
            : body.status === 'Rejected'
            ? `Your "${existing.issueType}" ticket was rejected.${updatePayload.resolutionNote ? ` Reason: ${updatePayload.resolutionNote.slice(0, 100)}` : ''}`
            : previousStatus !== 'Open' && body.status === 'Open'
            ? `Your "${existing.issueType}" ticket has been reopened.`
            : null;
          if (pushTitle && pushBody) {
            const ticketCreatorRole = String(existing.role || 'shopper');
            const pushApp = ticketCreatorRole === 'mediator' ? 'mediator' as const
              : ticketCreatorRole === 'agency' ? 'agency' as const
              : ticketCreatorRole === 'brand' ? 'brand' as const
              : 'buyer' as const;
            sendPushToUser({ env, userId: existing.userId, app: pushApp, payload: { title: pushTitle, body: pushBody, url: '/' } })
              .catch(() => { /* push delivery is best-effort */ });
          }
        }

        const auditAction = body.escalate ? 'TICKET_ESCALATED'
          : body.status === 'Resolved' ? 'TICKET_RESOLVED'
          : body.status === 'Rejected' ? 'TICKET_REJECTED'
          : (previousStatus === 'Resolved' || previousStatus === 'Rejected') && body.status === 'Open' ? 'TICKET_REOPENED'
          : 'TICKET_UPDATED';
        await writeAuditLog({ req, action: auditAction, entityType: 'Ticket', entityId: id, metadata: { previousStatus, newStatus: body.status, actorRole: String(user?.role || roles[0] || ''), ...(body.escalate ? { escalatedTo: updatePayload.targetRole } : {}) } });
        businessLog.info(`[${String(user?.role || roles[0] || 'User').charAt(0).toUpperCase() + String(user?.role || roles[0] || 'User').slice(1)}] User ${req.auth?.userId} ${auditAction.toLowerCase().replace('ticket_', '')} ticket ${id} — ${previousStatus} → ${body.status}`, { actorUserId: req.auth?.userId, ticketId: id, previousStatus, newStatus: body.status, ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Ticket', entityId: id, action: 'TICKET_STATUS_CHANGE', changedFields: ['status'], before: { status: previousStatus }, after: { status: body.status } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Ticket', requestId: String((res as any).locals?.requestId || ''), metadata: { action: auditAction, ticketId: id, previousStatus, newStatus: body.status } });

        const uiTicket = roles.includes('brand') ? toUiTicketForBrand(enriched) : toUiTicket(enriched);
        res.json(uiTicket);
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'updateTicket' } });
        next(err);
      }
    },

    deleteTicket: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id || '').trim();
        if (!id) throw new AppError(400, 'INVALID_TICKET_ID', 'Invalid ticket id');

        const { roles, pgUserId, user } = getRequester(req);
        const db = prisma();

        const existing = await db.ticket.findFirst({ where: { ...idWhere(id), isDeleted: false } });
        if (!existing) throw new AppError(404, 'TICKET_NOT_FOUND', 'Ticket not found');

        if (String(existing.status || '').trim() === 'Open') {
          throw new AppError(409, 'TICKET_NOT_CLOSED', 'Ticket must be resolved or rejected before deletion');
        }

        const canManage = await canManageTicketByRole({ ticket: existing, roles, pgUserId, user });
        if (!canManage) throw new AppError(403, 'FORBIDDEN', 'Not allowed');

        await db.ticket.update({ where: { id: existing.id }, data: { isDeleted: true, updatedBy: pgUserId } });

        const mapped = pgTicket(existing);
        const audience = await buildTicketAudience(mapped);
        publishRealtime({ type: 'tickets.changed', ts: new Date().toISOString(), payload: { ticketId: String(mapped._id), deleted: true }, audience });
        publishRealtime({ type: 'notifications.changed', ts: new Date().toISOString(), audience });

        await writeAuditLog({ req, action: 'TICKET_DELETED', entityType: 'Ticket', entityId: id, metadata: { status: String(existing.status) } });
        businessLog.info(`[${String(user?.role || roles[0] || 'User').charAt(0).toUpperCase() + String(user?.role || roles[0] || 'User').slice(1)}] User ${req.auth?.userId} deleted ticket ${id} — was ${String(existing.status)}`, { actorUserId: req.auth?.userId, ticketId: id, previousStatus: String(existing.status), ip: req.ip });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Ticket', entityId: id, action: 'TICKET_DELETED', changedFields: ['isDeleted'], before: { status: String(existing.status) }, after: { deleted: true } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Ticket', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'TICKET_DELETED', ticketId: id, status: String(existing.status) } });

        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'deleteTicket' } });
        next(err);
      }
    },
  };
}
