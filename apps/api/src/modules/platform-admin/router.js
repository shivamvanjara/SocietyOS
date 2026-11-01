import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const platformAdminRouter = express.Router();

const uuid = z.uuid();
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});
const statusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).strict();

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function requireSuperAdmin(req, res, next) {
  if (req.auth.user.platformRole !== 'SUPER_ADMIN')
    return fail(res, 403, 'FORBIDDEN', 'Platform administrator access is required');
  next();
}

platformAdminRouter.use(requireAuthenticated, requireSuperAdmin);

platformAdminRouter.get('/overview', async (req, res, next) => {
  try {
    const [
      totalSocieties,
      activeSocieties,
      suspendedSocieties,
      totalUsers,
      activeUsers,
      suspendedUsers,
      totalFlats,
    ] = await Promise.all([
      prisma.society.count(),
      prisma.society.count({ where: { status: 'ACTIVE' } }),
      prisma.society.count({ where: { status: 'SUSPENDED' } }),
      prisma.user.count(),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { status: 'SUSPENDED' } }),
      prisma.flat.count(),
    ]);
    return res.json({
      currentUserId: req.auth.user.id,
      societies: { total: totalSocieties, active: activeSocieties, suspended: suspendedSocieties },
      users: { total: totalUsers, active: activeUsers, suspended: suspendedUsers },
      flats: { total: totalFlats },
    });
  } catch (error) {
    next(error);
  }
});

platformAdminRouter.get('/societies', async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society query');
  try {
    const search = parsed.data.search;
    const rows = await prisma.society.findMany({
      where: {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { city: { contains: search, mode: 'insensitive' } },
                { slug: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        slug: true,
        city: true,
        status: true,
        createdAt: true,
        _count: { select: { memberships: true, buildings: true, flats: true } },
      },
    });
    const hasMore = rows.length > parsed.data.limit;
    if (hasMore) rows.pop();
    return res.json({ societies: rows, nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null });
  } catch (error) {
    next(error);
  }
});

platformAdminRouter.get('/users', async (req, res, next) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid user query');
  try {
    const search = parsed.data.search;
    const rows = await prisma.user.findMany({
      where: {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(search ? { email: { contains: search, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        email: true,
        status: true,
        platformRole: true,
        createdAt: true,
        _count: { select: { memberships: true } },
      },
    });
    const hasMore = rows.length > parsed.data.limit;
    if (hasMore) rows.pop();
    return res.json({ users: rows, nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null });
  } catch (error) {
    next(error);
  }
});

platformAdminRouter.get('/audit-log', async (req, res, next) => {
  const parsed = z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
    .safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid audit log query');
  try {
    const entries = await prisma.platformAuditLog.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit,
      select: {
        id: true,
        eventType: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
        actor: { select: { email: true } },
      },
    });
    return res.json({ entries });
  } catch (error) {
    next(error);
  }
});

platformAdminRouter.patch('/societies/:societyId/status', requireCsrf, async (req, res, next) => {
  const parsedId = uuid.safeParse(req.params.societyId);
  const parsedBody = statusSchema.safeParse(req.body);
  if (!parsedId.success || !parsedBody.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Choose a valid society status');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const society = await tx.society.findUnique({
        where: { id: parsedId.data },
        select: { id: true, name: true, status: true },
      });
      if (!society) return { kind: 'missing' };
      if (society.status === parsedBody.data.status) return { kind: 'unchanged', society };
      const updated = await tx.society.update({
        where: { id: society.id },
        data: { status: parsedBody.data.status },
        select: { id: true, name: true, status: true },
      });
      await tx.platformAuditLog.create({
        data: {
          actorUserId: req.auth.user.id,
          eventType: `SOCIETY_${parsedBody.data.status}`,
          resourceType: 'SOCIETY',
          resourceId: society.id,
        },
      });
      return { kind: 'updated', society: updated };
    });
    if (result.kind === 'missing') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    return res.json({ society: result.society });
  } catch (error) {
    next(error);
  }
});

platformAdminRouter.patch('/users/:userId/status', requireCsrf, async (req, res, next) => {
  const parsedId = uuid.safeParse(req.params.userId);
  const parsedBody = statusSchema.safeParse(req.body);
  if (!parsedId.success || !parsedBody.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Choose a valid account status');
  if (parsedId.data === req.auth.user.id && parsedBody.data.status === 'SUSPENDED')
    return fail(
      res,
      409,
      'SELF_SUSPENSION_NOT_ALLOWED',
      'You cannot suspend your own platform account',
    );
  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: parsedId.data },
        select: { id: true, email: true, status: true, platformRole: true },
      });
      if (!user) return { kind: 'missing' };
      if (user.status === parsedBody.data.status) return { kind: 'unchanged', user };
      if (user.platformRole === 'SUPER_ADMIN' && parsedBody.data.status === 'SUSPENDED') {
        await tx.$queryRaw`SELECT id FROM users WHERE platform_role = 'SUPER_ADMIN'::"PlatformRole" AND status = 'ACTIVE'::"UserStatus" ORDER BY id FOR UPDATE`;
        const activeAdmins = await tx.user.count({
          where: { platformRole: 'SUPER_ADMIN', status: 'ACTIVE' },
        });
        if (activeAdmins <= 1) return { kind: 'last_admin' };
      }
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { status: parsedBody.data.status },
        select: { id: true, email: true, status: true, platformRole: true },
      });
      if (updated.status === 'SUSPENDED')
        await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.platformAuditLog.create({
        data: {
          actorUserId: req.auth.user.id,
          eventType: `USER_${parsedBody.data.status}`,
          resourceType: 'USER',
          resourceId: user.id,
        },
      });
      return { kind: 'updated', user: updated };
    });
    if (result.kind === 'missing') return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
    if (result.kind === 'last_admin')
      return fail(
        res,
        409,
        'LAST_SUPER_ADMIN',
        'The last active platform administrator cannot be suspended',
      );
    return res.json({ user: result.user });
  } catch (error) {
    next(error);
  }
});
