import request from 'supertest';

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

describe('ops deals: publish', () => {
  it('allows mediator to publish when campaign has a slot assignment (even if allowedAgencyCodes is missing)', async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const seeded = await seedE2E();

    const app = createApp(env);
    const db = prisma();

    const _agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);
    const mediator = await login(app, E2E_ACCOUNTS.mediator.mobile, E2E_ACCOUNTS.mediator.password);

    const mediatorCode = E2E_ACCOUNTS.mediator.mediatorCode;

    const pgCampaign = await db.campaign.create({
      data: {
        title: 'Publish Campaign (missing allowedAgencyCodes)',
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
        allowedAgencyCodes: [],
        assignments: { [mediatorCode]: { limit: 3 } },
        createdBy: seeded.agency.id,
      },
    });

    const res = await request(app)
      .post('/api/ops/deals/publish')
      .set('Authorization', `Bearer ${mediator.token}`)
      .send({
        id: pgCampaign.id,
        commission: 50,
        mediatorCode,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);

    const deal = await db.deal.findFirst({ where: { campaignId: pgCampaign.id, mediatorCode, isDeleted: false } });
    expect(deal).toBeTruthy();
    expect(deal?.active).toBe(true);
  });

  it('allows publishing with commission omitted (defaults to 0)', async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const seeded = await seedE2E();

    const app = createApp(env);
    const db = prisma();

    const _agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);
    const mediator = await login(app, E2E_ACCOUNTS.mediator.mobile, E2E_ACCOUNTS.mediator.password);

    const mediatorCode = E2E_ACCOUNTS.mediator.mediatorCode;

    const pgCampaign = await db.campaign.create({
      data: {
        title: 'Publish Campaign (no commission field)',
        brandUserId: seeded.agency.id,
        brandName: 'Agency Inventory',
        platform: 'Amazon',
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        originalPricePaise: 1000_00,
        pricePaise: 900_00,
        payoutPaise: 50_00,
        returnWindowDays: 14,
        dealType: 'Discount',
        totalSlots: 10,
        usedSlots: 0,
        status: 'active',
        allowedAgencyCodes: [],
        assignments: { [mediatorCode]: { limit: 3 } },
        createdBy: seeded.agency.id,
      },
    });

    const res = await request(app)
      .post('/api/ops/deals/publish')
      .set('Authorization', `Bearer ${mediator.token}`)
      .send({
        id: pgCampaign.id,
        mediatorCode,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);

    const deal = await db.deal.findFirst({ where: { campaignId: pgCampaign.id, mediatorCode, isDeleted: false } });
    expect(deal).toBeTruthy();
    expect(deal?.commissionPaise).toBe(0);
    expect(deal?.active).toBe(true);
  });

  it('rejects publishing when buyer discount exceeds agency commission', async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const seeded = await seedE2E();

    const app = createApp(env);
    const db = prisma();

    const _agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);
    const mediator = await login(app, E2E_ACCOUNTS.mediator.mobile, E2E_ACCOUNTS.mediator.password);

    const mediatorCode = E2E_ACCOUNTS.mediator.mediatorCode;

    const pgCampaign = await db.campaign.create({
      data: {
        title: 'Publish Campaign (negative commission exceeds agency commission)',
        brandUserId: seeded.agency.id,
        brandName: 'Agency Inventory',
        platform: 'Amazon',
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        originalPricePaise: 1000_00,
        pricePaise: 900_00,
        payoutPaise: 0,
        returnWindowDays: 14,
        dealType: 'Discount',
        totalSlots: 10,
        usedSlots: 0,
        status: 'active',
        allowedAgencyCodes: [],
        assignments: { [mediatorCode]: { limit: 3, payout: 500 } },
        createdBy: seeded.agency.id,
      },
    });

    const res = await request(app)
      .post('/api/ops/deals/publish')
      .set('Authorization', `Bearer ${mediator.token}`)
      .send({
        id: pgCampaign.id,
        commission: -10,  // ₹-10 buyer discount, net = 5 + (-10) = -5 < 0
        mediatorCode,
      });

    // Net earnings (500 paise + (-1000 paise) = -500 paise) is negative; should be rejected.
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('INVALID_ECONOMICS');

    const deal = await db.deal.findFirst({ where: { campaignId: pgCampaign.id, mediatorCode, isDeleted: false } });
    expect(deal).toBeFalsy();
  });

  it('allows publishing when campaign and slot assignment both have zero payout', async () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    const seeded = await seedE2E();

    const app = createApp(env);
    const db = prisma();

    const _agency = await login(app, E2E_ACCOUNTS.agency.mobile, E2E_ACCOUNTS.agency.password);
    const mediator = await login(app, E2E_ACCOUNTS.mediator.mobile, E2E_ACCOUNTS.mediator.password);

    const mediatorCode = E2E_ACCOUNTS.mediator.mediatorCode;

    const pgCampaign = await db.campaign.create({
      data: {
        title: 'Zero Payout Campaign',
        brandUserId: seeded.agency.id,
        brandName: 'Agency Inventory',
        platform: 'Amazon',
        image: 'https://placehold.co/600x400',
        productUrl: 'https://example.com/product',
        originalPricePaise: 1000_00,
        pricePaise: 900_00,
        payoutPaise: 0,
        returnWindowDays: 14,
        dealType: 'Discount',
        totalSlots: 10,
        usedSlots: 0,
        status: 'active',
        allowedAgencyCodes: [],
        assignments: { [mediatorCode]: { limit: 3 } },
        createdBy: seeded.agency.id,
      },
    });

    const res = await request(app)
      .post('/api/ops/deals/publish')
      .set('Authorization', `Bearer ${mediator.token}`)
      .send({
        id: pgCampaign.id,
        mediatorCode,
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);

    const deal = await db.deal.findFirst({ where: { campaignId: pgCampaign.id, mediatorCode, isDeleted: false } });
    expect(deal).toBeTruthy();
    expect(deal!.payoutPaise).toBe(0);
  });
});
