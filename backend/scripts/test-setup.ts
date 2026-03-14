/**
 * Temporary script to set up test data for comprehensive testing.
 * Run with: npx tsx scripts/test-setup.ts
 */
import { connectPrisma, prisma, disconnectPrisma } from '../database/prisma.js';

async function main() {
  await connectPrisma();
  const db = prisma();

  const userId = 'c647a880-6727-4630-a2d4-7f48027f3ecb';

  // 1. Check current user state
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, parentCode: true, mediatorCode: true, status: true },
  });
  console.log('BEFORE:', JSON.stringify(user));

  // 2. Set parentCode to the user's own mediatorCode if not set
  //    (user is both mediator and shopper in this case)
  if (!user?.parentCode && user?.mediatorCode) {
    await db.user.update({
      where: { id: userId },
      data: { parentCode: user.mediatorCode },
    });
    console.log('SET parentCode to:', user.mediatorCode);
  }

  // 3. Check campaigns with this mediator
  const deals = await db.deal.findMany({
    where: { mediatorCode: 'MED_EBE5C4FE' },
    select: { id: true, title: true, dealType: true, campaignId: true, commissionPaise: true },
  });
  console.log('\nDEALS:', JSON.stringify(deals, null, 2));

  // 4. Get campaign data and fix slots
  for (const deal of deals) {
    const campaign = await db.campaign.findUnique({
      where: { id: deal.campaignId },
      select: { id: true, title: true, totalSlots: true, usedSlots: true, status: true, dealType: true },
    });
    console.log(`\nCAMPAIGN ${campaign?.id}: slots=${campaign?.totalSlots}/${campaign?.usedSlots}, status=${campaign?.status}, type=${campaign?.dealType}`);

    // Fix: Set totalSlots to 100 if 0
    if (campaign && campaign.totalSlots === 0) {
      await db.campaign.update({
        where: { id: campaign.id },
        data: { totalSlots: 100 },
      });
      console.log('  -> Fixed totalSlots to 100');
    }

    // Ensure campaign is active
    if (campaign && campaign.status !== 'active') {
      await db.campaign.update({
        where: { id: campaign.id },
        data: { status: 'active' },
      });
      console.log('  -> Set status to active');
    }
  }

  // 5. Verify user after update
  const userAfter = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, parentCode: true, mediatorCode: true, status: true },
  });
  console.log('\nAFTER:', JSON.stringify(userAfter));

  // 6. Check existing orders
  const orders = await db.order.findMany({
    where: { userId, isDeleted: false },
    select: {
      id: true,
      externalOrderId: true,
      workflowStatus: true,
      reviewerName: true,
      screenshotOrder: true,
      screenshotRating: true,
      screenshotReturnWindow: true,
      items: { select: { title: true, dealType: true, priceAtPurchasePaise: true, commissionPaise: true } },
    },
  });
  console.log('\nORDERS:');
  for (const o of orders) {
    console.log(`  ${o.id.substring(0, 8)}... ext=${o.externalOrderId} status=${o.workflowStatus} reviewer=${o.reviewerName} hasOrder=${!!o.screenshotOrder} hasRating=${!!o.screenshotRating} hasRW=${!!o.screenshotReturnWindow} items=${JSON.stringify(o.items)}`);
  }

  await disconnectPrisma();
}

main().catch(console.error);
