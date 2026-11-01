import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';
import { env } from '../../config/env.js';
import { sendSocietyInvitationEmail } from '../auth/email.js';

export const invitationsRouter = express.Router({ mergeParams: true });
const uuid = z.uuid();
const invitationSchema = z
  .object({
    email: z.email().trim().toLowerCase(),
    role: z.enum(['COMMITTEE_MEMBER', 'ACCOUNTANT', 'RESIDENT', 'SECURITY_GUARD']),
  })
  .strict();
const acceptSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function hashCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

async function member(db, societyId, userId) {
  return db.societyMembership.findFirst({
    where: { societyId, userId, active: true, society: { status: 'ACTIVE' } },
    select: { id: true, role: true },
  });
}

invitationsRouter.use(requireAuthenticated);

invitationsRouter.get('/members', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    if ((await member(prisma, societyId.data, req.auth.user.id))?.role !== 'SOCIETY_ADMIN')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const [members, invitations] = await Promise.all([
      prisma.societyMembership.findMany({
        where: { societyId: societyId.data },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          role: true,
          active: true,
          createdAt: true,
          user: { select: { id: true, email: true, status: true } },
        },
      }),
      prisma.societyInvitation.findMany({
        where: { societyId: societyId.data, acceptedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      }),
    ]);
    res.json({ members, invitations });
  } catch (error) {
    next(error);
  }
});

invitationsRouter.post('/', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = invitationSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Enter a valid email and member role');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if ((await member(tx, societyId.data, req.auth.user.id))?.role !== 'SOCIETY_ADMIN')
        return { kind: 'inaccessible' };
      const existingUser = await tx.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true },
      });
      if (existingUser) {
        const existingMembership = await tx.societyMembership.findUnique({
          where: { societyId_userId: { societyId: societyId.data, userId: existingUser.id } },
          select: { id: true, active: true },
        });
        if (existingMembership?.active) return { kind: 'member_exists' };
      }
      const code = randomBytes(32).toString('base64url');
      const society = await tx.society.findUnique({
        where: { id: societyId.data },
        select: { name: true },
      });
      const invitation = await tx.societyInvitation.create({
        data: {
          societyId: societyId.data,
          invitedById: req.auth.user.id,
          email: parsed.data.email,
          role: parsed.data.role,
          tokenHash: hashCode(code),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        select: { id: true, email: true, role: true, expiresAt: true },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'MEMBER_INVITED',
          resourceType: 'SOCIETY_INVITATION',
          resourceId: invitation.id,
        },
      });
      return { kind: 'created', invitation, code, societyName: society.name };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'member_exists')
      return fail(res, 409, 'MEMBER_ALREADY_EXISTS', 'This account already belongs to the society');
    const invitationUrl = new URL('/', env.WEB_ORIGIN);
    invitationUrl.hash = `invite=${encodeURIComponent(result.code)}`;
    let emailSent = true;
    let previewUrl;
    try {
      ({ previewUrl } = await sendSocietyInvitationEmail(
        result.invitation.email,
        invitationUrl.toString(),
        {
          societyName: result.societyName,
          role: result.invitation.role,
          expiresAt: result.invitation.expiresAt,
        },
      ));
    } catch {
      emailSent = false;
    }
    if (previewUrl) emailSent = false;
    res.status(201).json({
      invitation: result.invitation,
      code: result.code,
      emailSent,
      ...(previewUrl ? { previewUrl } : {}),
    });
  } catch (error) {
    next(error);
  }
});

invitationsRouter.post('/accept', requireCsrf, async (req, res, next) => {
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid invitation code');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const invitation = await tx.societyInvitation.findFirst({
        where: {
          tokenHash: hashCode(parsed.data.code),
          email: req.auth.user.email,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
          society: { status: 'ACTIVE' },
        },
        select: {
          id: true,
          societyId: true,
          role: true,
          email: true,
          society: { select: { name: true } },
        },
      });
      if (!invitation) return { kind: 'invalid' };
      const existing = await tx.societyMembership.findUnique({
        where: { societyId_userId: { societyId: invitation.societyId, userId: req.auth.user.id } },
        select: { id: true, active: true },
      });
      if (existing?.active) return { kind: 'already_member' };
      const claimed = await tx.societyInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (!claimed.count) return { kind: 'invalid' };
      const membership = existing
        ? await tx.societyMembership.update({
            where: { id: existing.id },
            data: { active: true, role: invitation.role },
            select: { id: true, societyId: true, role: true },
          })
        : await tx.societyMembership.create({
            data: {
              societyId: invitation.societyId,
              userId: req.auth.user.id,
              role: invitation.role,
            },
            select: { id: true, societyId: true, role: true },
          });
      await tx.auditLog.create({
        data: {
          societyId: invitation.societyId,
          actorUserId: req.auth.user.id,
          eventType: 'MEMBER_JOINED',
          resourceType: 'SOCIETY_MEMBERSHIP',
          resourceId: membership.id,
        },
      });
      return { kind: 'accepted', membership, societyName: invitation.society.name };
    });
    if (result.kind === 'invalid')
      return fail(
        res,
        404,
        'INVITATION_NOT_FOUND',
        'This invitation is invalid, expired, or belongs to another email address',
      );
    if (result.kind === 'already_member')
      return fail(res, 409, 'MEMBER_ALREADY_EXISTS', 'This account already belongs to the society');
    res.status(201).json({ membership: result.membership, societyName: result.societyName });
  } catch (error) {
    if (error?.code === 'P2002')
      return fail(res, 409, 'MEMBER_ALREADY_EXISTS', 'This account already belongs to the society');
    next(error);
  }
});
