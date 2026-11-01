import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { prisma as appPrisma } from '../../config/database.js';
import { createTotpCode, hashMfaChallenge } from './mfa.js';
import { hashPassword, SESSION_COOKIE } from './security.js';
import { app } from '../../app.js';

const databaseTest = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 }),
});
const email = `mfa-${randomUUID()}@example.test`;
const password = 'admin-mfa-integration-password';
let user;
let challengeToken;

databaseTest('administrator MFA with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        platformRole: 'SUPER_ADMIN',
        emailVerifiedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (user) {
      await prisma.mfaLoginChallenge.deleteMany({ where: { userId: user.id } });
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('enrolls, challenges sign-in, verifies TOTP, and securely disables MFA', async () => {
    const browser = request.agent(app);
    const origin = env.WEB_ORIGIN;
    const initialLogin = await browser
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ email, password });
    expect(initialLogin.status).toBe(200);
    expect(initialLogin.body.requiresMfa).toBeUndefined();
    const profile = await browser.get('/api/v1/auth/me');
    expect(profile.status).toBe(200);
    const authCsrf = profile.body.csrfToken;
    const status = await browser.get('/api/v1/auth/mfa');
    expect(status.body).toEqual({ eligible: true, enabled: false });

    const enrollment = await browser
      .post('/api/v1/auth/mfa/enroll')
      .set('Origin', origin)
      .set('X-CSRF-Token', authCsrf)
      .send({ password });
    expect(enrollment.status).toBe(201);
    expect(enrollment.body.secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(enrollment.body.otpauthUrl).toContain('otpauth://totp/');
    const storedPending = await prisma.user.findUnique({ where: { id: user.id } });
    expect(storedPending.mfaPendingSecretEncrypted).not.toContain(enrollment.body.secret);

    const enabled = await browser
      .post('/api/v1/auth/mfa/confirm')
      .set('Origin', origin)
      .set('X-CSRF-Token', authCsrf)
      .send({ code: createTotpCode(enrollment.body.secret) });
    expect(enabled.status).toBe(200);
    const storedEnabled = await prisma.user.findUnique({ where: { id: user.id } });
    expect(storedEnabled.mfaEnabledAt).toBeInstanceOf(Date);
    expect(storedEnabled.mfaSecretEncrypted).not.toContain(enrollment.body.secret);
    expect(storedEnabled.mfaPendingSecretEncrypted).toBeNull();

    const enrollmentCode = createTotpCode(enrollment.body.secret);
    while (createTotpCode(enrollment.body.secret) === enrollmentCode)
      await new Promise((resolve) => setTimeout(resolve, 200));

    await browser.post('/api/v1/auth/logout').set('Origin', origin).set('X-CSRF-Token', authCsrf);
    const challenged = await browser
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ email, password });
    expect(challenged.status).toBe(200);
    expect(challenged.body.requiresMfa).toBe(true);
    expect(challenged.body).not.toHaveProperty('csrfToken');
    expect(challenged.headers['set-cookie'].join(';')).toContain('HttpOnly');
    expect(challenged.headers['set-cookie'].join(';')).not.toContain(`${SESSION_COOKIE}=`);
    const challengeCookie = challenged.headers['set-cookie'].find((cookie) =>
      cookie.startsWith('societyos_mfa='),
    );
    challengeToken = decodeURIComponent(
      challengeCookie.split(';')[0].slice('societyos_mfa='.length),
    );
    const challengeHash = hashMfaChallenge(challengeToken);

    const invalidCode = await browser
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', origin)
      .send({ code: '000000' });
    expect(invalidCode.status).toBe(401);
    const completed = await browser
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', origin)
      .send({ code: createTotpCode(enrollment.body.secret) });
    expect(completed.status).toBe(200);
    expect(completed.body.user).toMatchObject({ id: user.id, platformRole: 'SUPER_ADMIN' });
    expect(
      await prisma.mfaLoginChallenge.findUnique({ where: { tokenHash: challengeHash } }),
    ).toMatchObject({
      usedAt: expect.any(Date),
    });
    const replayedChallenge = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', origin)
      .set('Cookie', `societyos_mfa=${challengeToken}`)
      .send({ code: createTotpCode(enrollment.body.secret) });
    expect(replayedChallenge.status).toBe(401);

    const secondChallenge = await browser
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ email, password });
    expect(secondChallenge.body.requiresMfa).toBe(true);
    const replayedCode = await browser
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', origin)
      .send({ code: createTotpCode(enrollment.body.secret) });
    expect(replayedCode.status).toBe(401);

    const disabled = await browser
      .post('/api/v1/auth/mfa/disable')
      .set('Origin', origin)
      .set('X-CSRF-Token', completed.body.csrfToken)
      .send({ password, code: createTotpCode(enrollment.body.secret) });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    const storedDisabled = await prisma.user.findUnique({ where: { id: user.id } });
    expect(storedDisabled.mfaEnabledAt).toBeNull();
    expect(storedDisabled.mfaSecretEncrypted).toBeNull();

    const regularLogin = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ email, password });
    expect(regularLogin.status).toBe(200);
    expect(regularLogin.body.requiresMfa).toBeUndefined();
  }, 40_000);
});
