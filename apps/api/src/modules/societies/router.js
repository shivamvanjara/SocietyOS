import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const societiesRouter = express.Router();

const profileFields = {
  name: z.string().trim().min(2).max(160),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string()
      .trim()
      .regex(/^\d{6}$/)
      .nullable()
      .optional(),
  ),
  registrationCode: optionalText(80),
};
const createSchema = z.object(profileFields).strict();
const updateSchema = z
  .object(profileFields)
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0);
const societyIdSchema = z.uuid();
const profileSelect = {
  id: true,
  name: true,
  slug: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  registrationCode: true,
  status: true,
  createdAt: true,
};

function optionalText(maxLength) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().max(maxLength).nullable().optional(),
  );
}

function slugify(name) {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100)
      .replace(/-+$/g, '') || 'community'
  );
}

function error(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

societiesRouter.use(requireAuthenticated);

societiesRouter.get('/', async (request, response, next) => {
  try {
    const memberships = await prisma.societyMembership.findMany({
      where: { userId: request.auth.user.id, active: true, society: { status: 'ACTIVE' } },
      select: { role: true, society: { select: profileSelect } },
      orderBy: { createdAt: 'asc' },
    });
    response.json({ societies: memberships.map(({ role, society }) => ({ ...society, role })) });
  } catch (cause) {
    next(cause);
  }
});

societiesRouter.post('/', requireCsrf, async (request, response, next) => {
  const parsed = createSchema.safeParse(request.body);
  if (!parsed.success) {
    return error(response, 400, 'VALIDATION_ERROR', 'Check the society details and try again');
  }

  try {
    const { name, ...profile } = parsed.data;
    const society = await prisma.$transaction(async (transaction) => {
      const created = await transaction.society.create({
        data: { name, ...profile, slug: slugify(name) },
        select: profileSelect,
      });
      await transaction.societyMembership.create({
        data: { societyId: created.id, userId: request.auth.user.id, role: 'SOCIETY_ADMIN' },
      });
      return created;
    });
    response.status(201).json({ society, role: 'SOCIETY_ADMIN' });
  } catch (cause) {
    if (cause?.code === 'P2002') {
      return error(
        response,
        409,
        'SOCIETY_NAME_TAKEN',
        'A society with a similar name already exists',
      );
    }
    next(cause);
  }
});

societiesRouter.get('/:societyId', async (request, response, next) => {
  const parsedId = societyIdSchema.safeParse(request.params.societyId);
  if (!parsedId.success) return error(response, 400, 'VALIDATION_ERROR', 'Invalid society ID');

  try {
    const membership = await prisma.societyMembership.findFirst({
      where: {
        societyId: parsedId.data,
        userId: request.auth.user.id,
        active: true,
        society: { status: 'ACTIVE' },
      },
      select: { role: true, society: { select: profileSelect } },
    });
    if (!membership) return error(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    response.json({ society: membership.society, role: membership.role });
  } catch (cause) {
    next(cause);
  }
});

societiesRouter.patch('/:societyId', requireCsrf, async (request, response, next) => {
  const parsedId = societyIdSchema.safeParse(request.params.societyId);
  const parsedBody = updateSchema.safeParse(request.body);
  if (!parsedId.success || !parsedBody.success) {
    return error(response, 400, 'VALIDATION_ERROR', 'Check the society details and try again');
  }

  try {
    const result = await prisma.$transaction(async (transaction) => {
      const membership = await transaction.societyMembership.findFirst({
        where: { societyId: parsedId.data, userId: request.auth.user.id, active: true },
        select: { role: true, society: { select: { status: true } } },
      });
      if (!membership || membership.society.status !== 'ACTIVE') return { kind: 'missing' };
      if (membership.role !== 'SOCIETY_ADMIN') return { kind: 'forbidden' };
      const society = await transaction.society.update({
        where: { id: parsedId.data },
        data: parsedBody.data,
        select: profileSelect,
      });
      return { kind: 'updated', society, role: membership.role };
    });
    if (result.kind === 'missing')
      return error(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return error(response, 403, 'FORBIDDEN', 'Society administrator access is required');
    response.json({ society: result.society, role: result.role });
  } catch (cause) {
    next(cause);
  }
});
