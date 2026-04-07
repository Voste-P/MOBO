import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { seedE2E, E2E_ACCOUNTS } from '../../seeds/e2e.js';

// Unique suffix per test run to avoid collisions on re-run
const RUN = Date.now().toString().slice(-6);
let mobileSeq = 0;
function uniqueMobile(base: string) {
  const suffix = (parseInt(RUN, 10) + ++mobileSeq) % 1_000_000;
  return base.slice(0, 4) + String(suffix).padStart(6, '0');
}

async function setup() {
  const env = loadEnv({ NODE_ENV: 'test' });
  const seeded = await seedE2E();
  const app = createApp(env);

  return { app, env, seeded };
}

describe('mediator pending approval flow', () => {
  it('mediator joins via agency code → pending → agency approves → mediator can login', async () => {
    const { app, seeded: _seeded } = await setup();
    const db = prisma();

    // 1. Mediator registers using agency code
    const mediatorMobile = uniqueMobile('9112');
    const mediatorPassword = 'ChangeMe_123!';
    const registerRes = await request(app).post('/api/auth/register-ops').send({
      name: 'Pending Mediator',
      mobile: mediatorMobile,
      password: mediatorPassword,
      role: 'mediator',
      code: E2E_ACCOUNTS.agency.agencyCode,
    });

    // Should return 202 with pendingApproval flag
    expect(registerRes.status).toBe(202);
    expect(registerRes.body).toHaveProperty('pendingApproval', true);
    expect(registerRes.body).toHaveProperty('message');
    expect(registerRes.body.tokens).toBeUndefined();

    // 2. Verify mediator is created with pending status (PG)
    const pendingMediator = await db.user.findFirst({ where: { mobile: mediatorMobile, isDeleted: false } });
    expect(pendingMediator).toBeTruthy();
    expect(pendingMediator?.status).toBe('pending');
    expect(pendingMediator?.kycStatus).toBe('pending');
    const mediatorCode = pendingMediator?.mediatorCode;
    expect(typeof mediatorCode).toBe('string');

    const profile = await db.mediatorProfile.findFirst({ where: { mediatorCode: mediatorCode!, isDeleted: false } });
    expect(profile).toBeTruthy();
    expect(profile?.parentAgencyCode).toBe(E2E_ACCOUNTS.agency.agencyCode);

    // 3. Mediator cannot login yet
    const loginBeforeApproval = await request(app).post('/api/auth/login').send({
      mobile: mediatorMobile,
      password: mediatorPassword,
    });
    expect(loginBeforeApproval.status).not.toBe(200);

    // 4. Agency logs in
    const agencyLoginRes = await request(app).post('/api/auth/login').send({
      mobile: E2E_ACCOUNTS.agency.mobile,
      password: E2E_ACCOUNTS.agency.password,
    });
    expect(agencyLoginRes.status).toBe(200);
    const agencyToken = agencyLoginRes.body.tokens.accessToken;

    // 5. Agency sees pending mediator in their list
    const getMediatorsRes = await request(app)
      .get(`/api/ops/mediators?agencyCode=${encodeURIComponent(E2E_ACCOUNTS.agency.agencyCode)}`)
      .set('Authorization', `Bearer ${agencyToken}`);
    expect(getMediatorsRes.status).toBe(200);
    const pendingInList = getMediatorsRes.body.find(
      (m: any) => m.mediatorCode === mediatorCode && m.status === 'pending'
    );
    expect(pendingInList).toBeTruthy();

    // 6. Agency approves the mediator (uses id since controller looks up by id)
    const approveRes = await request(app)
      .post('/api/ops/mediators/approve')
      .set('Authorization', `Bearer ${agencyToken}`)
      .send({ id: pendingMediator!.id });
    expect(approveRes.status).toBe(200);

    // 7. Verify mediator is now active (PG)
    const approvedMediator = await db.user.findUnique({ where: { id: pendingMediator!.id } });
    expect(approvedMediator?.status).toBe('active');
    expect(approvedMediator?.kycStatus).toBe('verified');

    // 8. Mediator can now login
    const loginAfterApproval = await request(app).post('/api/auth/login').send({
      mobile: mediatorMobile,
      password: mediatorPassword,
    });
    expect(loginAfterApproval.status).toBe(200);
    expect(loginAfterApproval.body).toHaveProperty('user');
    expect(loginAfterApproval.body).toHaveProperty('tokens');
    expect(loginAfterApproval.body.user.status).toBe('active');
  });

  it('prevents non-parent agencies from approving mediators', async () => {
    const { app, seeded: _seeded } = await setup();
    const db = prisma();

    // Create a mediator under the first agency
    const mediatorMobile = uniqueMobile('9114');
    const registerRes = await request(app).post('/api/auth/register-ops').send({
      name: 'Mediator Under Agency 1',
      mobile: mediatorMobile,
      password: 'ChangeMe_123!',
      role: 'mediator',
      code: E2E_ACCOUNTS.agency.agencyCode,
    });
    expect(registerRes.status).toBe(202);

    // Look up pending mediator in PG (controller uses { id: body.id })
    const pendingMediator = await db.user.findFirst({ where: { mobile: mediatorMobile, isDeleted: false } });
    const mediatorId = pendingMediator?.id;

    // Create a second agency (via admin invite) to ensure its code differs.
    const adminLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: E2E_ACCOUNTS.admin.username, password: E2E_ACCOUNTS.admin.password });
    expect(adminLoginRes.status).toBe(200);
    const adminToken = adminLoginRes.body.tokens.accessToken as string;

    const inviteRes = await request(app)
      .post('/api/admin/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'agency', label: 'Agency2 Invite', maxUses: 1, ttlSeconds: 60 });
    expect(inviteRes.status).toBe(201);
    const agency2Invite = inviteRes.body.code as string;

    const agency2Mobile = uniqueMobile('9223');
    const agency2Res = await request(app).post('/api/auth/register-ops').send({
      name: 'Agency 2',
      mobile: agency2Mobile,
      password: 'ChangeMe_123!',
      role: 'agency',
      code: agency2Invite,
    });
    expect(agency2Res.status).toBe(201);
    const agency2Token = agency2Res.body.tokens.accessToken as string;

    // Agency 2 should NOT be able to approve mediator under Agency 1
    const approveRes = await request(app)
      .post('/api/ops/mediators/approve')
      .set('Authorization', `Bearer ${agency2Token}`)
      .send({ id: mediatorId });
    expect(approveRes.status).toBe(403);
  });
});
