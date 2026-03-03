import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Env } from '../config/env.js';
import { AppError } from './errors.js';
import { prisma } from '../database/prisma.js';
import { idWhere } from '../utils/idWhere.js';
import { authCacheGet, authCacheSet } from '../utils/authCache.js';
import { logAuthEvent, logSecurityIncident, logAccessEvent } from '../config/appLogs.js';

export type Role = 'shopper' | 'mediator' | 'agency' | 'brand' | 'admin' | 'ops';

export type AuthUser = {
  _id: string;
  status: string;
  roles: string[];
  role: string;
  parentCode?: string | null;
  mediatorCode?: string | null;
  brandCode?: string | null;
  isDeleted?: boolean;
  mobile: string;
  name: string;
};

export type AuthContext = {
  userId: string;
  /** PG UUID – use for foreign-key references in Prisma queries. */
  pgUserId: string;
  roles: Role[];
  user?: AuthUser;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Schema-validate the JWT payload to prevent malformed-but-signed tokens from causing issues. */
function validateJwtPayload(decoded: unknown): { sub: string; role?: string } {
  if (!decoded || typeof decoded !== 'object') throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token payload');
  const payload = decoded as Record<string, unknown>;
  const sub = typeof payload.sub === 'string' ? payload.sub : typeof payload.sub === 'number' ? String(payload.sub) : '';
  if (!sub) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token: missing subject');
  const role = typeof payload.role === 'string' ? payload.role : undefined;
  return { sub, role };
}

async function resolveAuthFromToken(token: string, env: Env): Promise<AuthContext> {
  const raw = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
  const { sub: userId } = validateJwtPayload(raw);

  if (!userId) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token');
  }

  // Check auth cache — avoids 1-4 DB queries for repeat requests within TTL
  const cached = authCacheGet(userId);
  if (cached) return cached;

  const db = prisma();

  // Zero-trust: do not trust roles/status embedded in the JWT.
  // Fetch from DB so suspensions and role changes take effect immediately.
  const user = await db.user.findFirst({
    where: { ...idWhere(userId), isDeleted: false },
    select: {
      id: true, mongoId: true, status: true, roles: true, role: true,
      parentCode: true, mediatorCode: true, brandCode: true,
      isDeleted: true, mobile: true, name: true,
    },
  });

  if (!user || user.isDeleted) {
    logAuthEvent('SESSION_EXPIRED', {
      userId,
      reason: 'User not found or deleted',
    });
    throw new AppError(401, 'UNAUTHENTICATED', 'User not found');
  }

  if (user.status !== 'active') {
    logAuthEvent('SESSION_EXPIRED', {
      userId,
      reason: `User status: ${user.status}`,
    });
    throw new AppError(403, 'USER_NOT_ACTIVE', 'User is not active');
  }

  const roles = Array.isArray(user.roles) ? (user.roles as Role[]) : [];

  // Upstream suspension enforcement (non-negotiable):
  // - Buyer loses access immediately when their mediator or agency is suspended.
  // - Mediator loses access immediately when their agency is suspended.
  const parentCode = String(user.parentCode || '').trim();

  if (roles.includes('mediator')) {
    if (parentCode) {
      const agency = await db.user.findFirst({
        where: {
          mediatorCode: parentCode,
          roles: { has: 'agency' as any },
          isDeleted: false,
        },
        select: { status: true },
      });
      if (!agency || agency.status !== 'active') {
        logAccessEvent('RESOURCE_DENIED', {
          userId,
          roles: roles as string[],
          resource: 'upstream-agency',
          metadata: { reason: 'Upstream agency suspended', parentCode },
        });
        throw new AppError(403, 'UPSTREAM_SUSPENDED', 'Upstream agency is not active');
      }
    }
  }

  if (roles.includes('shopper')) {
    if (parentCode) {
      const mediator = await db.user.findFirst({
        where: {
          mediatorCode: parentCode,
          roles: { has: 'mediator' as any },
          isDeleted: false,
        },
        select: { status: true, parentCode: true },
      });
      if (!mediator || mediator.status !== 'active') {
        logAccessEvent('RESOURCE_DENIED', {
          userId,
          roles: roles as string[],
          resource: 'upstream-mediator',
          metadata: { reason: 'Upstream mediator suspended', parentCode },
        });
        throw new AppError(403, 'UPSTREAM_SUSPENDED', 'Upstream mediator is not active');
      }

      const agencyCode = String(mediator.parentCode || '').trim();
      if (agencyCode) {
        const agency = await db.user.findFirst({
          where: {
            mediatorCode: agencyCode,
            roles: { has: 'agency' as any },
            isDeleted: false,
          },
          select: { status: true },
        });
        if (!agency || agency.status !== 'active') {
          logAccessEvent('RESOURCE_DENIED', {
            userId,
            roles: roles as string[],
            resource: 'upstream-agency-of-mediator',
            metadata: { reason: 'Upstream agency suspended (via mediator)', parentCode, agencyCode },
          });
          throw new AppError(403, 'UPSTREAM_SUSPENDED', 'Upstream agency is not active');
        }
      }
    }
  }

  const authUser: AuthUser = {
    _id: user.id,
    status: user.status,
    roles: user.roles as string[],
    role: user.role as string,
    parentCode: user.parentCode,
    mediatorCode: user.mediatorCode,
    brandCode: user.brandCode,
    isDeleted: user.isDeleted,
    mobile: user.mobile,
    name: user.name,
  };

  const result: AuthContext = { userId, pgUserId: user.id, roles, user: authUser };
  authCacheSet(userId, result);
  return result;
}

export function requireAuth(env: Env) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') || '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

    if (!token) {
      return next(new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
    }

    try {
      req.auth = await resolveAuthFromToken(token, env);
      next();
    } catch (err) {
      if (!(err instanceof AppError)) {
        logSecurityIncident('INVALID_TOKEN', {
          severity: 'low',
          ip: req.ip,
          route: req.originalUrl,
          method: req.method,
          requestId: String((_res as any).locals?.requestId || ''),
          userAgent: req.get('user-agent'),
        });
      }
      next(err instanceof AppError ? err : new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token'));
    }
  };
}

/**
 * @deprecated Currently identical to requireAuth. Intended to support API-key or
 * link-token auth for proof viewing. Replace usages with requireAuth or implement
 * the alternative mechanism when needed.
 */
export function requireAuthOrToken(env: Env) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') || '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

    if (!token) {
      return next(new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
    }

    try {
      req.auth = await resolveAuthFromToken(token, env);
      next();
    } catch (err) {
      next(err instanceof AppError ? err : new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token'));
    }
  };
}

// Like requireAuth(), but does not require a token.
// - If token is missing: continues unauthenticated.
// - If token is present and invalid: returns 401.
// - If token is valid: attaches req.auth (zero-trust roles from DB).
export function optionalAuth(env: Env) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') || '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

    if (!token) {
      return next();
    }

    try {
      req.auth = await resolveAuthFromToken(token, env);
      next();
    } catch (err) {
      next(err instanceof AppError ? err : new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token'));
    }
  };
}

export function requireRoles(...required: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const roles = req.auth?.roles || [];
    const ok = required.some((r) => roles.includes(r));
    if (!ok) {
      logAccessEvent('RESOURCE_DENIED', {
        userId: req.auth?.userId,
        roles: roles as string[],
        ip: req.ip,
        method: req.method,
        route: req.originalUrl,
        resource: req.originalUrl,
        requestId: String((_res as any).locals?.requestId || ''),
        metadata: { requiredRoles: required, actualRoles: roles },
      });
      return next(new AppError(403, 'FORBIDDEN', 'Insufficient role'));
    }
    next();
  };
}
