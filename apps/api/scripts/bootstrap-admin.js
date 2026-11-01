import { z } from 'zod';
import '../src/config/env.js';
import { prisma } from '../src/config/database.js';
import { hashPassword } from '../src/modules/auth/security.js';

const bootstrapSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12).max(128),
});

async function bootstrapAdmin() {
  const { email, password } = bootstrapSchema.parse({
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });

  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext('societyos:bootstrap-admin'))
    `;
    const existingAdmin = await transaction.user.findFirst({
      where: { platformRole: 'SUPER_ADMIN' },
      select: { id: true },
    });
    if (existingAdmin) throw new Error('A platform super administrator already exists');

    await transaction.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        platformRole: 'SUPER_ADMIN',
      },
    });
  });
  console.info('Bootstrap super administrator created.');
}

try {
  await bootstrapAdmin();
} catch {
  console.error('Bootstrap administrator setup failed. Check configuration and database status.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
