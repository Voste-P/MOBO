import { loadDotenv } from '../config/dotenvLoader.js';

loadDotenv();

import { connectPrisma, disconnectPrisma } from '../database/prisma.js';
import { seedE2E } from '../seeds/e2e.js';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ seedE2E is DISABLED in production. Aborting.');
    process.exit(1);
  }
  await connectPrisma();
  await seedE2E();
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
