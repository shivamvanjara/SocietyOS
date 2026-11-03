import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../config/database.js';
import {
  createCsrfToken,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  tokensMatch,
  verifyPassword,
} from './security.js';
import { sendEmailVerificationEmail, sendPasswordResetEmail } from './email.js';
import {
  createTotpSecret,
  decryptTotpSecret,
  encryptTotpSecret,
  hashMfaChallenge,
  matchTotpStep,
  verifyTotpCode,
} from './mfa.js';

const router = express.Router();
const loginSchema = z
  .object({
    email: z.email().trim().toLowerCase(),
    password: z.string().min(1).max(128),
  })
  .strict();

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const registrationRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const passwordRecoveryRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const mfaManagementRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const baseRegistrationSchema = z
  .object({
    email: z.email().trim().toLowerCase(),
    password: z.string().min(12).max(128),
  })
  .strict();
const societyRegistrationSchema = baseRegistrationSchema
  .extend({
    societyName: z.string().trim().min(2).max(160),
    city: z.string().trim().max(100).optional(),
  })
  .strict();
const invitationRegistrationSchema = baseRegistrationSchema
  .extend({ inviteCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const registrationSchema = z.union([societyRegistrationSchema, invitationRegistrationSchema]);
const passwordResetRequestSchema = z.object({ email: z.email().trim().toLowerCase() }).strict();
const passwordResetSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: z.string().min(12).max(128),
  })
  .strict();
const emailVerificationRequestSchema = z.object({ email: z.email().trim().toLowerCase() }).strict();
const emailVerificationSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const mfaEnrollSchema = z.object({ password: z.string().min(1).max(128) }).strict();
const mfaDisableSchema = z
  .object({ password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/) })
  .strict();
const mfaLoginCookie = env.NODE_ENV === 'production' ? '__Host-societyos_mfa' : 'societyos_mfa';
const MFA_LOGIN_TTL_MS = 5 * 60 * 1000;
const MFA_ENROLL_TTL_MS = 15 * 60 * 1000;

function hashInvitationCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

async function issueEmailVerification(email, userId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashInvitationCode(token);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.$transaction(async (transaction) => {
    await transaction.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await transaction.emailVerificationToken.create({ data: { userId, tokenHash, expiresAt } });
  });
  const url = new URL('/verify-email', env.WEB_ORIGIN);
  url.searchParams.set('token', token);
  const emailDelivery = await sendEmailVerificationEmail(email, url.toString());
  return { tokenHash, ...emailDelivery };
}

let dummyPasswordHash;

function getDummyPasswordHash() {
  dummyPasswordHash ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyPasswordHash;
}

function getSessionCookie(request) {
  const header = request.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function setSessionCookie(response, token, maxAge) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

function clearSessionCookie(response) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

function setMfaLoginCookie(response, token) {
  response.cookie(mfaLoginCookie, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: MFA_LOGIN_TTL_MS,
  });
}

function clearMfaLoginCookie(response) {
  response.clearCookie(mfaLoginCookie, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

function getMfaLoginToken(request) {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== mfaLoginCookie) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function isMfaEligible(db, user) {
  if (user.platformRole === 'SUPER_ADMIN') return true;
  return Boolean(
    await db.societyMembership.findFirst({
      where: {
        userId: user.id,
        active: true,
        role: 'SOCIETY_ADMIN',
        society: { status: 'ACTIVE' },
      },
      select: { id: true },
    }),
  );
}

async function auditMfaChange(transaction, userId, eventType) {
  const memberships = await transaction.societyMembership.findMany({
    where: { userId, active: true, society: { status: 'ACTIVE' } },
    select: { societyId: true },
  });
  if (memberships.length) {
    await transaction.auditLog.createMany({
      data: memberships.map(({ societyId }) => ({
        societyId,
        actorUserId: userId,
        eventType,
        resourceType: 'USER_SECURITY',
        resourceId: userId,
      })),
    });
  }
}

function requireSameOrigin(request, response, next) {
  if (request.get('origin') !== env.WEB_ORIGIN) {
    return response.status(403).json({
      error: { code: 'ORIGIN_REJECTED', message: 'Request origin is not allowed' },
    });
  }
  next();
}

export async function requireAuthenticated(request, response, next) {
  const token = getSessionCookie(request);
  if (!token) {
    return response.status(401).json({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  }

  try {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: {
        user: {
          select: { id: true, email: true, platformRole: true, status: true },
        },
      },
    });

    if (!session || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
      if (session) await prisma.session.deleteMany({ where: { id: session.id } });
      clearSessionCookie(response);
      return response.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
      });
    }

    request.auth = {
      sessionId: session.id,
      user: session.user,
      csrfToken: createCsrfToken(token),
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireCsrf(request, response, next) {
  if (!request.auth || request.get('origin') !== env.WEB_ORIGIN) {
    return response.status(403).json({
      error: { code: 'CSRF_REJECTED', message: 'Request verification failed' },
    });
  }

  if (!tokensMatch(request.get('x-csrf-token'), request.auth.csrfToken)) {
    return response.status(403).json({
      error: { code: 'CSRF_REJECTED', message: 'Request verification failed' },
    });
  }
  next();
}

function publicUser(user, memberships = []) {
  return {
    id: user.id,
    email: user.email,
    platformRole: user.platformRole,
    memberships,
  };
}

router.post(
  '/register',
  registrationRateLimit,
  requireSameOrigin,
  async (request, response, next) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message:
            'Enter a valid email, a password with at least 12 characters, and a society name',
        },
      });
    }

    try {
      if ('inviteCode' in parsed.data) {
        const { email, password, inviteCode } = parsed.data;
        const passwordHash = await hashPassword(password);
        const invitationResult = await prisma.$transaction(async (transaction) => {
          const invitation = await transaction.societyInvitation.findFirst({
            where: {
              tokenHash: hashInvitationCode(inviteCode),
              email,
              acceptedAt: null,
              expiresAt: { gt: new Date() },
              society: { status: 'ACTIVE' },
            },
            select: { id: true, societyId: true, role: true, society: { select: { name: true } } },
          });
          if (!invitation) return null;
          const claimed = await transaction.societyInvitation.updateMany({
            where: { id: invitation.id, acceptedAt: null, expiresAt: { gt: new Date() } },
            data: { acceptedAt: new Date() },
          });
          if (!claimed.count) return null;
          const createdUser = await transaction.user.create({
            data: { email, passwordHash, emailVerifiedAt: null },
            select: { id: true, email: true, platformRole: true },
          });
          const membership = await transaction.societyMembership.create({
            data: {
              userId: createdUser.id,
              societyId: invitation.societyId,
              role: invitation.role,
            },
          });
          await transaction.auditLog.create({
            data: {
              societyId: invitation.societyId,
              actorUserId: createdUser.id,
              eventType: 'ACCOUNT_REGISTERED',
              resourceType: 'SOCIETY_MEMBERSHIP',
              resourceId: membership.id,
            },
          });
          return { user: createdUser, invitation, membership };
        });
        if (!invitationResult) {
          return response.status(404).json({
            error: {
              code: 'INVITATION_NOT_FOUND',
              message: 'This invitation is invalid, expired, or belongs to another email address',
            },
          });
        }
        const verification = await issueEmailVerification(email, invitationResult.user.id);
        return response.status(201).json({
          requiresEmailVerification: true,
          message: 'Account created. Verify your email address to sign in.',
          ...(verification.previewUrl ? { previewUrl: verification.previewUrl } : {}),
        });
      }
      const { email, password, societyName, city } = parsed.data;
      const passwordHash = await hashPassword(password);

      const user = await prisma.$transaction(async (transaction) => {
        const createdUser = await transaction.user.create({
          data: { email, passwordHash, emailVerifiedAt: null },
          select: { id: true, email: true, platformRole: true },
        });
        const uniqueSuffix = randomBytes(4).toString('hex');
        const baseSlug =
          societyName
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 90)
            .replace(/-+$/g, '') || 'community';
        const society = await transaction.society.create({
          data: { name: societyName, city: city || null, slug: `${baseSlug}-${uniqueSuffix}` },
          select: { id: true, name: true },
        });
        await transaction.societyMembership.create({
          data: { userId: createdUser.id, societyId: society.id, role: 'SOCIETY_ADMIN' },
        });
        return { ...createdUser, society };
      });
      const verification = await issueEmailVerification(email, user.id);
      return response.status(201).json({
        requiresEmailVerification: true,
        message: 'Account created. Verify your email address to sign in.',
        ...(verification.previewUrl ? { previewUrl: verification.previewUrl } : {}),
      });
    } catch (error) {
      if (error?.code === 'P2002') {
        return response.status(409).json({
          error: {
            code: 'ACCOUNT_ALREADY_EXISTS',
            message: 'An account with this email already exists',
          },
        });
      }
      next(error);
    }
  },
);

router.post(
  '/email-verification/request',
  passwordRecoveryRateLimit,
  requireSameOrigin,
  async (request, response, next) => {
    const parsed = emailVerificationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email address' },
      });
    }

    let verificationTokenHash;
    try {
      const user = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true, email: true, status: true, emailVerifiedAt: true },
      });
      let previewUrl;
      if (user?.status === 'ACTIVE' && !user.emailVerifiedAt) {
        const verification = await issueEmailVerification(user.email, user.id);
        verificationTokenHash = verification.tokenHash;
        previewUrl = verification.previewUrl;
      }
      return response.status(202).json({
        message: 'If the account needs verification, a verification link has been sent.',
        ...(previewUrl ? { previewUrl } : {}),
      });
    } catch (error) {
      if (verificationTokenHash) {
        await prisma.emailVerificationToken
          .deleteMany({ where: { tokenHash: verificationTokenHash } })
          .catch(() => {});
      }
      next(error);
    }
  },
);

router.post(
  '/email-verification/confirm',
  passwordRecoveryRateLimit,
  requireSameOrigin,
  async (request, response, next) => {
    const parsed = emailVerificationSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Use a valid email verification link' },
      });
    }

    try {
      const tokenHash = hashInvitationCode(parsed.data.token);
      const sessionToken = createSessionToken();
      const now = new Date();
      const result = await prisma.$transaction(async (transaction) => {
        const verification = await transaction.emailVerificationToken.findUnique({
          where: { tokenHash },
          select: { id: true, userId: true, expiresAt: true, usedAt: true },
        });
        if (!verification || verification.usedAt || verification.expiresAt <= now) return null;

        const claimed = await transaction.emailVerificationToken.updateMany({
          where: { id: verification.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (!claimed.count) return null;

        const user = await transaction.user.update({
          where: { id: verification.userId, status: 'ACTIVE' },
          data: { emailVerifiedAt: now },
          select: { id: true, email: true, platformRole: true },
        });
        await transaction.session.create({
          data: {
            userId: user.id,
            tokenHash: hashSessionToken(sessionToken),
            expiresAt: new Date(Date.now() + SESSION_TTL_MS),
          },
        });
        const memberships = await transaction.societyMembership.findMany({
          where: { userId: user.id, active: true, society: { status: 'ACTIVE' } },
          select: { id: true, societyId: true, role: true, society: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        });
        if (memberships.length) {
          await transaction.auditLog.createMany({
            data: memberships.map((membership) => ({
              societyId: membership.societyId,
              actorUserId: user.id,
              eventType: 'EMAIL_VERIFIED',
              resourceType: 'SOCIETY_MEMBERSHIP',
              resourceId: membership.id,
            })),
          });
        }
        return {
          user: publicUser(
            user,
            memberships.map(({ society, id: _membershipId, ...membership }) => ({
              ...membership,
              societyName: society.name,
            })),
          ),
        };
      });

      if (!result) {
        return response.status(400).json({
          error: {
            code: 'VERIFICATION_LINK_INVALID',
            message: 'This verification link is invalid or expired. Request a new one.',
          },
        });
      }
      setSessionCookie(response, sessionToken, SESSION_TTL_MS);
      return response
        .status(200)
        .json({ user: result.user, csrfToken: createCsrfToken(sessionToken) });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/password-reset/request',
  passwordRecoveryRateLimit,
  requireSameOrigin,
  async (request, response, next) => {
    const parsed = passwordResetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email address' },
      });
    }

    let resetToken;
    try {
      const user = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true, email: true, status: true },
      });
      let previewUrl;
      if (user?.status === 'ACTIVE') {
        resetToken = randomBytes(32).toString('base64url');
        const tokenHash = hashInvitationCode(resetToken);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        await prisma.$transaction([
          prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
          prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } }),
        ]);
        const resetUrl = new URL('/reset-password', env.WEB_ORIGIN);
        resetUrl.searchParams.set('token', resetToken);
        ({ previewUrl } = await sendPasswordResetEmail(user.email, resetUrl.toString()));
      }

      return response.status(202).json({
        message:
          'If an active account exists for that address, a password reset link has been sent.',
        ...(previewUrl ? { previewUrl } : {}),
      });
    } catch (error) {
      if (resetToken) {
        await prisma.passwordResetToken
          .deleteMany({ where: { tokenHash: hashInvitationCode(resetToken) } })
          .catch(() => {});
      }
      if (error?.name === 'TimeoutError' || error?.name === 'TypeError') {
        return response.status(503).json({
          error: {
            code: 'EMAIL_UNAVAILABLE',
            message: 'Password reset email is temporarily unavailable. Try again shortly.',
          },
        });
      }
      if (error.message?.startsWith('Email provider rejected')) {
        return response.status(503).json({
          error: {
            code: 'EMAIL_UNAVAILABLE',
            message: 'Password reset email is temporarily unavailable. Try again shortly.',
          },
        });
      }
      next(error);
    }
  },
);

router.post(
  '/password-reset/confirm',
  passwordRecoveryRateLimit,
  requireSameOrigin,
  async (request, response, next) => {
    const parsed = passwordResetSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Use a valid reset link and a password with at least 12 characters',
        },
      });
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const tokenHash = hashInvitationCode(parsed.data.token);
      const changed = await prisma.$transaction(async (transaction) => {
        const reset = await transaction.passwordResetToken.findUnique({
          where: { tokenHash },
          select: { id: true, userId: true, expiresAt: true, usedAt: true },
        });
        if (!reset || reset.usedAt || reset.expiresAt <= new Date()) return false;

        const now = new Date();
        const claimed = await transaction.passwordResetToken.updateMany({
          where: { id: reset.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (!claimed.count) return false;

        await transaction.user.update({ where: { id: reset.userId }, data: { passwordHash } });
        await transaction.session.deleteMany({ where: { userId: reset.userId } });
        await transaction.mfaLoginChallenge.deleteMany({ where: { userId: reset.userId } });
        await transaction.passwordResetToken.updateMany({
          where: { userId: reset.userId, id: { not: reset.id }, usedAt: null },
          data: { usedAt: now },
        });
        return true;
      });
      if (!changed) {
        return response.status(400).json({
          error: {
            code: 'RESET_LINK_INVALID',
            message: 'This reset link is invalid or has expired. Request a new one.',
          },
        });
      }
      return response
        .status(200)
        .json({ message: 'Password updated. Sign in with your new password.' });
    } catch (error) {
      next(error);
    }
  },
);

router.get('/mfa', requireAuthenticated, async (request, response, next) => {
  try {
    const [eligible, account] = await Promise.all([
      isMfaEligible(prisma, request.auth.user),
      prisma.user.findUnique({
        where: { id: request.auth.user.id },
        select: { mfaEnabledAt: true },
      }),
    ]);
    return response.status(200).json({ eligible, enabled: Boolean(account?.mfaEnabledAt) });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/mfa/enroll',
  mfaManagementRateLimit,
  requireAuthenticated,
  requireCsrf,
  async (request, response, next) => {
    const parsed = mfaEnrollSchema.safeParse(request.body);
    if (!parsed.success)
      return response
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'Enter your password to continue' } });
    try {
      if (!(await isMfaEligible(prisma, request.auth.user)))
        return response
          .status(403)
          .json({ error: { code: 'FORBIDDEN', message: 'Administrator access is required' } });
      const account = await prisma.user.findUnique({
        where: { id: request.auth.user.id },
        select: { passwordHash: true, mfaEnabledAt: true },
      });
      if (!account || !(await verifyPassword(account.passwordHash, parsed.data.password)))
        return response.status(401).json({
          error: { code: 'REAUTHENTICATION_REQUIRED', message: 'Your password is incorrect' },
        });
      if (account.mfaEnabledAt)
        return response.status(409).json({
          error: {
            code: 'MFA_ALREADY_ENABLED',
            message: 'Multi-factor authentication is already enabled',
          },
        });
      const secret = createTotpSecret();
      const expiresAt = new Date(Date.now() + MFA_ENROLL_TTL_MS);
      await prisma.user.update({
        where: { id: request.auth.user.id },
        data: {
          mfaPendingSecretEncrypted: encryptTotpSecret(secret),
          mfaPendingExpiresAt: expiresAt,
        },
      });
      const label = encodeURIComponent(`SocietyOS:${request.auth.user.email}`);
      const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=SocietyOS&algorithm=SHA1&digits=6&period=30`;
      response.set('Cache-Control', 'private, no-store');
      return response.status(201).json({ secret, otpauthUrl, expiresAt });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/mfa/confirm',
  mfaManagementRateLimit,
  requireAuthenticated,
  requireCsrf,
  async (request, response, next) => {
    const parsed = mfaCodeSchema.safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Enter the six-digit code from your authenticator app',
        },
      });
    try {
      const result = await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT id FROM users WHERE id = ${request.auth.user.id}::uuid FOR UPDATE`;
        const account = await transaction.user.findUnique({
          where: { id: request.auth.user.id },
          select: {
            mfaEnabledAt: true,
            mfaPendingSecretEncrypted: true,
            mfaPendingExpiresAt: true,
          },
        });
        if (account?.mfaEnabledAt) return 'already_enabled';
        if (
          !account?.mfaPendingSecretEncrypted ||
          !account.mfaPendingExpiresAt ||
          account.mfaPendingExpiresAt <= new Date()
        )
          return 'expired';
        const secret = decryptTotpSecret(account.mfaPendingSecretEncrypted);
        const step = matchTotpStep(secret, parsed.data.code);
        if (step === null) return 'invalid_code';
        const now = new Date();
        await transaction.user.update({
          where: { id: request.auth.user.id },
          data: {
            mfaSecretEncrypted: account.mfaPendingSecretEncrypted,
            mfaEnabledAt: now,
            mfaLastUsedStep: BigInt(step),
            mfaPendingSecretEncrypted: null,
            mfaPendingExpiresAt: null,
          },
        });
        await transaction.session.deleteMany({
          where: { userId: request.auth.user.id, id: { not: request.auth.sessionId } },
        });
        await auditMfaChange(transaction, request.auth.user.id, 'MFA_ENABLED');
        return 'enabled';
      });
      if (result === 'expired')
        return response.status(400).json({
          error: {
            code: 'MFA_ENROLLMENT_EXPIRED',
            message: 'Start multi-factor setup again; this setup has expired',
          },
        });
      if (result === 'invalid_code')
        return response.status(400).json({
          error: {
            code: 'INVALID_MFA_CODE',
            message:
              'That code is incorrect or expired. Try the current code from your authenticator app.',
          },
        });
      if (result === 'already_enabled')
        return response.status(409).json({
          error: {
            code: 'MFA_ALREADY_ENABLED',
            message: 'Multi-factor authentication is already enabled',
          },
        });
      return response.status(200).json({ enabled: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/mfa/disable',
  mfaManagementRateLimit,
  requireAuthenticated,
  requireCsrf,
  async (request, response, next) => {
    const parsed = mfaDisableSchema.safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Enter your password and six-digit authenticator code',
        },
      });
    try {
      const account = await prisma.user.findUnique({
        where: { id: request.auth.user.id },
        select: { passwordHash: true, mfaEnabledAt: true, mfaSecretEncrypted: true },
      });
      if (!account?.mfaEnabledAt || !account.mfaSecretEncrypted)
        return response.status(409).json({
          error: {
            code: 'MFA_NOT_ENABLED',
            message: 'Multi-factor authentication is not enabled',
          },
        });
      if (!(await verifyPassword(account.passwordHash, parsed.data.password)))
        return response.status(401).json({
          error: { code: 'REAUTHENTICATION_REQUIRED', message: 'Your password is incorrect' },
        });
      if (!verifyTotpCode(decryptTotpSecret(account.mfaSecretEncrypted), parsed.data.code))
        return response.status(401).json({
          error: {
            code: 'INVALID_MFA_CODE',
            message: 'That authenticator code is incorrect or expired',
          },
        });
      await prisma.$transaction(async (transaction) => {
        await transaction.user.update({
          where: { id: request.auth.user.id },
          data: {
            mfaSecretEncrypted: null,
            mfaEnabledAt: null,
            mfaLastUsedStep: null,
            mfaPendingSecretEncrypted: null,
            mfaPendingExpiresAt: null,
          },
        });
        await transaction.session.deleteMany({
          where: { userId: request.auth.user.id, id: { not: request.auth.sessionId } },
        });
        await transaction.mfaLoginChallenge.deleteMany({ where: { userId: request.auth.user.id } });
        await auditMfaChange(transaction, request.auth.user.id, 'MFA_DISABLED');
      });
      return response.status(200).json({ enabled: false });
    } catch (error) {
      next(error);
    }
  },
);

router.post('/login', loginRateLimit, requireSameOrigin, async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Enter a valid email and password',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      },
    });
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  const candidateHash = user?.passwordHash ?? (await getDummyPasswordHash());
  const passwordIsValid = await verifyPassword(candidateHash, password);

  if (!user || user.status !== 'ACTIVE' || !passwordIsValid) {
    return response.status(401).json({
      error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' },
    });
  }
  if (!user.emailVerifiedAt) {
    return response.status(403).json({
      error: {
        code: 'EMAIL_NOT_VERIFIED',
        message:
          'Verify your email address before signing in. You can request a new verification link.',
      },
    });
  }

  if (user.mfaEnabledAt) {
    const challengeToken = randomBytes(32).toString('base64url');
    await prisma.mfaLoginChallenge.deleteMany({ where: { userId: user.id } });
    await prisma.mfaLoginChallenge.create({
      data: {
        userId: user.id,
        tokenHash: hashMfaChallenge(challengeToken),
        expiresAt: new Date(Date.now() + MFA_LOGIN_TTL_MS),
      },
    });
    setMfaLoginCookie(response, challengeToken);
    response.set('Cache-Control', 'no-store');
    return response.status(200).json({
      requiresMfa: true,
      message: 'Enter the current six-digit code from your authenticator app.',
    });
  }

  const existingToken = getSessionCookie(request);
  if (existingToken) {
    await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(existingToken) } });
  }

  const sessionToken = createSessionToken();
  const csrfToken = createCsrfToken(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(sessionToken),
      expiresAt,
    },
  });

  clearMfaLoginCookie(response);
  setSessionCookie(response, sessionToken, SESSION_TTL_MS);
  return response.status(200).json({ user: publicUser(user), csrfToken });
});

router.post('/mfa/verify', loginRateLimit, requireSameOrigin, async (request, response, next) => {
  const parsed = mfaCodeSchema.safeParse(request.body);
  if (!parsed.success)
    return response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Enter the six-digit code from your authenticator app',
      },
    });
  const challengeToken = getMfaLoginToken(request);
  if (!challengeToken) {
    clearMfaLoginCookie(response);
    return response.status(401).json({
      error: {
        code: 'MFA_CHALLENGE_INVALID',
        message: 'Sign in again to verify your authenticator code',
      },
    });
  }

  try {
    const existingToken = getSessionCookie(request);
    const result = await prisma.$transaction(async (transaction) => {
      const tokenHash = hashMfaChallenge(challengeToken);
      const challenge = await transaction.mfaLoginChallenge.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, expiresAt: true, usedAt: true },
      });
      if (!challenge || challenge.usedAt || challenge.expiresAt <= new Date()) return 'invalid';
      const account = await transaction.user.findUnique({
        where: { id: challenge.userId },
        select: {
          id: true,
          email: true,
          platformRole: true,
          status: true,
          emailVerifiedAt: true,
          mfaEnabledAt: true,
          mfaSecretEncrypted: true,
          mfaLastUsedStep: true,
        },
      });
      if (
        !account ||
        account.status !== 'ACTIVE' ||
        !account.emailVerifiedAt ||
        !account.mfaEnabledAt ||
        !account.mfaSecretEncrypted
      )
        return 'invalid';
      const step = matchTotpStep(decryptTotpSecret(account.mfaSecretEncrypted), parsed.data.code);
      if (
        step === null ||
        (account.mfaLastUsedStep !== null && BigInt(step) <= account.mfaLastUsedStep)
      )
        return 'incorrect';

      await transaction.$queryRaw`SELECT id FROM mfa_login_challenges WHERE id = ${challenge.id}::uuid FOR UPDATE`;
      const updatedStep = await transaction.user.updateMany({
        where: {
          id: account.id,
          mfaEnabledAt: { not: null },
          OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: BigInt(step) } }],
        },
        data: { mfaLastUsedStep: BigInt(step) },
      });
      if (!updatedStep.count) return 'incorrect';
      const claimed = await transaction.mfaLoginChallenge.updateMany({
        where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (!claimed.count) return 'invalid';
      if (existingToken)
        await transaction.session.deleteMany({
          where: { tokenHash: hashSessionToken(existingToken) },
        });
      const sessionToken = createSessionToken();
      await transaction.session.create({
        data: {
          userId: account.id,
          tokenHash: hashSessionToken(sessionToken),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      });
      const memberships = await transaction.societyMembership.findMany({
        where: { userId: account.id, active: true, society: { status: 'ACTIVE' } },
        select: { societyId: true, role: true, society: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return { account, sessionToken, memberships };
    });
    if (result === 'invalid') {
      clearMfaLoginCookie(response);
      return response.status(401).json({
        error: {
          code: 'MFA_CHALLENGE_INVALID',
          message: 'Sign in again to verify your authenticator code',
        },
      });
    }
    if (result === 'incorrect')
      return response.status(401).json({
        error: {
          code: 'INVALID_MFA_CODE',
          message: 'That authenticator code is incorrect or expired',
        },
      });
    clearMfaLoginCookie(response);
    setSessionCookie(response, result.sessionToken, SESSION_TTL_MS);
    return response.status(200).json({
      user: publicUser(
        result.account,
        result.memberships.map(({ society, ...membership }) => ({
          ...membership,
          societyName: society.name,
        })),
      ),
      csrfToken: createCsrfToken(result.sessionToken),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', requireSameOrigin, async (request, response) => {
  const token = getSessionCookie(request);
  if (token) {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
    });
    if (session && !tokensMatch(request.get('x-csrf-token'), createCsrfToken(token))) {
      return response.status(403).json({
        error: { code: 'CSRF_REJECTED', message: 'Request verification failed' },
      });
    }
    if (session) await prisma.session.deleteMany({ where: { id: session.id } });
  }

  clearSessionCookie(response);
  return response.status(204).end();
});

router.get('/me', requireAuthenticated, async (request, response, next) => {
  try {
    const memberships = await prisma.societyMembership.findMany({
      where: { userId: request.auth.user.id, active: true },
      select: {
        societyId: true,
        role: true,
        society: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return response.status(200).json({
      user: publicUser(
        request.auth.user,
        memberships.map(({ society, ...membership }) => ({
          ...membership,
          societyName: society.name,
        })),
      ),
      csrfToken: request.auth.csrfToken,
    });
  } catch (error) {
    next(error);
  }
});

router.use(requireAuthenticated, requireCsrf);

export const authRouter = router;
