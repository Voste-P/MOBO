import type { Request } from 'express';
import { prisma, isPrismaAvailable } from '../database/prisma.js';
import logger from '../config/logger.js';
import { logErrorEvent } from '../config/appLogs.js';

export type AuditParams = {
  req?: Request;
  actorUserId?: string;
  actorRoles?: string[];
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: any;
};

export async function writeAuditLog(params: AuditParams): Promise<void> {
  try {
    const pgActorUserId = (params.req?.auth as any)?.pgUserId;
    const actorRoles = params.actorRoles ?? params.req?.auth?.roles;

    if (isPrismaAvailable()) {
      const db = prisma();
      await db.auditLog.create({
        data: {
          actorUserId: pgActorUserId || params.actorUserId || undefined,
          actorRoles: Array.isArray(actorRoles) ? (actorRoles as string[]) : [],
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId,
          ip: params.req?.ip,
          userAgent: params.req?.header('user-agent') || undefined,
          metadata: params.metadata ?? undefined,
        },
      });
    }
  } catch (err) {
    // Audit logs must never break business flows, but we log failures
    // so security-relevant events are not silently lost.
    logger.error('[audit] Failed to write audit log', { action: params.action, entityType: params.entityType, entityId: params.entityId, error: err });
    logErrorEvent({ category: 'DATABASE', severity: 'high', message: 'Audit log write failed', operation: 'writeAuditLog', error: err, metadata: { action: params.action, entityType: params.entityType, entityId: params.entityId } });
  }
}
