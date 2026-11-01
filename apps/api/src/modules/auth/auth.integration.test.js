import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { prisma as appPrisma } from '../../config/database.js';
import {
  hashPassword,
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE,
  verifyPassword,
} from './security.js';
import { app } from '../../app.js';

const authIntegration = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});
const prisma = new PrismaClient({ adapter });
const email = `auth-${randomUUID()}@example.test`;
const registrationEmail = `signup-${randomUUID()}@example.test`;
const password = 'correct horse battery staple';
let user;
let registration;

authIntegration('authentication API', () => {
  beforeAll(async () => {
    await prisma.$connect();
    user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
    });
  });

  afterAll(async () => {
    if (registration) {
      await prisma.societyMembership.deleteMany({
        where: { userId: registration.userId, societyId: registration.societyId },
      });
      await prisma.session.deleteMany({ where: { userId: registration.userId } });
      await prisma.auditLog.deleteMany({ where: { societyId: registration.societyId } });
      await prisma.society.deleteMany({ where: { id: registration.societyId } });
      await prisma.user.deleteMany({ where: { id: registration.userId } });
    }
    if (user) await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('requires email verification before sign-in and verifies a new society administrator', async () => {
    const browser = request.agent(app);
    const response = await browser
      .post('/api/v1/auth/register')
      .set('Origin', env.WEB_ORIGIN)
      .send({
        email: registrationEmail,
        password: 'secure-registration-password',
        societyName: `Signup Society ${randomUUID().slice(0, 8)}`,
        city: 'Pune',
      });

    expect(response.status).toBe(201);
    expect(response.body.requiresEmailVerification).toBe(true);
    expect(response.headers['set-cookie']).toBeUndefined();
    const verificationToken = new URL(response.body.previewUrl).searchParams.get('token');

    const userRecord = await prisma.user.findUnique({ where: { email: registrationEmail } });
    const membership = await prisma.societyMembership.findFirst({
      where: { userId: userRecord.id, active: true },
      include: { society: true },
    });
    expect(userRecord.passwordHash).toMatch(/^\$argon2id\$/);
    expect(userRecord.emailVerifiedAt).toBeNull();
    expect(membership).toMatchObject({ role: 'SOCIETY_ADMIN', society: { city: 'Pune' } });
    registration = { userId: userRecord.id, societyId: membership.societyId };
    const savedVerification = await prisma.emailVerificationToken.findFirst({
      where: { userId: userRecord.id },
    });
    expect(savedVerification.tokenHash).not.toBe(verificationToken);
    expect(savedVerification.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const earlyLogin = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', env.WEB_ORIGIN)
      .send({ email: registrationEmail, password: 'secure-registration-password' });
    expect(earlyLogin.status).toBe(403);
    expect(earlyLogin.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const verification = await browser
      .post('/api/v1/auth/email-verification/confirm')
      .set('Origin', env.WEB_ORIGIN)
      .send({ token: verificationToken });
    expect(verification.status).toBe(200);
    expect(verification.body.user.email).toBe(registrationEmail);
    expect(verification.body.user.memberships).toEqual([
      expect.objectContaining({ societyId: membership.societyId, role: 'SOCIETY_ADMIN' }),
    ]);
    expect(verification.headers['set-cookie'].join(';')).toContain('HttpOnly');

    const reusedLink = await request(app)
      .post('/api/v1/auth/email-verification/confirm')
      .set('Origin', env.WEB_ORIGIN)
      .send({ token: verificationToken });
    expect(reusedLink.status).toBe(400);

    const profile = await browser.get('/api/v1/auth/me');
    expect(profile.status).toBe(200);
    expect(profile.body.user.memberships).toEqual([
      expect.objectContaining({ societyId: membership.societyId, role: 'SOCIETY_ADMIN' }),
    ]);
  });

  it('rejects cross-origin login attempts', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://attacker.example')
      .send({ email, password });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORIGIN_REJECTED');
  });

  it('logs in, returns a CSRF token, requires it to log out, and revokes the session', async () => {
    const browser = request.agent(app);
    const origin = env.WEB_ORIGIN;
    const login = await browser.post('/api/v1/auth/login').set('Origin', origin).send({
      email: email.toUpperCase(),
      password,
    });

    expect(login.status).toBe(200);
    expect(login.body.user).toEqual({
      id: user.id,
      email,
      platformRole: 'USER',
      memberships: [],
    });
    expect(login.body).not.toHaveProperty('sessionToken');
    expect(login.headers['set-cookie'].join(';')).toContain('HttpOnly');
    expect(login.headers['set-cookie'].join(';')).toContain('SameSite=Lax');

    const me = await browser.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
    expect(me.body.csrfToken).toBe(login.body.csrfToken);

    const csrfRejected = await browser.post('/api/v1/auth/logout').set('Origin', origin);
    expect(csrfRejected.status).toBe(403);

    const logout = await browser
      .post('/api/v1/auth/logout')
      .set('Origin', origin)
      .set('X-CSRF-Token', login.body.csrfToken);
    expect(logout.status).toBe(204);

    const afterLogout = await browser.get('/api/v1/auth/me');
    expect(afterLogout.status).toBe(401);
  });

  it('rejects and removes an expired session', async () => {
    const token = createSessionToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${token}`);

    expect(response.status).toBe(401);
    await expect(
      prisma.session.findUnique({ where: { tokenHash: hashSessionToken(token) } }),
    ).resolves.toBeNull();
  });

  it('returns one generic response for an invalid password', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', env.WEB_ORIGIN)
      .send({ email, password: 'incorrect password' });

    expect(response.status).toBe(401);
    expect(response.body.error).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect',
    });
  });

  it('resets a password once, stores only a token hash, and revokes active sessions', async () => {
    const browser = request.agent(app);
    const resetSession = createSessionToken();
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(resetSession),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const requested = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .set('Origin', env.WEB_ORIGIN)
      .send({ email: email.toUpperCase() });
    expect(requested.status).toBe(202);
    expect(requested.body.message).toMatch(/If an active account exists/);
    const resetToken = new URL(requested.body.previewUrl).searchParams.get('token');
    expect(resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await prisma.passwordResetToken.findUnique({ where: { tokenHash: resetToken } }),
    ).toBeNull();

    const storedToken = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(storedToken.tokenHash).not.toBe(resetToken);
    expect(storedToken.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const newPassword = 'new correct horse battery staple';
    const confirmed = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .set('Origin', env.WEB_ORIGIN)
      .send({ token: resetToken, password: newPassword });
    expect(confirmed.status).toBe(200);
    expect(
      await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(resetSession) } }),
    ).toBeNull();
    expect(
      await verifyPassword(
        (await prisma.user.findUnique({ where: { id: user.id } })).passwordHash,
        newPassword,
      ),
    ).toBe(true);

    const reused = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .set('Origin', env.WEB_ORIGIN)
      .send({ token: resetToken, password: 'another replacement password' });
    expect(reused.status).toBe(400);

    const login = await browser.post('/api/v1/auth/login').set('Origin', env.WEB_ORIGIN).send({
      email,
      password: newPassword,
    });
    expect(login.status).toBe(200);
    await browser
      .post('/api/v1/auth/logout')
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', login.body.csrfToken);
  });
});
