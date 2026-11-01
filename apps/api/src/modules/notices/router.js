import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const noticesRouter = express.Router({ mergeParams: true });
const uuid = z.uuid();
const noticeSchema = z
  .object({
    title: z.string().trim().min(3).max(180),
    body: z.string().trim().min(3).max(10000),
    category: z.string().trim().min(2).max(60),
    publishedAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .refine(
    (notice) =>
      !notice.expiresAt ||
      Date.parse(notice.expiresAt) > Date.parse(notice.publishedAt ?? new Date().toISOString()),
  );

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

async function membership(db, societyId, userId) {
  return db.societyMembership.findFirst({
    where: { societyId, userId, active: true, society: { status: 'ACTIVE' } },
    select: { id: true, role: true },
  });
}

noticesRouter.use(requireAuthenticated);

noticesRouter.get('/', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const member = await membership(prisma, societyId.data, req.auth.user.id);
    if (!member) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const now = new Date();
    const notices = await prisma.notice.findMany({
      where: {
        societyId: societyId.data,
        publishedAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        title: true,
        body: true,
        category: true,
        publishedAt: true,
        expiresAt: true,
        reads: { where: { userId: req.auth.user.id }, select: { readAt: true }, take: 1 },
      },
    });
    res.json({
      notices: notices.map(({ reads, ...notice }) => ({
        ...notice,
        readAt: reads[0]?.readAt ?? null,
      })),
      canPublish: ['SOCIETY_ADMIN', 'COMMITTEE_MEMBER'].includes(member.role),
    });
  } catch (error) {
    next(error);
  }
});

noticesRouter.post('/', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = noticeSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the notice details and dates');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const member = await membership(tx, societyId.data, req.auth.user.id);
      if (!member) return { kind: 'inaccessible' };
      if (!['SOCIETY_ADMIN', 'COMMITTEE_MEMBER'].includes(member.role))
        return { kind: 'forbidden' };
      const notice = await tx.notice.create({
        data: {
          societyId: societyId.data,
          authorId: req.auth.user.id,
          title: parsed.data.title,
          body: parsed.data.body,
          category: parsed.data.category,
          ...(parsed.data.publishedAt ? { publishedAt: new Date(parsed.data.publishedAt) } : {}),
          ...(parsed.data.expiresAt ? { expiresAt: new Date(parsed.data.expiresAt) } : {}),
        },
        select: {
          id: true,
          title: true,
          body: true,
          category: true,
          publishedAt: true,
          expiresAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'NOTICE_PUBLISHED',
          resourceType: 'NOTICE',
          resourceId: notice.id,
        },
      });
      return { kind: 'created', notice };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Notice publishing access is required');
    res.status(201).json({ notice: result.notice });
  } catch (error) {
    next(error);
  }
});

noticesRouter.post('/:noticeId/read', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const noticeId = uuid.safeParse(req.params.noticeId);
  if (!societyId.success || !noticeId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid notice');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!(await membership(tx, societyId.data, req.auth.user.id))) return null;
      const notice = await tx.notice.findFirst({
        where: { id: noticeId.data, societyId: societyId.data },
        select: { id: true },
      });
      if (!notice) return null;
      return tx.noticeRead.upsert({
        where: {
          societyId_noticeId_userId: {
            societyId: societyId.data,
            noticeId: noticeId.data,
            userId: req.auth.user.id,
          },
        },
        create: { societyId: societyId.data, noticeId: noticeId.data, userId: req.auth.user.id },
        update: {},
        select: { readAt: true },
      });
    });
    if (!result) return fail(res, 404, 'NOTICE_NOT_FOUND', 'Notice not found');
    res.json({ readAt: result.readAt });
  } catch (error) {
    next(error);
  }
});
