// Dev seeding — PG-only via Prisma.
import { randomUUID } from 'node:crypto';

import { hashPassword } from '../services/passwords.js';
import { ensureRoleDocumentsForUser } from '../services/roleDocuments.js';
import { seedAdminOnly } from './admin.js';
import { prisma } from '../database/prisma.js';

export const DEV_ACCOUNTS = {
  admin: {
    name: 'Dev Admin',
    username: 'root',
    password: 'ChangeMe_123!',
    mobile: '9000000000',
  },
  agency: {
    name: 'Dev Agency',
    password: 'ChangeMe_123!',
    mobile: '9000000001',
    agencyCode: 'AG_TEST',
  },
  mediator: {
    name: 'Dev Mediator',
    password: 'ChangeMe_123!',
    mobile: '9000000002',
    mediatorCode: 'MED_TEST',
  },
  brand: {
    name: 'Dev Brand',
    password: 'ChangeMe_123!',
    mobile: '9000000003',
    brandCode: 'BRD_TEST',
  },
  shopper: {
    name: 'Dev Buyer',
    password: 'ChangeMe_123!',
    mobile: '9000000004',
  },
} as const;

export type SeededDev = {
  admin: any;
  agency: any;
  mediator: any;
  brand: any;
  shopper: any;
  campaign: any;
  deal: any;
};

async function upsertUserByMobile(params: {
  mobile: string;
  name: string;
  password: string;
  role: 'agency' | 'mediator' | 'brand' | 'shopper';
  roles: string[];
  extra: Record<string, any>;
  adminId: string;
}) {
  const db = prisma();
  const forcePassword = String(process.env.SEED_DEV_FORCE_PASSWORD || '').toLowerCase() === 'true';

  let user = await db.user.findFirst({ where: { mobile: params.mobile, isDeleted: false } });
  if (!user) {
    const passwordHash = await hashPassword(params.password);
    user = await db.user.create({
      data: {
        mongoId: randomUUID(),
        name: params.name,
        mobile: params.mobile,
        passwordHash,
        role: params.role as any,
        roles: params.roles as any,
        status: 'active' as any,
        createdBy: params.adminId,
        ...params.extra,
      },
    });
  } else {
    const updateData: any = {
      name: params.name,
      role: params.role,
      roles: Array.from(new Set([...(user.roles as string[] ?? []), ...params.roles])),
      status: 'active',
      isDeleted: false,
      ...params.extra,
    };
    if (forcePassword) {
      updateData.passwordHash = await hashPassword(params.password);
    }
    user = await db.user.update({ where: { id: user.id }, data: updateData });
  }

  return user;
}

async function ensureBrandWalletFunds(brandUserId: string, adminId: string) {
  const db = prisma();
  const target = 50_000_00; // ₹50,000
  await db.wallet.upsert({
    where: { ownerUserId: brandUserId },
    create: {
      mongoId: randomUUID(),
      ownerUserId: brandUserId,
      currency: 'INR' as any,
      availablePaise: target,
      pendingPaise: 0,
      lockedPaise: 0,
      version: 0,
      createdBy: adminId,
    },
    update: { availablePaise: target, pendingPaise: 0, lockedPaise: 0 },
  });
}

export async function seedDev(): Promise<SeededDev> {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('seedDev() is disabled in production');
  }

  const admin = await seedAdminOnly({
    username: DEV_ACCOUNTS.admin.username,
    mobile: DEV_ACCOUNTS.admin.mobile,
    password: DEV_ACCOUNTS.admin.password,
    name: DEV_ACCOUNTS.admin.name,
    forcePassword: String(process.env.SEED_DEV_FORCE_PASSWORD || '').toLowerCase() === 'true',
    forceUsername: true,
  });

  const agency = await upsertUserByMobile({
    mobile: DEV_ACCOUNTS.agency.mobile,
    name: DEV_ACCOUNTS.agency.name,
    password: DEV_ACCOUNTS.agency.password,
    role: 'agency',
    roles: ['agency'],
    adminId: admin.id,
    extra: { mediatorCode: DEV_ACCOUNTS.agency.agencyCode, kycStatus: 'verified' },
  });

  const mediator = await upsertUserByMobile({
    mobile: DEV_ACCOUNTS.mediator.mobile,
    name: DEV_ACCOUNTS.mediator.name,
    password: DEV_ACCOUNTS.mediator.password,
    role: 'mediator',
    roles: ['mediator'],
    adminId: admin.id,
    extra: {
      mediatorCode: DEV_ACCOUNTS.mediator.mediatorCode,
      parentCode: DEV_ACCOUNTS.agency.agencyCode,
      kycStatus: 'verified',
    },
  });

  const brand = await upsertUserByMobile({
    mobile: DEV_ACCOUNTS.brand.mobile,
    name: DEV_ACCOUNTS.brand.name,
    password: DEV_ACCOUNTS.brand.password,
    role: 'brand',
    roles: ['brand'],
    adminId: admin.id,
    extra: { brandCode: DEV_ACCOUNTS.brand.brandCode },
  });

  const shopper = await upsertUserByMobile({
    mobile: DEV_ACCOUNTS.shopper.mobile,
    name: DEV_ACCOUNTS.shopper.name,
    password: DEV_ACCOUNTS.shopper.password,
    role: 'shopper',
    roles: ['shopper'],
    adminId: admin.id,
    extra: {
      isVerifiedByMediator: true,
      parentCode: DEV_ACCOUNTS.mediator.mediatorCode,
    },
  });

  await ensureRoleDocumentsForUser({ user: agency });
  await ensureRoleDocumentsForUser({ user: mediator });
  await ensureRoleDocumentsForUser({ user: brand });
  await ensureRoleDocumentsForUser({ user: shopper });

  await ensureBrandWalletFunds(brand.id, admin.id);

  const db = prisma();

  // Minimal campaign + deal so Buyer portal has something to browse.
  const campaignTitle = 'DEV Campaign';
  let campaign = await db.campaign.findFirst({ where: { title: campaignTitle, brandUserId: brand.id } });
  if (!campaign) {
    campaign = await db.campaign.create({
      data: {
        mongoId: randomUUID(),
        title: campaignTitle,
        brandUserId: brand.id,
        brandName: DEV_ACCOUNTS.brand.name,
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
        allowedAgencyCodes: [DEV_ACCOUNTS.agency.agencyCode],
        assignments: { [DEV_ACCOUNTS.mediator.mediatorCode]: { limit: 100 } },
        createdBy: admin.id,
      },
    });
  }

  const dealTitle = 'DEV Deal';
  let deal = await db.deal.findFirst({
    where: { title: dealTitle, mediatorCode: DEV_ACCOUNTS.mediator.mediatorCode },
  });
  if (!deal) {
    deal = await db.deal.create({
      data: {
        mongoId: randomUUID(),
        campaignId: campaign.id,
        mediatorCode: DEV_ACCOUNTS.mediator.mediatorCode,
        title: dealTitle,
        description: 'Seeded demo deal',
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        platform: 'Amazon',
        brandName: DEV_ACCOUNTS.brand.name,
        dealType: 'Discount' as any,
        originalPricePaise: 1200_00,
        pricePaise: 999_00,
        commissionPaise: 50_00,
        payoutPaise: 100_00,
        rating: 5,
        category: 'General',
        active: true,
        createdBy: admin.id,
      },
    });
  }

  return { admin, agency, mediator, brand, shopper, campaign, deal };
}
