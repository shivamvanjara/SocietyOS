import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const buildingsRouter = express.Router({ mergeParams: true });

const uuidSchema = z.uuid();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});
const buildingBody = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const flatFields = {
  flatNumber: z.string().trim().min(1).max(20),
  floor: z.number().int().min(-5).max(200),
  flatType: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().max(40).nullable().optional(),
  ),
  occupancyStatus: z.enum(['VACANT', 'OCCUPIED']),
};
const createFlatBody = z.object(flatFields).strict().extend({
  occupancyStatus: flatFields.occupancyStatus.optional(),
});
const updateFlatBody = z
  .object(flatFields)
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0);
const buildingSelect = {
  id: true,
  societyId: true,
  name: true,
  createdAt: true,
  _count: { select: { flats: true } },
};
const flatSelect = {
  id: true,
  societyId: true,
  buildingId: true,
  flatNumber: true,
  floor: true,
  flatType: true,
  occupancyStatus: true,
  createdAt: true,
  updatedAt: true,
};

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

function parseIds(request) {
  const societyId = uuidSchema.safeParse(request.params.societyId);
  const buildingId = uuidSchema.safeParse(request.params.buildingId);
  const flatId = request.params.flatId ? uuidSchema.safeParse(request.params.flatId) : null;
  if (
    !societyId.success ||
    (request.params.buildingId && !buildingId.success) ||
    (flatId && !flatId.success)
  ) {
    return null;
  }
  return {
    societyId: societyId.data,
    ...(buildingId?.success ? { buildingId: buildingId.data } : {}),
    ...(flatId?.success ? { flatId: flatId.data } : {}),
  };
}

function schemaError(response) {
  return fail(
    response,
    400,
    'VALIDATION_ERROR',
    'Check the building or flat details and try again',
  );
}

async function getMembership(client, societyId, userId) {
  return client.societyMembership.findFirst({
    where: {
      societyId,
      userId,
      active: true,
      society: { status: 'ACTIVE' },
    },
    select: { role: true },
  });
}

function accessFailure(response, membership, requireAdmin = false) {
  if (!membership) return fail(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
  if (requireAdmin && membership.role !== 'SOCIETY_ADMIN') {
    return fail(response, 403, 'FORBIDDEN', 'Society administrator access is required');
  }
  return null;
}

async function planLimitFailure(transaction, societyId, resource) {
  const subscription = await transaction.societySubscription.findFirst({
    where: { societyId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      status: true,
      startsAt: true,
      endsAt: true,
      maxBuildings: true,
      maxFlats: true,
    },
  });
  if (!subscription) return null;
  const now = new Date();
  if (
    !['ACTIVE', 'TRIAL'].includes(subscription.status) ||
    subscription.startsAt > now ||
    (subscription.endsAt && subscription.endsAt <= now)
  )
    return { kind: 'subscription_required' };
  const limit = resource === 'buildings' ? subscription.maxBuildings : subscription.maxFlats;
  if (limit == null) return null;
  const count =
    resource === 'buildings'
      ? await transaction.building.count({ where: { societyId } })
      : await transaction.flat.count({ where: { societyId } });
  return count >= limit ? { kind: 'limit', resource, limit } : null;
}

async function lockActiveSociety(transaction, societyId) {
  const [society] = await transaction.$queryRaw`
    SELECT id FROM societies WHERE id = ${societyId}::uuid AND status = 'ACTIVE' FOR UPDATE
  `;
  return Boolean(society);
}

function planLimitResponse(response, result) {
  if (result?.kind === 'subscription_required')
    return fail(
      response,
      402,
      'SUBSCRIPTION_REQUIRED',
      'This society subscription is not active. Contact your platform administrator.',
    );
  if (result?.kind === 'limit')
    return fail(
      response,
      409,
      'PLAN_LIMIT_REACHED',
      `This plan allows up to ${result.limit} ${result.resource}. Upgrade the plan to add more.`,
    );
  return null;
}

buildingsRouter.use(requireAuthenticated);

buildingsRouter.get('/', async (request, response, next) => {
  const ids = parseIds(request);
  const page = pageSchema.safeParse(request.query);
  if (!ids || !page.success)
    return fail(response, 400, 'VALIDATION_ERROR', 'Invalid society or pagination details');
  try {
    const membership = await getMembership(prisma, ids.societyId, request.auth.user.id);
    const denied = accessFailure(response, membership);
    if (denied) return denied;

    const where = { societyId: ids.societyId };
    const [pageRows, buildingCount, occupancy] = await Promise.all([
      prisma.building.findMany({
        where,
        select: buildingSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.data.limit + 1,
        ...(page.data.cursor ? { cursor: { id: page.data.cursor }, skip: 1 } : {}),
      }),
      prisma.building.count({ where }),
      prisma.flat.groupBy({
        by: ['occupancyStatus'],
        where: { societyId: ids.societyId },
        _count: { _all: true },
      }),
    ]);
    const hasMore = pageRows.length > page.data.limit;
    if (hasMore) pageRows.pop();
    const occupiedCount =
      occupancy.find((item) => item.occupancyStatus === 'OCCUPIED')?._count._all ?? 0;
    const vacantCount =
      occupancy.find((item) => item.occupancyStatus === 'VACANT')?._count._all ?? 0;
    response.json({
      buildings: pageRows.map(({ _count, ...building }) => ({
        ...building,
        flatCount: _count.flats,
      })),
      nextCursor: hasMore ? (pageRows.at(-1)?.id ?? null) : null,
      summary: {
        buildingCount,
        flatCount: occupiedCount + vacantCount,
        occupiedCount,
        vacantCount,
      },
    });
  } catch (cause) {
    next(cause);
  }
});

buildingsRouter.post('/', requireCsrf, async (request, response, next) => {
  const ids = parseIds(request);
  const parsed = buildingBody.safeParse(request.body);
  if (!ids || !parsed.success) return schemaError(response);
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const membership = await getMembership(transaction, ids.societyId, request.auth.user.id);
      if (!membership) return { kind: 'missing' };
      if (membership.role !== 'SOCIETY_ADMIN') return { kind: 'forbidden' };
      if (!(await lockActiveSociety(transaction, ids.societyId))) return { kind: 'missing' };
      const limit = await planLimitFailure(transaction, ids.societyId, 'buildings');
      if (limit) return limit;
      const building = await transaction.building.create({
        data: { societyId: ids.societyId, name: parsed.data.name },
        select: buildingSelect,
      });
      return { kind: 'created', building };
    });
    if (result.kind === 'missing')
      return fail(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(response, 403, 'FORBIDDEN', 'Society administrator access is required');
    const limitFailure = planLimitResponse(response, result);
    if (limitFailure) return limitFailure;
    response
      .status(201)
      .json({ building: { ...result.building, flatCount: result.building._count.flats } });
  } catch (cause) {
    if (cause?.code === 'P2002')
      return fail(response, 409, 'BUILDING_NAME_TAKEN', 'This building name is already in use');
    next(cause);
  }
});

buildingsRouter.patch('/:buildingId', requireCsrf, async (request, response, next) => {
  const ids = parseIds(request);
  const parsed = buildingBody.safeParse(request.body);
  if (!ids || !parsed.success) return schemaError(response);
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const membership = await getMembership(transaction, ids.societyId, request.auth.user.id);
      if (!membership) return { kind: 'missing' };
      if (membership.role !== 'SOCIETY_ADMIN') return { kind: 'forbidden' };
      const updated = await transaction.building.updateMany({
        where: { id: ids.buildingId, societyId: ids.societyId },
        data: { name: parsed.data.name },
      });
      if (!updated.count) return { kind: 'building_missing' };
      const building = await transaction.building.findFirst({
        where: { id: ids.buildingId, societyId: ids.societyId },
        select: buildingSelect,
      });
      return { kind: 'updated', building };
    });
    if (result.kind === 'missing')
      return fail(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'building_missing')
      return fail(response, 404, 'BUILDING_NOT_FOUND', 'Building not found');
    if (result.kind === 'forbidden')
      return fail(response, 403, 'FORBIDDEN', 'Society administrator access is required');
    response.json({ building: { ...result.building, flatCount: result.building._count.flats } });
  } catch (cause) {
    if (cause?.code === 'P2002')
      return fail(response, 409, 'BUILDING_NAME_TAKEN', 'This building name is already in use');
    next(cause);
  }
});

buildingsRouter.get('/:buildingId/flats', async (request, response, next) => {
  const ids = parseIds(request);
  const page = pageSchema.safeParse(request.query);
  if (!ids || !page.success)
    return fail(
      response,
      400,
      'VALIDATION_ERROR',
      'Invalid society, building, or pagination details',
    );
  try {
    const membership = await getMembership(prisma, ids.societyId, request.auth.user.id);
    const denied = accessFailure(response, membership);
    if (denied) return denied;
    const building = await prisma.building.findFirst({
      where: { id: ids.buildingId, societyId: ids.societyId },
      select: { id: true },
    });
    if (!building) return fail(response, 404, 'BUILDING_NOT_FOUND', 'Building not found');
    const pageRows = await prisma.flat.findMany({
      where: { societyId: ids.societyId, buildingId: ids.buildingId },
      select: flatSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.data.limit + 1,
      ...(page.data.cursor ? { cursor: { id: page.data.cursor }, skip: 1 } : {}),
    });
    const hasMore = pageRows.length > page.data.limit;
    if (hasMore) pageRows.pop();
    response.json({
      flats: pageRows,
      nextCursor: hasMore ? (pageRows.at(-1)?.id ?? null) : null,
    });
  } catch (cause) {
    next(cause);
  }
});

buildingsRouter.post('/:buildingId/flats', requireCsrf, async (request, response, next) => {
  const ids = parseIds(request);
  const parsed = createFlatBody.safeParse(request.body);
  if (!ids || !parsed.success) return schemaError(response);
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const membership = await getMembership(transaction, ids.societyId, request.auth.user.id);
      if (!membership) return { kind: 'missing_society' };
      if (membership.role !== 'SOCIETY_ADMIN') return { kind: 'forbidden' };
      if (!(await lockActiveSociety(transaction, ids.societyId)))
        return { kind: 'missing_society' };
      const building = await transaction.building.findFirst({
        where: { id: ids.buildingId, societyId: ids.societyId },
        select: { id: true },
      });
      if (!building) return { kind: 'missing_building' };
      const limit = await planLimitFailure(transaction, ids.societyId, 'flats');
      if (limit) return limit;
      const flat = await transaction.flat.create({
        data: {
          ...parsed.data,
          occupancyStatus: parsed.data.occupancyStatus ?? 'VACANT',
          societyId: ids.societyId,
          buildingId: ids.buildingId,
        },
        select: flatSelect,
      });
      return { kind: 'created', flat };
    });
    if (result.kind === 'missing_society')
      return fail(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'missing_building')
      return fail(response, 404, 'BUILDING_NOT_FOUND', 'Building not found');
    if (result.kind === 'forbidden')
      return fail(response, 403, 'FORBIDDEN', 'Society administrator access is required');
    const limitFailure = planLimitResponse(response, result);
    if (limitFailure) return limitFailure;
    response.status(201).json({ flat: result.flat });
  } catch (cause) {
    if (cause?.code === 'P2002')
      return fail(
        response,
        409,
        'FLAT_NUMBER_TAKEN',
        'This flat number already exists in the building',
      );
    next(cause);
  }
});

buildingsRouter.patch(
  '/:buildingId/flats/:flatId',
  requireCsrf,
  async (request, response, next) => {
    const ids = parseIds(request);
    const parsed = updateFlatBody.safeParse(request.body);
    if (!ids || !parsed.success) return schemaError(response);
    try {
      const result = await prisma.$transaction(async (transaction) => {
        const membership = await getMembership(transaction, ids.societyId, request.auth.user.id);
        if (!membership) return { kind: 'missing_society' };
        if (membership.role !== 'SOCIETY_ADMIN') return { kind: 'forbidden' };
        const updated = await transaction.flat.updateMany({
          where: {
            id: ids.flatId,
            societyId: ids.societyId,
            buildingId: ids.buildingId,
          },
          data: parsed.data,
        });
        if (!updated.count) return { kind: 'missing_flat' };
        const flat = await transaction.flat.findFirst({
          where: { id: ids.flatId, societyId: ids.societyId, buildingId: ids.buildingId },
          select: flatSelect,
        });
        return { kind: 'updated', flat };
      });
      if (result.kind === 'missing_society')
        return fail(response, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (result.kind === 'missing_flat')
        return fail(response, 404, 'FLAT_NOT_FOUND', 'Flat not found');
      if (result.kind === 'forbidden')
        return fail(response, 403, 'FORBIDDEN', 'Society administrator access is required');
      response.json({ flat: result.flat });
    } catch (cause) {
      if (cause?.code === 'P2002')
        return fail(
          response,
          409,
          'FLAT_NUMBER_TAKEN',
          'This flat number already exists in the building',
        );
      next(cause);
    }
  },
);
