import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

async function login(app: any, mobile: string, password: string) {
  const res = await request(app).post('/api/auth/login').send({ mobile, password });
  expect(res.status).toBe(200);
  return {
    token: res.body.tokens.accessToken as string,
    userId: res.body.user.id as string,
  };
}

describe('ops campaigns: assign slots', () => {
  it('rejects empty/zero allocations and only locks after a real assignment', async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const seeded = await seedE2E();

    const app = createApp(env);
    const db = prisma();

    const agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);

    const pgCampaign = await db.campaign.create({
      data: {
        mongoId: randomUUID(),
        title: 'Slots Campaign',
        brandUserId: seeded.agency.id,
        brandName: 'Agency Inventory',
        platform: 'Amazon',
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        originalPricePaise: 1000_00,
        pricePaise: 900_00,
        payoutPaise: 100_00,
        returnWindowDays: 14,
        dealType: 'Discount',
        totalSlots: 10,
        usedSlots: 0,
        status: 'active',
        allowedAgencyCodes: [E2E_ACCOUNTS.agency.agencyCode],
        assignments: {},
        createdBy: seeded.agency.id,
      },
    });

    const zeroRes = await request(app)
      .post('/api/ops/campaigns/assign')
      .set('Authorization', `Bearer ${agency.token}`)
      .send({
        id: pgCampaign.id,
        assignments: { [E2E_ACCOUNTS.mediator.mediatorCode]: 0 },
      });

    expect(zeroRes.status).toBe(400);
    expect(zeroRes.body?.error?.code || zeroRes.body?.code).toBe('NO_ASSIGNMENTS');

    const okRes = await request(app)
      .post('/api/ops/campaigns/assign')
      .set('Authorization', `Bearer ${agency.token}`)
      .send({
        id: pgCampaign.id,
        assignments: { [E2E_ACCOUNTS.mediator.mediatorCode]: 5 },
      });

      expect(okRes.status).toBe(200);

    // Verify campaign updated in PG
    const updated = await db.campaign.findUnique({ where: { id: pgCampaign.id } });
    expect(updated).toBeTruthy();
    expect(updated?.locked).toBe(true);

    const assignmentsObj = updated?.assignments as any;
    const normCode = E2E_ACCOUNTS.mediator.mediatorCode.toLowerCase();
    expect(assignmentsObj?.[normCode]).toBeTruthy();
    expect(assignmentsObj?.[normCode]?.limit).toBe(5);
  });

  it('prevents agencies from assigning to non-active mediators', async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const seeded = await seedE2E();

    const app = createApp(env);
    const db = prisma();

    const agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);

    // Create pending mediator in PG (controllers query PG only)
    const pendingMongoId = randomUUID();
    const pendingMobile = `91${Date.now().toString().slice(-8)}`;
    const pendingMedCode = `MED_PEND_${Date.now()}`;
    await db.user.create({
      data: {
        mongoId: pendingMongoId,
        name: 'Pending Mediator',
        mobile: pendingMobile,
        passwordHash: 'x',
        role: 'mediator',
        roles: ['mediator'],
        status: 'pending',
        mediatorCode: pendingMedCode,
        parentCode: E2E_ACCOUNTS.agency.agencyCode,
      },
    });

    const pgCampaign = await db.campaign.create({
      data: {
        mongoId: randomUUID(),
        title: 'Slots Campaign 2',
        brandUserId: seeded.agency.id,
        brandName: 'Agency Inventory',
        platform: 'Amazon',
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        originalPricePaise: 1000_00,
        pricePaise: 900_00,
        payoutPaise: 100_00,
        returnWindowDays: 14,
        dealType: 'Discount',
        totalSlots: 10,
        usedSlots: 0,
        status: 'active',
        allowedAgencyCodes: [E2E_ACCOUNTS.agency.agencyCode],
        assignments: {},
        createdBy: seeded.agency.id,
      },
    });

    const res = await request(app)
      .post('/api/ops/campaigns/assign')
      .set('Authorization', `Bearer ${agency.token}`)
      .send({
        id: pgCampaign.id,
        assignments: { [pendingMedCode]: 1 },
      });

    expect(res.status).toBe(403);
    expect(res.body?.error?.code || res.body?.code).toBe('INVALID_MEDIATOR_CODE');
  });
});
