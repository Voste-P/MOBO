// All queries use Prisma (PG-only).
import { prisma } from '../database/prisma.js';
import { AppError } from '../middleware/errors.js';

// UUID v4 regex — 8-4-4-4-12 hex with dashes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureActiveUserByMongoId(idOrUuid: string) {
  const db = prisma();
  // If the value looks like a UUID, look up by PG id; otherwise by mongoId.
  const where = UUID_RE.test(idOrUuid)
    ? { id: idOrUuid, isDeleted: false }
    : { mongoId: idOrUuid, isDeleted: false };
  const user = await db.user.findFirst({ where: where as any });
  if (!user) throw new AppError(400, 'INVITE_ISSUER_NOT_FOUND', 'Invite issuer not found');
  if (user.status !== 'active') {
    throw new AppError(400, 'INVITE_ISSUER_NOT_ACTIVE', 'Invite issuer is not active');
  }
  return user;
}

async function ensureActiveUserByCode(params: { code: string; role: string }) {
  const db = prisma();
  const user = await db.user.findFirst({
    where: {
      mediatorCode: params.code,
      roles: { has: params.role as any },
      status: 'active',
      isDeleted: false,
    },
  });
  if (!user) throw new AppError(400, 'INVITE_UPSTREAM_NOT_ACTIVE', 'Invite upstream is not active');
  return user;
}

async function enforceInviteIssuerAndUpstreamActive(invite: any) {
  if (invite.createdBy) {
    await ensureActiveUserByMongoId(invite.createdBy);
  }

  if (invite.parentUserId) {
    const parent = await ensureActiveUserByMongoId(invite.parentUserId);

    if (invite.role === 'shopper') {
      if (!parent.roles?.includes('mediator' as any) || !parent.mediatorCode) {
        throw new AppError(400, 'INVITE_PARENT_NOT_ACTIVE', 'Invite parent is not valid');
      }
      const agencyCode = String(parent.parentCode || '').trim();
      if (!agencyCode) {
        throw new AppError(400, 'INVITE_UPSTREAM_NOT_ACTIVE', 'Invite upstream is not valid');
      }
      await ensureActiveUserByCode({ code: agencyCode, role: 'agency' });
    }

    if (invite.role === 'mediator') {
      if (!parent.roles?.includes('agency' as any) || !parent.mediatorCode) {
        throw new AppError(400, 'INVITE_PARENT_NOT_ACTIVE', 'Invite parent is not valid');
      }
    }
  }
}

export async function consumeInvite(params: {
  code: string;
  role: string;
  usedByUserId: string;
  session?: any; // kept for API compat, unused in PG path
  tx?: any; // Prisma transaction client
  requireActiveIssuer?: boolean;
}): Promise<any> {
  const now = new Date();
  const db = params.tx ?? prisma();

  const invite = await db.invite.findFirst({ where: { code: params.code } });
  if (!invite) {
    throw new AppError(400, 'INVALID_INVITE', 'Invalid or inactive invite code');
  }
  if (String(invite.role) !== String(params.role)) {
    throw new AppError(400, 'INVITE_ROLE_MISMATCH', 'Invite role mismatch');
  }
  if (invite.status !== 'active') {
    throw new AppError(400, 'INVALID_INVITE', 'Invalid or inactive invite code');
  }
  if (invite.expiresAt) {
    if (invite.expiresAt.getTime() <= now.getTime()) {
      // Mark expired outside any wrapping transaction so the status change persists.
      await prisma().invite.update({ where: { id: invite.id }, data: { status: 'expired' } });
      throw new AppError(400, 'INVITE_EXPIRED', 'Invite has expired');
    }
  }
  if ((invite.useCount ?? 0) >= (invite.maxUses ?? 1)) {
    throw new AppError(400, 'INVALID_INVITE', 'Invalid or inactive invite code');
  }

  if (params.requireActiveIssuer !== false) {
    await enforceInviteIssuerAndUpstreamActive(invite);
  }

  // Atomic consume: use updateMany with conditions to prevent races
  const newUseCount = (invite.useCount ?? 0) + 1;
  const newStatus = newUseCount >= (invite.maxUses ?? 1) ? 'used' : 'active';
  const existingUses = Array.isArray(invite.uses) ? (invite.uses as any[]) : [];

  const updated = await db.invite.updateMany({
    where: {
      code: params.code,
      status: 'active',
      useCount: { lt: invite.maxUses ?? 1 },
      ...(invite.expiresAt ? { expiresAt: { gt: now } } : {}),
    },
    data: {
      useCount: newUseCount,
      usedBy: params.usedByUserId,
      usedAt: now,
      uses: [...existingUses, { usedBy: params.usedByUserId, usedAt: now.toISOString() }],
      status: newStatus,
    },
  });

  if (updated.count === 0) {
    throw new AppError(400, 'INVALID_INVITE', 'Invalid or inactive invite code');
  }

  // Re-fetch updated invite
  const result = await db.invite.findFirst({ where: { code: params.code } });
  if (!result) throw new AppError(400, 'INVALID_INVITE', 'Invalid or inactive invite code');

  // Return with _id = mongoId for backward compat
  return { ...result, _id: result.mongoId };
}

export async function revokeInvite(params: { code: string; revokedByUserId: string; reason?: string }) {
  const db = prisma();
  const invite = await db.invite.findFirst({ where: { code: params.code } });
  if (!invite) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
  if (invite.status !== 'active') throw new AppError(409, 'INVITE_NOT_ACTIVE', 'Invite is not active');

  const updated = await db.invite.update({
    where: { id: invite.id },
    data: {
      status: 'revoked',
      revokedBy: params.revokedByUserId,
      revokedAt: new Date(),
    },
  });

  return { ...updated, _id: updated.mongoId };
}
