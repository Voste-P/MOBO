import { AppError } from '../middleware/errors.js';
import { prisma } from '../database/prisma.js';
import { isPrismaAvailable } from '../database/prisma.js';

type AnyUser = any;

// UUID v4 regex — 8-4-4-4-12 hex with dashes.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ensureRoleDocumentsForUser(args: { user: AnyUser; session?: any; tx?: any }) {
  // When Prisma/PG is not connected (e.g. test environments without DATABASE_URL), skip silently.
  if (!args.tx && !isPrismaAvailable()) return;

  const user = args.user;
  const roles: string[] = Array.isArray(user?.roles) ? user.roles : [];
  const name = String(user?.name ?? '').trim() || 'User';
  const db = args.tx ?? prisma();

  // Resolve the PG UUID for this user.
  // user.id should be a UUID (from Prisma).
  const pgUserId = String(user?.id ?? '');
  if (pgUserId && !UUID_RE.test(pgUserId)) {
    // Non-UUID id — cannot resolve. Skip silently.
    return;
  }
  if (!pgUserId) throw new AppError(500, 'MISSING_USER_ID', 'Cannot ensure role documents: user is missing id');

  const createdBy = user?.createdBy ? String(user.createdBy) : undefined;
  // Also resolve createdBy if it's a legacy hex ID.
  let resolvedCreatedBy = createdBy;
  if (resolvedCreatedBy && !UUID_RE.test(resolvedCreatedBy)) {
    const pgCreator = await db.user.findFirst({ where: { id: resolvedCreatedBy, isDeleted: false }, select: { id: true } });
    resolvedCreatedBy = pgCreator?.id ?? undefined;
  }

  if (roles.includes('agency')) {
    const agencyCode = String(user?.mediatorCode ?? '').trim();
    if (!agencyCode) throw new AppError(409, 'MISSING_AGENCY_CODE', 'Agency user is missing a code');

    await db.agency.upsert({
      where: { agencyCode },
      update: {
        name,
        ownerUserId: pgUserId,
        status: String(user?.status ?? 'active'),
      },
      create: {
        agencyCode,
        name,
        ownerUserId: pgUserId,
        status: String(user?.status ?? 'active'),
        createdBy: resolvedCreatedBy,
      },
    });
  }

  if (roles.includes('brand')) {
    const brandCode = String(user?.brandCode ?? '').trim();
    if (!brandCode) throw new AppError(409, 'MISSING_BRAND_CODE', 'Brand user is missing a brandCode');

    const connectedAgencyCodes = Array.isArray(user?.connectedAgencies)
      ? user.connectedAgencies.map((c: unknown) => String(c ?? '').trim()).filter(Boolean)
      : [];

    await db.brand.upsert({
      where: { brandCode },
      update: {
        name,
        ownerUserId: pgUserId,
        status: String(user?.status ?? 'active'),
        connectedAgencyCodes,
      },
      create: {
        brandCode,
        name,
        ownerUserId: pgUserId,
        status: String(user?.status ?? 'active'),
        connectedAgencyCodes,
        createdBy: resolvedCreatedBy,
      },
    });
  }

  if (roles.includes('mediator')) {
    const mediatorCode = String(user?.mediatorCode ?? '').trim();
    if (!mediatorCode) throw new AppError(409, 'MISSING_MEDIATOR_CODE', 'Mediator user is missing a code');

    await db.mediatorProfile.upsert({
      where: { mediatorCode },
      update: {
        userId: pgUserId,
        parentAgencyCode: String(user?.parentCode ?? '').trim() || null,
        status: String(user?.status ?? 'active'),
      },
      create: {
        userId: pgUserId,
        mediatorCode,
        parentAgencyCode: String(user?.parentCode ?? '').trim() || null,
        status: String(user?.status ?? 'active'),
        createdBy: resolvedCreatedBy,
      },
    });
  }

  if (roles.includes('shopper')) {
    // Use a composite unique lookup via userId for shopper profiles
    const existing = await db.shopperProfile.findFirst({ where: { userId: pgUserId } });
    if (existing) {
      await db.shopperProfile.update({
        where: { id: existing.id },
        data: {
          defaultMediatorCode: String(user?.parentCode ?? '').trim() || null,
        },
      });
    } else {
      await db.shopperProfile.create({
        data: {
          userId: pgUserId,
          defaultMediatorCode: String(user?.parentCode ?? '').trim() || null,
          createdBy: resolvedCreatedBy,
        },
      });
    }
  }
}
