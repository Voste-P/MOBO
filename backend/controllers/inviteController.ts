import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../database/prisma.js';
import { createInviteSchema, opsGenerateInviteSchema, revokeInviteSchema } from '../validations/invites.js';
import { generateHumanCode } from '../services/codes.js';
import { idWhere } from '../utils/idWhere.js';
import { AppError } from '../middleware/errors.js';
import { writeAuditLog } from '../services/audit.js';
import { revokeInvite } from '../services/invites.js';
import { businessLog } from '../config/logger.js';
import { logChangeEvent, logAccessEvent, logErrorEvent } from '../config/appLogs.js';
import type { Role } from '../middleware/auth.js';
import { publishRealtime } from '../services/realtimeHub.js';
import { pgInvite } from '../utils/pgMappers.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

function db() { return prisma(); }

export function makeInviteController() {
  return {
    adminCreateInvite: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = createInviteSchema.parse(req.body);

        const ttlSeconds = body.ttlSeconds ?? 60 * 60 * 24 * 7;
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        let code = generateHumanCode('INV');
        let invCodeUnique = false;
        for (let i = 0; i < 10; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const exists = await db().invite.findFirst({ where: { code }, select: { id: true } });
          if (!exists) { invCodeUnique = true; break; }
          code = generateHumanCode('INV');
        }
        if (!invCodeUnique) {
          throw new AppError(500, 'CODE_GENERATION_FAILED', 'Unable to generate a unique invite code; please retry');
        }

        // Resolve createdBy: need PG UUID, not mongoId
        let createdByUuid: string | undefined;
        if (req.auth?.userId) {
          const actor = await db().user.findFirst({ where: { ...idWhere(req.auth.userId), isDeleted: false }, select: { id: true } });
          createdByUuid = actor?.id;
        }

        const invite = await db().invite.create({
          data: {
            mongoId: randomUUID(),
            code,
            role: body.role as any,
            label: body.label,
            parentUserId: body.parentUserId ? undefined : undefined,
            parentCode: body.parentCode,
            maxUses: body.maxUses ?? 1,
            expiresAt,
            createdBy: createdByUuid,
          },
        });

        await writeAuditLog({
          req,
          action: 'INVITE_CREATED',
          entityType: 'Invite',
          entityId: invite.mongoId!,
          metadata: { code: invite.code, role: invite.role, parentCode: invite.parentCode, parentUserId: invite.parentUserId },
        });
        businessLog.info('Invite created (admin)', { inviteId: invite.mongoId, code: invite.code, role: invite.role, parentCode: invite.parentCode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Invite', entityId: invite.mongoId!, action: 'INVITE_CREATED', changedFields: ['code', 'role', 'status'], before: {}, after: { code: invite.code, role: invite.role, status: 'active' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Invite', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'INVITE_CREATED', inviteId: invite.mongoId, code: invite.code, role: invite.role } });

        const privilegedRoles: Role[] = ['admin', 'ops'];
        publishRealtime({ type: 'invites.changed', ts: new Date().toISOString(), audience: { roles: privilegedRoles } });
        res.status(201).json({
          code: invite.code,
          role: invite.role,
          label: invite.label,
          status: invite.status,
          expiresAt: invite.expiresAt,
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'adminCreateInvite' } });
        next(err);
      }
    },

    adminRevokeInvite: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = revokeInviteSchema.parse(req.body);
        // Resolve PG UUID for revokedBy (req.auth.userId may be a legacy ID)
        let revokedByUuid: string | undefined;
        if (req.auth?.pgUserId) {
          revokedByUuid = req.auth.pgUserId;
        } else if (req.auth?.userId) {
          const actor = await db().user.findFirst({ where: { ...idWhere(req.auth.userId), isDeleted: false }, select: { id: true } });
          revokedByUuid = actor?.id;
        }
        if (!revokedByUuid) throw new AppError(401, 'UNAUTHENTICATED', 'Missing auth context');

        const invite = await revokeInvite({ code: body.code, revokedByUserId: revokedByUuid, reason: body.reason });

        await writeAuditLog({
          req,
          action: 'INVITE_REVOKED',
          entityType: 'Invite',
          entityId: String(invite._id),
          metadata: { code: invite.code, reason: body.reason },
        });
        businessLog.info('Invite revoked', { inviteId: String(invite._id), code: invite.code, reason: body.reason });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Invite', entityId: String(invite._id), action: 'INVITE_REVOKED', changedFields: ['status'], before: { status: 'active' }, after: { status: 'revoked', reason: body.reason } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Invite', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'INVITE_REVOKED', inviteId: String(invite._id), code: invite.code, reason: body.reason } });

        const privilegedRoles: Role[] = ['admin', 'ops'];
        publishRealtime({ type: 'invites.changed', ts: new Date().toISOString(), audience: { roles: privilegedRoles } });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'adminRevokeInvite' } });
        next(err);
      }
    },

    adminListInvites: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { page, limit, skip, isPaginated } = parsePagination(req.query, { limit: 200, maxLimit: 500 });
        const [invites, total] = await Promise.all([
          db().invite.findMany({ orderBy: { createdAt: 'desc' }, take: limit, skip }),
          db().invite.count(),
        ]);
        res.json(paginatedResponse(invites.map(pgInvite), total, page, limit, isPaginated));

        businessLog.info('Invites listed', { userId: req.auth?.userId, resultCount: invites.length, total, page, limit, ip: req.ip });
        logAccessEvent('RESOURCE_ACCESS', {
          userId: req.auth?.userId,
          roles: req.auth?.roles,
          ip: req.ip,
          resource: 'Invite',
          requestId: String((res as any).locals?.requestId || ''),
          metadata: { action: 'INVITES_LISTED', endpoint: 'adminListInvites', resultCount: invites.length },
        });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'invite/adminListInvites' } });
        next(err);
      }
    },

    adminDeleteInvite: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const code = String(req.params.code || '').trim();
        if (!code) throw new AppError(400, 'INVALID_INVITE_CODE', 'Invite code required');

        const invite = await db().invite.findFirst({ where: { code } });
        if (!invite) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');

        if (invite.status !== 'active') {
          throw new AppError(409, 'INVITE_NOT_ACTIVE', 'Invite is not active');
        }

        const useCount = Number(invite.useCount ?? 0);
        const usesArr = Array.isArray(invite.uses) ? invite.uses : [];
        if (useCount > 0 || usesArr.length > 0 || invite.usedBy) {
          throw new AppError(409, 'INVITE_ALREADY_USED', 'Cannot delete an invite that has been used');
        }

        // Soft-delete: revoke + mark deleted (avoids needing DELETE permission on the table)
        await db().invite.update({
          where: { id: invite.id },
          data: { status: 'revoked' as any, revokedAt: new Date(), revokedBy: (req.auth as any)?.pgUserId || undefined },
        });

        await writeAuditLog({
          req,
          action: 'INVITE_DELETED',
          entityType: 'Invite',
          entityId: invite.mongoId!,
          metadata: { code: invite.code, role: invite.role, parentCode: invite.parentCode, parentUserId: invite.parentUserId },
        });
        businessLog.info('Invite deleted (soft)', { inviteId: invite.mongoId, code: invite.code, role: invite.role });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Invite', entityId: invite.mongoId!, action: 'INVITE_DELETED', changedFields: ['status'], before: { status: 'active' }, after: { status: 'revoked' } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Invite', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'INVITE_DELETED', inviteId: invite.mongoId, code: invite.code } });

        const privilegedRoles: Role[] = ['admin', 'ops'];
        publishRealtime({ type: 'invites.changed', ts: new Date().toISOString(), audience: { roles: privilegedRoles } });
        res.json({ ok: true });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'adminDeleteInvite' } });
        next(err);
      }
    },

    opsGenerateMediatorInvite: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = opsGenerateInviteSchema.parse(req.body);

        const requesterId = req.auth?.userId;
        if (!requesterId) throw new AppError(401, 'UNAUTHENTICATED', 'Missing auth context');

        const requester = await db().user.findFirst({ where: { ...idWhere(requesterId), isDeleted: false } });
        if (!requester) throw new AppError(401, 'UNAUTHENTICATED', 'User not found');

        // Allow agencies to generate mediator invites for themselves. Admin/Ops can generate for any agency.
        const isAgencySelf =
          (requester.roles as string[])?.includes('agency') && (requester.id === body.agencyId || requester.mongoId === body.agencyId);
        const isPrivileged = (requester.roles as string[])?.includes('admin') || (requester.roles as string[])?.includes('ops');
        if (!isAgencySelf && !isPrivileged) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot generate invites for this agency');
        }

        const agency = await db().user.findFirst({ where: { ...idWhere(body.agencyId), isDeleted: false } });
        if (!agency || !(agency.roles as string[])?.includes('agency')) {
          throw new AppError(404, 'AGENCY_NOT_FOUND', 'Agency not found');
        }

        // Ensure agency has a stable code.
        if (!agency.mediatorCode) {
          const newCode = generateHumanCode('AGY');
          await db().user.update({ where: { id: agency.id }, data: { mediatorCode: newCode } });
          agency.mediatorCode = newCode;
        }

        let code = generateHumanCode('INV');
        let medInvCodeUnique = false;
        for (let i = 0; i < 10; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const exists = await db().invite.findFirst({ where: { code }, select: { id: true } });
          if (!exists) { medInvCodeUnique = true; break; }
          code = generateHumanCode('INV');
        }
        if (!medInvCodeUnique) {
          throw new AppError(500, 'CODE_GENERATION_FAILED', 'Unable to generate a unique invite code; please retry');
        }

        const invite = await db().invite.create({
          data: {
            mongoId: randomUUID(),
            code,
            role: 'mediator' as any,
            parentUserId: agency.id,
            parentCode: agency.mediatorCode,
            createdBy: requester.id,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
          },
        });

        await writeAuditLog({
          req,
          action: 'INVITE_CREATED',
          entityType: 'Invite',
          entityId: invite.mongoId!,
          metadata: { code: invite.code, role: invite.role, parentCode: invite.parentCode, parentUserId: invite.parentUserId },
        });
        businessLog.info('Mediator invite generated', { inviteId: invite.mongoId, code: invite.code, agencyCode: agency.mediatorCode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Invite', entityId: invite.mongoId!, action: 'MEDIATOR_INVITE_CREATED', changedFields: ['code', 'role'], before: {}, after: { code: invite.code, role: 'mediator', parentCode: agency.mediatorCode } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Invite', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'MEDIATOR_INVITE_CREATED', inviteId: invite.mongoId, code: invite.code, agencyCode: agency.mediatorCode } });

        const privilegedRoles: Role[] = ['admin', 'ops'];
        publishRealtime({ type: 'invites.changed', ts: new Date().toISOString(), audience: { roles: privilegedRoles } });
        res.status(201).json({ code: invite.code });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'opsGenerateMediatorInvite' } });
        next(err);
      }
    },

    opsGenerateBuyerInvite: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const mediatorId = String((req.body?.mediatorId ?? '') as any).trim();
        if (!mediatorId) throw new AppError(400, 'INVALID_MEDIATOR_ID', 'mediatorId required');

        const requesterId = req.auth?.userId;
        if (!requesterId) throw new AppError(401, 'UNAUTHENTICATED', 'Missing auth context');

        const requester = await db().user.findFirst({ where: { ...idWhere(requesterId), isDeleted: false } });
        if (!requester) throw new AppError(401, 'UNAUTHENTICATED', 'User not found');

        const isMediatorSelf = (requester.roles as string[])?.includes('mediator') && requester.mongoId === mediatorId;
        const isPrivileged = (requester.roles as string[])?.includes('admin') || (requester.roles as string[])?.includes('ops');
        if (!isMediatorSelf && !isPrivileged) {
          throw new AppError(403, 'FORBIDDEN', 'Cannot generate buyer invites for this mediator');
        }

        const mediator = await db().user.findFirst({ where: { ...idWhere(mediatorId), isDeleted: false } });
        if (!mediator || !(mediator.roles as string[])?.includes('mediator')) {
          throw new AppError(404, 'MEDIATOR_NOT_FOUND', 'Mediator not found');
        }
        if (!mediator.mediatorCode) {
          throw new AppError(409, 'MISSING_MEDIATOR_CODE', 'This mediator account is not fully set up. Please contact support.');
        }

        let code = generateHumanCode('INV');
        let shopInvCodeUnique = false;
        for (let i = 0; i < 10; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const exists = await db().invite.findFirst({ where: { code }, select: { id: true } });
          if (!exists) { shopInvCodeUnique = true; break; }
          code = generateHumanCode('INV');
        }
        if (!shopInvCodeUnique) {
          throw new AppError(500, 'CODE_GENERATION_FAILED', 'Unable to generate a unique invite code; please retry');
        }

        const invite = await db().invite.create({
          data: {
            mongoId: randomUUID(),
            code,
            role: 'shopper' as any,
            parentUserId: mediator.id,
            parentCode: mediator.mediatorCode,
            createdBy: requester.id,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
          },
        });

        await writeAuditLog({
          req,
          action: 'INVITE_CREATED',
          entityType: 'Invite',
          entityId: invite.mongoId!,
          metadata: { code: invite.code, role: invite.role, parentCode: invite.parentCode, parentUserId: invite.parentUserId },
        });
        businessLog.info('Buyer invite generated', { inviteId: invite.mongoId, code: invite.code, mediatorCode: mediator.mediatorCode });
        logChangeEvent({ actorUserId: req.auth?.userId, entityType: 'Invite', entityId: invite.mongoId!, action: 'BUYER_INVITE_CREATED', changedFields: ['code', 'role'], before: {}, after: { code: invite.code, role: 'shopper', parentCode: mediator.mediatorCode } });
        logAccessEvent('RESOURCE_ACCESS', { userId: req.auth?.userId, roles: req.auth?.roles, ip: req.ip, resource: 'Invite', requestId: String((res as any).locals?.requestId || ''), metadata: { action: 'BUYER_INVITE_CREATED', inviteId: invite.mongoId, code: invite.code, mediatorCode: mediator.mediatorCode } });

        const privilegedRoles: Role[] = ['admin', 'ops'];
        publishRealtime({ type: 'invites.changed', ts: new Date().toISOString(), audience: { roles: privilegedRoles } });
        res.status(201).json({ code: invite.code });
      } catch (err) {
        logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'BUSINESS_LOGIC', severity: 'medium', userId: req.auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'opsGenerateBuyerInvite' } });
        next(err);
      }
    },
  };
}
