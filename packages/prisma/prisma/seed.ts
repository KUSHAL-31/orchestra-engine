import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  const rawKey = 'forge-dev-api-key-12345';
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  await prisma.apiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      keyHash,
      label: 'Development API Key',
    },
  });

  // eslint-disable-next-line no-console
  console.log('Seeded database');
  // eslint-disable-next-line no-console
  console.log(`Dev API Key: Bearer ${rawKey}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
