import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const emailMocks = vi.hoisted(() => ({
  sendEmailVerificationEmail: vi.fn(async (_email, actionUrl) => ({ previewUrl: actionUrl })),
  sendPasswordResetEmail: vi.fn(async (_email, actionUrl) => ({ previewUrl: actionUrl })),
  sendSocietyInvitationEmail: vi.fn().mockResolvedValue({}),
  sendGateApprovalEmail: vi.fn().mockResolvedValue({}),
}));

vi.mock('./email.js', () => emailMocks);

import { env } from '../../config/env.js';
import { hashPassword } from './security.js';
import { app } from '../../app.js';

const databaseTest = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 }),
});
const email = `email-routing-${randomUUID()}@example.test`;
let user;

databaseTest('email recipient database mapping with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword('test-email-recipient-password'),
        emailVerifiedAt: null,
      },
    });
  });

  afterAll(async () => {
    if (user) {
      await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
    await prisma.$disconnect();
  });

  it('uses the stored user email for verification and password-reset recipients', async () => {
    const origin = env.WEB_ORIGIN;
    const verification = await request(app)
      .post('/api/v1/auth/email-verification/request')
      .set('Origin', origin)
      .send({ email: email.toUpperCase() });

    expect(verification.status).toBe(202);
    expect(emailMocks.sendEmailVerificationEmail).toHaveBeenCalledWith(
      user.email,
      expect.stringContaining('/verify-email?token='),
    );

    const reset = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .set('Origin', origin)
      .send({ email: email.toUpperCase() });

    expect(reset.status).toBe(202);
    expect(emailMocks.sendPasswordResetEmail).toHaveBeenCalledWith(
      user.email,
      expect.stringContaining('/reset-password?token='),
    );
  });
});
