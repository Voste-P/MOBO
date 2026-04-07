/**
 * Standalone E2E seed runner — used in CI before Playwright tests.
 * Exit 0 on success, 1 on failure.
 */
import 'dotenv/config';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { connectPrisma } from '../database/prisma.js';
import { seedE2E } from './e2e.js';

async function main() {
  await connectPrisma();
  const result = await seedE2E();
  console.log('E2E seed complete:', {
    admin: result.admin.id,
    shopper: result.shopper.id,
    mediator: result.mediator.id,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('E2E seed FAILED:', err);
    process.exit(1);
  });
