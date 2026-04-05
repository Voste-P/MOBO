// E2E seeding — PG-only via Prisma.
// NO deleteMany, NO truncate, NO wipe — safe upserts only.
import { randomUUID } from 'node:crypto';

import { hashPassword } from '../services/passwords.js';
import { ensureRoleDocumentsForUser } from '../services/roleDocuments.js';
import { connectPrisma, prisma } from '../database/prisma.js';

export const E2E_ACCOUNTS = {
  admin: {
    name: 'E2E Admin',
    username: 'root',
    password: 'ChangeMe_123!',
    mobile: '9000000000',
  },
  agency: {
    name: 'E2E Agency',
    password: 'ChangeMe_123!',
    mobile: '9000000001',
    agencyCode: 'AG_TEST',
  },
  mediator: {
    name: 'E2E Mediator',
    password: 'ChangeMe_123!',
    mobile: '9000000002',
    mediatorCode: 'MED_TEST',
  },
  brand: {
    name: 'E2E Brand',
    password: 'ChangeMe_123!',
    mobile: '9000000003',
    brandCode: 'BRD_TEST',
  },
  shopper: {
    name: 'E2E Shopper',
    password: 'ChangeMe_123!',
    mobile: '9000000004',
  },
  shopper2: {
    name: 'E2E Shopper 2',
    password: 'ChangeMe_123!',
    mobile: '9000000005',
  },
} as const;

export type SeededE2E = {
  admin: any;
  agency: any;
  mediator: any;
  brand: any;
  shopper: any;
  shopper2: any;
};

/**
 * Ensures E2E test accounts exist via safe upserts.
 * NEVER deletes any data. All operations are create-or-update only.
 */
export async function seedE2E(): Promise<SeededE2E> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedE2E() is disabled in production');
  }
  await connectPrisma();
  const db = prisma();

  const adminPasswordHash = await hashPassword(E2E_ACCOUNTS.admin.password);
  const admin = await db.user.upsert({
    where: { mobile: E2E_ACCOUNTS.admin.mobile },
    create: {
      name: E2E_ACCOUNTS.admin.name,
      mobile: E2E_ACCOUNTS.admin.mobile,
      username: E2E_ACCOUNTS.admin.username,
      passwordHash: adminPasswordHash,
      role: 'admin' as any,
      roles: ['admin', 'ops'] as any,
      status: 'active' as any,
    },
    update: {
      name: E2E_ACCOUNTS.admin.name,
      username: E2E_ACCOUNTS.admin.username,
      passwordHash: adminPasswordHash,
      role: 'admin' as any,
      roles: ['admin', 'ops'] as any,
      status: 'active' as any,
    },
  });

  const agencyPasswordHash = await hashPassword(E2E_ACCOUNTS.agency.password);
  const agency = await db.user.upsert({
    where: { mobile: E2E_ACCOUNTS.agency.mobile },
    create: {
      name: E2E_ACCOUNTS.agency.name,
      mobile: E2E_ACCOUNTS.agency.mobile,
      passwordHash: agencyPasswordHash,
      role: 'agency' as any,
      roles: ['agency'] as any,
      status: 'active' as any,
      mediatorCode: E2E_ACCOUNTS.agency.agencyCode,
      createdBy: admin.id,
    },
    update: {
      name: E2E_ACCOUNTS.agency.name,
      passwordHash: agencyPasswordHash,
      role: 'agency' as any,
      roles: ['agency'] as any,
      status: 'active' as any,
      mediatorCode: E2E_ACCOUNTS.agency.agencyCode,
    },
  });

  const mediatorPasswordHash = await hashPassword(E2E_ACCOUNTS.mediator.password);
  const mediator = await db.user.upsert({
    where: { mobile: E2E_ACCOUNTS.mediator.mobile },
    create: {
      name: E2E_ACCOUNTS.mediator.name,
      mobile: E2E_ACCOUNTS.mediator.mobile,
      passwordHash: mediatorPasswordHash,
      role: 'mediator' as any,
      roles: ['mediator'] as any,
      status: 'active' as any,
      mediatorCode: E2E_ACCOUNTS.mediator.mediatorCode,
      parentCode: E2E_ACCOUNTS.agency.agencyCode,
      createdBy: admin.id,
    },
    update: {
      name: E2E_ACCOUNTS.mediator.name,
      passwordHash: mediatorPasswordHash,
      role: 'mediator' as any,
      roles: ['mediator'] as any,
      status: 'active' as any,
      mediatorCode: E2E_ACCOUNTS.mediator.mediatorCode,
      parentCode: E2E_ACCOUNTS.agency.agencyCode,
    },
  });

  const brandPasswordHash = await hashPassword(E2E_ACCOUNTS.brand.password);
  const brand = await db.user.upsert({
    where: { mobile: E2E_ACCOUNTS.brand.mobile },
    create: {
      name: E2E_ACCOUNTS.brand.name,
      mobile: E2E_ACCOUNTS.brand.mobile,
      passwordHash: brandPasswordHash,
      role: 'brand' as any,
      roles: ['brand'] as any,
      status: 'active' as any,
      brandCode: E2E_ACCOUNTS.brand.brandCode,
      createdBy: admin.id,
    },
    update: {
      name: E2E_ACCOUNTS.brand.name,
      passwordHash: brandPasswordHash,
      role: 'brand' as any,
      roles: ['brand'] as any,
      status: 'active' as any,
      brandCode: E2E_ACCOUNTS.brand.brandCode,
    },
  });

  const shopperPasswordHash = await hashPassword(E2E_ACCOUNTS.shopper.password);
  const shopper = await db.user.upsert({
    where: { mobile: E2E_ACCOUNTS.shopper.mobile },
    create: {
      name: E2E_ACCOUNTS.shopper.name,
      mobile: E2E_ACCOUNTS.shopper.mobile,
      passwordHash: shopperPasswordHash,
      role: 'shopper' as any,
      roles: ['shopper'] as any,
      status: 'active' as any,
      isVerifiedByMediator: true,
      parentCode: E2E_ACCOUNTS.mediator.mediatorCode,
      createdBy: admin.id,
    },
    update: {
      name: E2E_ACCOUNTS.shopper.name,
      passwordHash: shopperPasswordHash,
      role: 'shopper' as any,
      roles: ['shopper'] as any,
      status: 'active' as any,
      isVerifiedByMediator: true,
      parentCode: E2E_ACCOUNTS.mediator.mediatorCode,
    },
  });

  const shopper2PasswordHash = await hashPassword(E2E_ACCOUNTS.shopper2.password);
  const shopper2 = await db.user.upsert({
    where: { mobile: E2E_ACCOUNTS.shopper2.mobile },
    create: {
      name: E2E_ACCOUNTS.shopper2.name,
      mobile: E2E_ACCOUNTS.shopper2.mobile,
      passwordHash: shopper2PasswordHash,
      role: 'shopper' as any,
      roles: ['shopper'] as any,
      status: 'active' as any,
      isVerifiedByMediator: true,
      parentCode: E2E_ACCOUNTS.mediator.mediatorCode,
      createdBy: admin.id,
    },
    update: {
      name: E2E_ACCOUNTS.shopper2.name,
      passwordHash: shopper2PasswordHash,
      role: 'shopper' as any,
      roles: ['shopper'] as any,
      status: 'active' as any,
      isVerifiedByMediator: true,
      parentCode: E2E_ACCOUNTS.mediator.mediatorCode,
    },
  });

  await ensureRoleDocumentsForUser({ user: agency });
  await ensureRoleDocumentsForUser({ user: mediator });
  await ensureRoleDocumentsForUser({ user: brand });
  await ensureRoleDocumentsForUser({ user: shopper });
  await ensureRoleDocumentsForUser({ user: shopper2 });

  // Wallet: ensure brand has a wallet (upsert, no balance reset)
  await db.wallet.upsert({
    where: { ownerUserId: brand.id },
    create: {
      ownerUserId: brand.id,
      currency: 'INR' as any,
      availablePaise: 50_000_00,
      pendingPaise: 0,
      lockedPaise: 0,
      version: 0,
      createdBy: admin.id,
    },
    update: { availablePaise: 50_000_00, pendingPaise: 0, lockedPaise: 0 },  // Reset balance for test runs
  });

  // Campaign: find existing or create — never duplicate, never delete
  // Search by title only (not brandUserId) to avoid creating duplicates when the brand user PG id changes
  let campaign = await db.campaign.findFirst({
    where: { title: 'E2E Campaign', isDeleted: false },
  });
  if (!campaign) {
    campaign = await db.campaign.create({
      data: {
        title: 'E2E Campaign',
        brandUserId: brand.id,
        brandName: E2E_ACCOUNTS.brand.name,
        platform: 'Amazon',
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        originalPricePaise: 1200_00,
        pricePaise: 999_00,
        payoutPaise: 100_00,
        returnWindowDays: 14,
        dealType: 'Discount' as any,
        totalSlots: 100,
        usedSlots: 0,
        status: 'active' as any,
        allowedAgencyCodes: [E2E_ACCOUNTS.agency.agencyCode],
        assignments: { [E2E_ACCOUNTS.mediator.mediatorCode]: { limit: 100 } },
        createdBy: admin.id,
      },
    });
  } else if (campaign.brandUserId !== brand.id) {
    // Ensure campaign points to the current brand user
    campaign = await db.campaign.update({
      where: { id: campaign.id },
      data: { brandUserId: brand.id, brandName: E2E_ACCOUNTS.brand.name },
    });
  }

  // Deal: find existing or create — never duplicate, never delete
  // Search broadly by mediatorCode + title so we always find and fix stale deals
  const existingDeal = await db.deal.findFirst({
    where: { mediatorCode: E2E_ACCOUNTS.mediator.mediatorCode, title: 'E2E Deal', isDeleted: false },
  });
  const dealDefaults = {
    title: 'E2E Deal',
    description: 'Exclusive',
    image: 'https://placehold.co/600x400',
    productUrl: 'https://example.com/product',
    platform: 'Amazon',
    brandName: E2E_ACCOUNTS.brand.name,
    dealType: 'Discount' as any,
    originalPricePaise: 1200_00,
    pricePaise: 999_00,
    commissionPaise: 50_00,
    payoutPaise: 100_00,
    rating: 5,
    category: 'General',
    active: true,
    createdBy: admin.id,
  };
  if (!existingDeal) {
    await db.deal.create({
      data: {
        campaignId: campaign.id,
        mediatorCode: E2E_ACCOUNTS.mediator.mediatorCode,
        ...dealDefaults,
      },
    });
  } else {
    // Always reconcile critical fields so stale seed data never breaks tests
    await db.deal.update({
      where: { id: existingDeal.id },
      data: {
        campaignId: campaign.id,
        title: dealDefaults.title,
        payoutPaise: dealDefaults.payoutPaise,
        commissionPaise: dealDefaults.commissionPaise,
        originalPricePaise: dealDefaults.originalPricePaise,
        pricePaise: dealDefaults.pricePaise,
        active: true,
      },
    });
  }

  return { admin, agency, mediator, brand, shopper, shopper2 };
}
