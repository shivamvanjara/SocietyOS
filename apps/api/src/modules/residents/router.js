import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const residentsRouter = express.Router({ mergeParams: true });

const uuid = z.uuid();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  flatId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
});
const optionalText = (max) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().max(max).nullable().optional(),
  );
const optionalPhone = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{7,14}$/)
    .nullable()
    .optional(),
);
const residentFields = {
  fullName: z.string().trim().min(2).max(160),
  flatId: uuid,
  email: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.email().trim().toLowerCase().nullable().optional(),
  ),
  phone: optionalPhone,
  residentType: z.enum(['OWNER', 'TENANT']),
  emergencyContactName: optionalText(160),
  emergencyContactPhone: optionalPhone,
};
const createSchema = z.object(residentFields).strict();
const updateSchema = z
  .object({ ...residentFields, status: z.enum(['ACTIVE', 'INACTIVE']) })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const residentSelect = {
  id: true,
  societyId: true,
  flatId: true,
  fullName: true,
  email: true,
  phone: true,
  residentType: true,
  status: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
  createdAt: true,
  updatedAt: true,
  flat: {
    select: {
      flatNumber: true,
      buildingId: true,
      building: { select: { id: true, name: true } },
    },
  },
};

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function params(request) {
  const societyId = uuid.safeParse(request.params.societyId);
  const residentId = request.params.residentId ? uuid.safeParse(request.params.residentId) : null;
  if (!societyId.success || (residentId && !residentId.success)) return null;
  return {
    societyId: societyId.data,
    ...(residentId?.success ? { residentId: residentId.data } : {}),
  };
}

async function societyAdmin(client, societyId, userId) {
  const membership = await client.societyMembership.findFirst({
    where: {
      societyId,
      userId,
      active: true,
      role: 'SOCIETY_ADMIN',
      society: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
  return membership;
}

function inaccessible(response) {
  return fail(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
}

function logResidentChange(transaction, request, residentId, eventType) {
  return transaction.auditLog.create({
    data: {
      societyId: request.societyId,
      actorUserId: request.userId,
      eventType,
      resourceType: 'RESIDENT',
      resourceId: residentId,
    },
  });
}

residentsRouter.use(requireAuthenticated);

residentsRouter.get('/me', async (request, response, next) => {
  const route = params(request);
  if (!route) return fail(response, 400, 'VALIDATION_ERROR', 'Invalid resident request');
  try {
    const membership = await prisma.societyMembership.findFirst({
      where: {
        societyId: route.societyId,
        userId: request.auth.user.id,
        active: true,
        role: 'RESIDENT',
        society: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!membership) return inaccessible(response);
    const residents = await prisma.resident.findMany({
      where: { societyId: route.societyId, email: request.auth.user.email, status: 'ACTIVE' },
      select: {
        id: true,
        fullName: true,
        residentType: true,
        flat: {
          select: {
            id: true,
            flatNumber: true,
            floor: true,
            flatType: true,
            building: { select: { name: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    response.json({ residents });
  } catch (cause) {
    next(cause);
  }
});

residentsRouter.get('/', async (request, response, next) => {
  const route = params(request);
  const page = pageSchema.safeParse(request.query);
  if (!route || !page.success)
    return fail(response, 400, 'VALIDATION_ERROR', 'Invalid resident query');
  try {
    const membership = await societyAdmin(prisma, route.societyId, request.auth.user.id);
    if (!membership) return inaccessible(response);
    const where = {
      societyId: route.societyId,
      ...(page.data.status ? { status: page.data.status } : {}),
      ...(page.data.flatId ? { flatId: page.data.flatId } : {}),
      ...(page.data.search
        ? {
            OR: [
              { fullName: { contains: page.data.search, mode: 'insensitive' } },
              { email: { contains: page.data.search, mode: 'insensitive' } },
              { phone: { contains: page.data.search } },
            ],
          }
        : {}),
    };
    const [rows, totalCount] = await Promise.all([
      prisma.resident.findMany({
        where,
        select: residentSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.data.limit + 1,
        ...(page.data.cursor ? { cursor: { id: page.data.cursor }, skip: 1 } : {}),
      }),
      prisma.resident.count({ where }),
    ]);
    const hasMore = rows.length > page.data.limit;
    if (hasMore) rows.pop();
    response.json({
      residents: rows,
      totalCount,
      nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
    });
  } catch (cause) {
    next(cause);
  }
});

residentsRouter.post('/', requireCsrf, async (request, response, next) => {
  const route = params(request);
  const parsed = createSchema.safeParse(request.body);
  if (!route || !parsed.success)
    return fail(response, 400, 'VALIDATION_ERROR', 'Check the resident details and try again');
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const membership = await societyAdmin(transaction, route.societyId, request.auth.user.id);
      if (!membership) return { kind: 'inaccessible' };
      const flat = await transaction.flat.findFirst({
        where: { id: parsed.data.flatId, societyId: route.societyId },
        select: { id: true },
      });
      if (!flat) return { kind: 'flat_missing' };
      const resident = await transaction.resident.create({
        data: { ...parsed.data, societyId: route.societyId },
        select: residentSelect,
      });
      await logResidentChange(
        transaction,
        { societyId: route.societyId, userId: request.auth.user.id },
        resident.id,
        'RESIDENT_CREATED',
      );
      return { kind: 'created', resident };
    });
    if (result.kind === 'inaccessible') return inaccessible(response);
    if (result.kind === 'flat_missing')
      return fail(response, 404, 'FLAT_NOT_FOUND', 'Flat not found');
    response.status(201).json({ resident: result.resident });
  } catch (cause) {
    next(cause);
  }
});

residentsRouter.patch('/:residentId', requireCsrf, async (request, response, next) => {
  const route = params(request);
  const parsed = updateSchema.safeParse(request.body);
  if (!route || !parsed.success)
    return fail(response, 400, 'VALIDATION_ERROR', 'Check the resident details and try again');
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const membership = await societyAdmin(transaction, route.societyId, request.auth.user.id);
      if (!membership) return { kind: 'inaccessible' };
      if (parsed.data.flatId) {
        const flat = await transaction.flat.findFirst({
          where: { id: parsed.data.flatId, societyId: route.societyId },
          select: { id: true },
        });
        if (!flat) return { kind: 'flat_missing' };
      }
      const updated = await transaction.resident.updateMany({
        where: { id: route.residentId, societyId: route.societyId },
        data: parsed.data,
      });
      if (!updated.count) return { kind: 'resident_missing' };
      const resident = await transaction.resident.findFirst({
        where: { id: route.residentId, societyId: route.societyId },
        select: residentSelect,
      });
      await logResidentChange(
        transaction,
        { societyId: route.societyId, userId: request.auth.user.id },
        resident.id,
        parsed.data.status === 'INACTIVE' ? 'RESIDENT_DEACTIVATED' : 'RESIDENT_UPDATED',
      );
      return { kind: 'updated', resident };
    });
    if (result.kind === 'inaccessible') return inaccessible(response);
    if (result.kind === 'flat_missing')
      return fail(response, 404, 'FLAT_NOT_FOUND', 'Flat not found');
    if (result.kind === 'resident_missing')
      return fail(response, 404, 'RESIDENT_NOT_FOUND', 'Resident not found');
    response.json({ resident: result.resident });
  } catch (cause) {
    next(cause);
  }
});
