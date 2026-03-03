import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { seedE2E, E2E_ACCOUNTS } from '../seeds/e2e.js';

// Unique suffix per test run to avoid collisions on re-run
const RUN = Date.now().toString().slice(-6);
let inviteSeq = 0;
function uniqueInviteCode(prefix: string) { return `${prefix}_${RUN}_${++inviteSeq}`; }
function uniqueMobile(base: string) {
  // Replace last N digits with RUN-based suffix
  const suffix = (parseInt(RUN, 10) + inviteSeq) % 1_000_000;
  return base.slice(0, 4) + String(suffix).padStart(6, '0');
}

/**
 * Helper: create an invite in PostgreSQL (primary).
 */
async function createInvite(
  fields: {
    code: string;
    role: string;
    status?: string;
    parentUserId?: string | null;
    parentCode?: string | null;
    createdBy?: string | null;
    maxUses?: number;
    useCount?: number;
    expiresAt?: Date | null;
  },
) {
  const db = prisma();
  return db.invite.create({
    data: {
      mongoId: randomUUID(),
      code: fields.code,
      role: fields.role as any,
      status: (fields.status ?? 'active') as any,
      parentUserId: fields.parentUserId ?? null,
      parentCode: fields.parentCode ?? null,
      createdBy: fields.createdBy ?? null,
      maxUses: fields.maxUses ?? 1,
      useCount: fields.useCount ?? 0,
      expiresAt: fields.expiresAt ?? null,
    },
  });
}

async function setup() {
  const env = loadEnv({ NODE_ENV: 'test' });
  const seeded = await seedE2E();
  const app = createApp(env);
  return { env, seeded, app };
}

describe('auth registration + invites', () => {
  it('registers a shopper via invite and consumes the invite', async () => {
    const { app, seeded } = await setup();
    const db = prisma();

    const inviteCode = uniqueInviteCode('INV_SHOPPER');
    await createInvite({
      code: inviteCode,
      role: 'shopper',
      status: 'active',
      parentUserId: seeded.mediator.id,
      parentCode: E2E_ACCOUNTS.mediator.mediatorCode,
      createdBy: seeded.admin.id,
      maxUses: 1,
      useCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const mobile = uniqueMobile('9111');
    const res = await request(app).post('/api/auth/register').send({
      name: 'New Shopper',
      mobile,
      email: `shopper_${RUN}@example.com`,
      password: 'ChangeMe_123!',
      mediatorCode: inviteCode,
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user).toHaveProperty('mobile', mobile);
    expect(res.body.user).toHaveProperty('role', 'user');
    expect(res.body.user).toHaveProperty('mediatorCode', E2E_ACCOUNTS.mediator.mediatorCode);
    expect(res.body).toHaveProperty('tokens');
    expect(typeof res.body.tokens?.accessToken).toBe('string');

    // Verify invite was consumed (PG)
    const invite = await db.invite.findFirst({ where: { code: inviteCode } });
    expect(invite).toBeTruthy();
    expect(invite?.status).toBe('used');
    expect(invite?.useCount).toBe(1);
    expect(invite?.usedBy).toBeTruthy();
    expect(Array.isArray(invite?.uses)).toBe(true);
    expect(((invite?.uses as any[]) ?? []).length).toBe(1);

    // Verify user was created (PG)
    const created = await db.user.findFirst({ where: { mobile, isDeleted: false } });
    expect(created).toBeTruthy();
    const shopperProfile = await db.shopperProfile.findFirst({ where: { userId: created!.id } });
    expect(shopperProfile).toBeTruthy();
    expect(shopperProfile?.defaultMediatorCode).toBe(E2E_ACCOUNTS.mediator.mediatorCode);
  });

  it('registers a mediator via invite and consumes the invite', async () => {
    const { app, seeded } = await setup();
    const db = prisma();

    const inviteCode = uniqueInviteCode('INV_MEDIATOR');
    await createInvite({
      code: inviteCode,
      role: 'mediator',
      status: 'active',
      parentUserId: seeded.agency.id,
      parentCode: E2E_ACCOUNTS.agency.agencyCode,
      createdBy: seeded.admin.id,
      maxUses: 1,
      useCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const mobile = uniqueMobile('9222');
    const res = await request(app).post('/api/auth/register-ops').send({
      name: 'New Mediator',
      mobile,
      password: 'ChangeMe_123!',
      role: 'mediator',
      code: inviteCode,
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user).toHaveProperty('mobile', mobile);
    expect(res.body.user).toHaveProperty('role', 'mediator');
    expect(res.body.user).toHaveProperty('parentCode', E2E_ACCOUNTS.agency.agencyCode);
    expect(typeof res.body.user?.mediatorCode).toBe('string');
    expect(res.body).toHaveProperty('tokens');
    expect(typeof res.body.tokens?.accessToken).toBe('string');

    // Verify invite consumed (PG)
    const invite = await db.invite.findFirst({ where: { code: inviteCode } });
    expect(invite?.status).toBe('used');
    expect(invite?.useCount).toBe(1);

    // Verify user + profile created (PG)
    const created = await db.user.findFirst({ where: { mobile, isDeleted: false } });
    expect(created).toBeTruthy();
    const profile = await db.mediatorProfile.findFirst({ where: { mediatorCode: created!.mediatorCode! } });
    expect(profile).toBeTruthy();
    expect(profile?.userId).toBe(created!.id);
    expect(profile?.parentAgencyCode).toBe(E2E_ACCOUNTS.agency.agencyCode);
  });

  it('registers a mediator via agency code when invite is not found', async () => {
    const { app } = await setup();
    const db = prisma();

    const mobile = uniqueMobile('9220');
    const res = await request(app).post('/api/auth/register-ops').send({
      name: 'Mediator Join By Code',
      mobile,
      password: 'ChangeMe_123!',
      role: 'mediator',
      code: E2E_ACCOUNTS.agency.agencyCode,
    });

    // Mediator registration via agency code now requires approval
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('pendingApproval', true);
    expect(res.body).toHaveProperty('message');
    expect(res.body.tokens).toBeUndefined(); // No tokens until approved

    // Verify user created as pending (PG)
    const created = await db.user.findFirst({ where: { mobile, isDeleted: false } });
    expect(created).toBeTruthy();
    expect(created?.status).toBe('pending');
    const profile = await db.mediatorProfile.findFirst({ where: { mediatorCode: created!.mediatorCode! } });
    expect(profile).toBeTruthy();
    expect(profile?.parentAgencyCode).toBe(E2E_ACCOUNTS.agency.agencyCode);
  });

  it('registers a brand via invite and consumes the invite', async () => {
    const { app, seeded } = await setup();
    const db = prisma();

    const inviteCode = uniqueInviteCode('INV_BRAND');
    await createInvite({
      code: inviteCode,
      role: 'brand',
      status: 'active',
      createdBy: seeded.admin.id,
      maxUses: 1,
      useCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const mobile = uniqueMobile('9333');
    const res = await request(app).post('/api/auth/register-brand').send({
      name: 'New Brand',
      mobile,
      password: 'ChangeMe_123!',
      brandCode: inviteCode,
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user).toHaveProperty('mobile', mobile);
    expect(res.body.user).toHaveProperty('role', 'brand');
    expect(typeof res.body.user?.brandCode).toBe('string');

    // Verify user created (PG)
    const created = await db.user.findFirst({ where: { mobile } });
    expect(created).toBeTruthy();
    expect(created?.createdBy).toBe(seeded.admin.id);

    // Verify invite consumed (PG)
    const invite = await db.invite.findFirst({ where: { code: inviteCode } });
    expect(invite?.status).toBe('used');
    expect(invite?.useCount).toBe(1);

    // Verify brand doc (PG)
    const brandDoc = await db.brand.findFirst({ where: { brandCode: created!.brandCode! } });
    expect(brandDoc).toBeTruthy();
    expect(brandDoc?.ownerUserId).toBe(created!.id);
  });

  it('registers a shopper via mediator code when invite is not found', async () => {
    const { app } = await setup();
    const db = prisma();

    const mobile = uniqueMobile('9110');
    const res = await request(app).post('/api/auth/register').send({
      name: 'Shopper Join By Code',
      mobile,
      email: `shopper2_${RUN}@example.com`,
      password: 'ChangeMe_123!',
      mediatorCode: E2E_ACCOUNTS.mediator.mediatorCode,
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user).toHaveProperty('mobile', mobile);
    expect(res.body.user).toHaveProperty('role', 'user');
    expect(res.body.user).toHaveProperty('mediatorCode', E2E_ACCOUNTS.mediator.mediatorCode);
    expect(res.body).toHaveProperty('tokens');
    expect(typeof res.body.tokens?.accessToken).toBe('string');

    // Verify user + profile (PG)
    const created = await db.user.findFirst({ where: { mobile, isDeleted: false } });
    expect(created).toBeTruthy();
    const shopperProfile = await db.shopperProfile.findFirst({ where: { userId: created!.id } });
    expect(shopperProfile).toBeTruthy();
    expect(shopperProfile?.defaultMediatorCode).toBe(E2E_ACCOUNTS.mediator.mediatorCode);
  });

  it('registers an agency via invite and creates an Agency record', async () => {
    const { app, seeded } = await setup();
    const db = prisma();

    const inviteCode = uniqueInviteCode('INV_AGENCY');
    await createInvite({
      code: inviteCode,
      role: 'agency',
      status: 'active',
      createdBy: seeded.admin.id,
      maxUses: 1,
      useCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const mobile = uniqueMobile('9777');
    const res = await request(app).post('/api/auth/register-ops').send({
      name: 'New Agency',
      mobile,
      password: 'ChangeMe_123!',
      role: 'agency',
      code: inviteCode,
    });

    expect(res.status).toBe(201);

    // Verify user (PG)
    const created = await db.user.findFirst({ where: { mobile, isDeleted: false } });
    expect(created).toBeTruthy();
    expect((created?.roles as string[]) ?? []).toContain('agency');

    const agencyCode = String(created?.mediatorCode || '');
    expect(agencyCode).toMatch(/^AGY_/);

    // Verify agency doc (PG)
    const agencyDoc = await db.agency.findFirst({ where: { agencyCode } });
    expect(agencyDoc).toBeTruthy();
    expect(agencyDoc?.ownerUserId).toBe(created!.id);
  });

  it('rejects expired invites and does not create a user', async () => {
    const { app, seeded } = await setup();
    const db = prisma();

    const inviteCode = uniqueInviteCode('INV_EXPIRED');
    await createInvite({
      code: inviteCode,
      role: 'agency',
      status: 'active',
      createdBy: seeded.admin.id,
      maxUses: 1,
      useCount: 0,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const mobile = uniqueMobile('9444');
    const res = await request(app).post('/api/auth/register-ops').send({
      name: 'Expired User',
      mobile,
      password: 'ChangeMe_123!',
      role: 'agency',
      code: inviteCode,
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'INVITE_EXPIRED');

    // Verify no user created (PG)
    const user = await db.user.findFirst({ where: { mobile } });
    expect(user).toBeNull();

    // Verify invite marked expired (PG)
    const invite = await db.invite.findFirst({ where: { code: inviteCode } });
    expect(invite?.status).toBe('expired');
  });

  it('enforces maxUses (replay-safe): second registration fails and user is not created', async () => {
    const { app, seeded } = await setup();
    const db = prisma();

    const inviteCode = uniqueInviteCode('INV_ONCE');
    await createInvite({
      code: inviteCode,
      role: 'agency',
      status: 'active',
      createdBy: seeded.admin.id,
      maxUses: 1,
      useCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const firstMobile = uniqueMobile('9555');
    const first = await request(app).post('/api/auth/register-ops').send({
      name: 'Agency One',
      mobile: firstMobile,
      password: 'ChangeMe_123!',
      role: 'agency',
      code: inviteCode,
    });
    expect(first.status).toBe(201);

    const secondMobile = uniqueMobile('9666');
    const second = await request(app).post('/api/auth/register-ops').send({
      name: 'Agency Two',
      mobile: secondMobile,
      password: 'ChangeMe_123!',
      role: 'agency',
      code: inviteCode,
    });
    expect(second.status).toBe(400);
    expect(second.body).toHaveProperty('error');
    expect(second.body.error).toHaveProperty('code', 'INVALID_INVITE');

    // Verify second user was NOT created (PG)
    const user2 = await db.user.findFirst({ where: { mobile: secondMobile } });
    expect(user2).toBeNull();
  });
});
