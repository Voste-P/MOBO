/**
 * Clean test/seed data from the database.
 *
 * This script identifies and removes E2E/dev seed data while preserving
 * all real production data. It operates in DRY-RUN mode by default.
 *
 * Usage:
 *   npx tsx scripts/cleanTestData.ts          # dry-run (shows what would be deleted)
 *   npx tsx scripts/cleanTestData.ts --apply  # actually deletes test data
 */
import { connectPrisma, prisma } from '../database/prisma.js';

// ─── Test Data Identifiers ────────────────────────────────────────────────────
const TEST_MOBILES = [
  '9000000000', '9000000001', '9000000002', '9000000003',
  '9000000004', '9000000005',
];
const TEST_CODES = ['AG_TEST', 'MED_TEST', 'BRD_TEST'];
const TEST_NAME_PREFIXES = ['E2E ', 'Dev ', 'Test '];
const REAL_ADMIN_USERNAME = 'chetan'; // NEVER delete this

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ cleanTestData is DISABLED in production. Aborting.');
    process.exit(1);
  }

  const dryRun = !process.argv.includes('--apply');
  if (dryRun) {
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  DRY RUN — No data will be deleted. Pass --apply to execute.');
    console.log('══════════════════════════════════════════════════════════════\n');
  } else {
    console.log('\n⚠️  LIVE MODE — Test data will be permanently deleted.\n');
  }

  await connectPrisma();
  const db = prisma();

  // ─── Step 1: Find test users ──────────────────────────────────────────────
  const allUsers = await db.user.findMany({
    where: { isDeleted: false },
    select: { id: true, mongoId: true, name: true, mobile: true, username: true, role: true, roles: true, mediatorCode: true, brandCode: true, parentCode: true },
  });

  const testUserIds: string[] = [];
  const testUserMongoIds: string[] = [];
  const testMediatorCodes: string[] = [];
  const testBrandCodes: string[] = [];

  for (const u of allUsers) {
    // NEVER delete the real admin
    if (u.username === REAL_ADMIN_USERNAME) continue;

    const isTestMobile = TEST_MOBILES.includes(u.mobile ?? '');
    const isTestCode = TEST_CODES.includes(u.mediatorCode ?? '') || TEST_CODES.includes(u.brandCode ?? '');
    const isTestName = TEST_NAME_PREFIXES.some(p => (u.name ?? '').startsWith(p));
    const isTestUsername = u.username === 'root' && u.mobile === '9000000000';

    if (isTestMobile || isTestCode || isTestName || isTestUsername) {
      testUserIds.push(u.id);
      if (u.mongoId) testUserMongoIds.push(u.mongoId);
      if (u.mediatorCode && TEST_CODES.includes(u.mediatorCode)) testMediatorCodes.push(u.mediatorCode);
      if (u.brandCode && TEST_CODES.includes(u.brandCode)) testBrandCodes.push(u.brandCode);
      console.log(`  [TEST USER] id=${u.mongoId || u.id} name="${u.name}" mobile=${u.mobile} role=${u.role} code=${u.mediatorCode || u.brandCode || '-'}`);
    }
  }

  if (testUserIds.length === 0) {
    console.log('\n✅ No test data found. Database is clean.\n');
    process.exit(0);
  }

  console.log(`\n📋 Found ${testUserIds.length} test user(s).\n`);

  // ─── Step 2: Find related data ────────────────────────────────────────────
  // Orders created by, owned by, or managed by test users
  const testOrders = await db.order.findMany({
    where: {
      OR: [
        { userId: { in: testUserIds } },
        { createdBy: { in: testUserIds } },
        { brandUserId: { in: testUserIds } },
        ...(testMediatorCodes.length ? [{ managerName: { in: testMediatorCodes } }] : []),
      ],
    },
    select: { id: true, mongoId: true },
  });
  console.log(`  Orders to delete: ${testOrders.length}`);

  // Campaigns by test brand users
  const testCampaigns = await db.campaign.findMany({
    where: { brandUserId: { in: testUserIds } },
    select: { id: true, mongoId: true },
  });
  console.log(`  Campaigns to delete: ${testCampaigns.length}`);

  // Deals by test mediator codes
  const testDeals = await db.deal.findMany({
    where: {
      OR: [
        ...(testMediatorCodes.length ? [{ mediatorCode: { in: testMediatorCodes } }] : []),
        { campaignId: { in: testCampaigns.map(c => c.id) } },
      ].filter(Boolean),
    },
    select: { id: true, mongoId: true },
  });
  console.log(`  Deals to delete: ${testDeals.length}`);

  // Wallets
  const testWallets = await db.wallet.findMany({
    where: { ownerUserId: { in: testUserIds } },
    select: { id: true, mongoId: true },
  });
  console.log(`  Wallets to delete: ${testWallets.length}`);

  // Invites by test users
  const testInvites = await db.invite.findMany({
    where: { createdBy: { in: testUserIds } },
    select: { id: true, mongoId: true },
  });
  console.log(`  Invites to delete: ${testInvites.length}`);

  // Tickets by test users
  const testTickets = await db.ticket.findMany({
    where: { userId: { in: testUserIds } },
    select: { id: true },
  });
  console.log(`  Tickets to delete: ${testTickets.length}`);

  // PushSubscriptions by test users (userId may be PG id or mongoId string)
  // Filter mongoIds to only valid UUIDs to avoid Prisma UUID validation errors
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validMongoIdsForPush = testUserMongoIds.filter(id => uuidRegex.test(id));
  const allPushUserIds = [...new Set([...testUserIds, ...validMongoIdsForPush])];
  const testPushSubs = await db.pushSubscription.findMany({
    where: { userId: { in: allPushUserIds } },
    select: { id: true },
  });
  console.log(`  PushSubscriptions to delete: ${testPushSubs.length}`);

  // Payouts to test users
  const testPayouts = await db.payout.findMany({
    where: { beneficiaryUserId: { in: testUserIds } },
    select: { id: true },
  });
  console.log(`  Payouts to delete: ${testPayouts.length}`);

  // Transactions involving test users
  const testTransactions = await db.transaction.findMany({
    where: {
      OR: [
        { walletId: { in: testWallets.map(w => w.id) } },
        { orderId: { in: testOrders.map(o => o.id) } },
      ],
    },
    select: { id: true },
  });
  console.log(`  Transactions to delete: ${testTransactions.length}`);

  // Suspensions of test users
  const testSuspensions = await db.suspension.findMany({
    where: { targetUserId: { in: testUserIds } },
    select: { id: true },
  });
  console.log(`  Suspensions to delete: ${testSuspensions.length}`);

  // Audit logs by test users (filter to valid UUIDs only)
  const allAuditUserIds = [...new Set([...testUserIds, ...validMongoIdsForPush])];
  const testAuditLogs = await db.auditLog.findMany({
    where: { actorUserId: { in: allAuditUserIds } },
    select: { id: true },
  });
  console.log(`  AuditLogs to delete: ${testAuditLogs.length}`);

  // MediatorProfile & ShopperProfile for test users
  const testMedProfiles = await db.mediatorProfile.findMany({
    where: { userId: { in: testUserIds } },
    select: { id: true },
  });
  const testShopProfiles = await db.shopperProfile.findMany({
    where: { userId: { in: testUserIds } },
    select: { id: true },
  });
  console.log(`  MediatorProfiles to delete: ${testMedProfiles.length}`);
  console.log(`  ShopperProfiles to delete: ${testShopProfiles.length}`);

  // Brand records for test users
  const testBrands = await db.brand.findMany({
    where: { ownerUserId: { in: testUserIds } },
    select: { id: true },
  });
  console.log(`  Brands to delete: ${testBrands.length}`);

  // Agency records for test users
  const testAgencies = await db.agency.findMany({
    where: { ownerUserId: { in: testUserIds } },
    select: { id: true },
  });
  console.log(`  Agencies to delete: ${testAgencies.length}`);

  if (dryRun) {
    console.log('\n🔒 DRY RUN complete. Run with --apply to delete.\n');
    process.exit(0);
  }

  // ─── Step 3: Delete in correct order (respecting FK constraints) ──────────
  console.log('\n🗑️  Deleting test data...\n');

  const safeDelete = async (label: string, fn: () => Promise<any>, count: number) => {
    if (!count) return;
    try {
      await fn();
      console.log(`  ✅ Deleted ${count} ${label}`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('permission denied')) {
        console.log(`  ⚠️  Skipped ${count} ${label} (permission denied — ask DBA to grant DELETE)`);
      } else {
        console.log(`  ❌ Failed to delete ${label}: ${msg.slice(0, 120)}`);
      }
    }
  };

  // Delete child records first
  await safeDelete('audit logs', () => db.auditLog.deleteMany({ where: { id: { in: testAuditLogs.map(a => a.id) } } }), testAuditLogs.length);
  await safeDelete('suspensions', () => db.suspension.deleteMany({ where: { id: { in: testSuspensions.map(s => s.id) } } }), testSuspensions.length);
  await safeDelete('transactions', () => db.transaction.deleteMany({ where: { id: { in: testTransactions.map(t => t.id) } } }), testTransactions.length);
  await safeDelete('payouts', () => db.payout.deleteMany({ where: { id: { in: testPayouts.map(p => p.id) } } }), testPayouts.length);
  await safeDelete('push subscriptions', () => db.pushSubscription.deleteMany({ where: { id: { in: testPushSubs.map(p => p.id) } } }), testPushSubs.length);
  await safeDelete('tickets', () => db.ticket.deleteMany({ where: { id: { in: testTickets.map(t => t.id) } } }), testTickets.length);

  // Delete order items before orders
  if (testOrders.length) {
    const orderIds = testOrders.map(o => o.id);
    await safeDelete('order items', () => db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }), testOrders.length);
    await safeDelete('orders', () => db.order.deleteMany({ where: { id: { in: orderIds } } }), testOrders.length);
  }

  await safeDelete('deals', () => db.deal.deleteMany({ where: { id: { in: testDeals.map(d => d.id) } } }), testDeals.length);
  await safeDelete('campaigns', () => db.campaign.deleteMany({ where: { id: { in: testCampaigns.map(c => c.id) } } }), testCampaigns.length);
  await safeDelete('invites', () => db.invite.deleteMany({ where: { id: { in: testInvites.map(i => i.id) } } }), testInvites.length);
  await safeDelete('wallets', () => db.wallet.deleteMany({ where: { id: { in: testWallets.map(w => w.id) } } }), testWallets.length);

  // Delete profiles
  await safeDelete('mediator profiles', () => db.mediatorProfile.deleteMany({ where: { id: { in: testMedProfiles.map(p => p.id) } } }), testMedProfiles.length);
  await safeDelete('shopper profiles', () => db.shopperProfile.deleteMany({ where: { id: { in: testShopProfiles.map(p => p.id) } } }), testShopProfiles.length);
  await safeDelete('brands', () => db.brand.deleteMany({ where: { id: { in: testBrands.map(b => b.id) } } }), testBrands.length);
  await safeDelete('agencies', () => db.agency.deleteMany({ where: { id: { in: testAgencies.map(a => a.id) } } }), testAgencies.length);

  // Finally delete the test users themselves
  await safeDelete('test users', () => db.user.deleteMany({ where: { id: { in: testUserIds } } }), testUserIds.length);

  // ─── Step 4: Summary ──────────────────────────────────────────────────────
  const remainingUsers = await db.user.count({ where: { isDeleted: false } });
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  ✅ Test data cleanup complete`);
  console.log(`  Remaining active users: ${remainingUsers}`);
  console.log(`═══════════════════════════════════════════════════\n`);
}

main().catch((err) => {
  console.error('❌ Cleanup failed:', err);
  process.exit(1);
});
