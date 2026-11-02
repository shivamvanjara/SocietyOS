import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';
import { sendGateApprovalEmail } from '../auth/email.js';

export const visitorsRouter = express.Router({ mergeParams: true });
const uuid = z.uuid();
const passSchema = z
  .object({
    flatId: uuid,
    visitorName: z.string().trim().min(2).max(160),
    visitorPhone: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{7,14}$/)
      .nullable()
      .optional(),
    purpose: z.string().trim().min(2).max(200),
    expectedAt: z.iso.datetime(),
  })
  .strict()
  .refine((value) => {
    const time = Date.parse(value.expectedAt);
    return time > Date.now() && time <= Date.now() + 30 * 24 * 60 * 60 * 1000;
  });
const verifySchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
const recurringAuthorizationSchema = z
  .object({
    flatId: uuid,
    visitorName: z.string().trim().min(2).max(160),
    visitorPhone: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{7,14}$/),
    visitorType: z.enum(['DOMESTIC_WORKER', 'SERVICE_PERSONNEL']),
    purpose: z.string().trim().min(2).max(200),
    validFrom: dateOnly,
    validUntil: dateOnly,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((value) => new Set(value.weekdays).size === value.weekdays.length, {
    message: 'Choose each weekday only once',
    path: ['weekdays'],
  })
  .refine((value) => value.startMinute < value.endMinute, {
    message: 'End time must be later than start time',
    path: ['endMinute'],
  })
  .refine((value) => value.validFrom <= value.validUntil, {
    message: 'End date must be on or after start date',
    path: ['validUntil'],
  })
  .refine(
    (value) => Date.parse(`${value.validUntil}T00:00:00.000Z`) <= Date.now() + 366 * 86400000,
    {
      message: 'Authorization cannot extend more than one year',
      path: ['validUntil'],
    },
  );
const arrivalSchema = z
  .object({
    clientRequestId: uuid.optional(),
    identityConfirmed: z.boolean().optional().default(false),
    flatId: uuid,
    visitorName: z.string().trim().min(2).max(160),
    visitorPhone: z
      .string()
      .trim()
      .regex(/^\+?[1-9]\d{7,14}$/),
    vehicleNumber: z.string().trim().max(20).optional().default(''),
    vehicleType: z.string().trim().max(40).optional().default(''),
    parkingLocation: z.string().trim().max(80).optional().default(''),
    parkingAlert: z.boolean().optional().default(false),
    groupSize: z.number().int().min(1).max(50).optional().default(1),
    expectedDurationMinutes: z.number().int().min(15).max(1440).optional().default(240),
    deliveryPlatform: z.string().trim().max(80).optional().default(''),
    purpose: z.string().trim().min(2).max(200),
    visitorType: z.enum([
      'DELIVERY',
      'GUEST',
      'DOMESTIC_WORKER',
      'SERVICE_PERSONNEL',
      'CAB_RIDE',
      'VENDOR',
      'CONSTRUCTION_WORKER',
      'MOVING_SERVICE',
      'EMERGENCY_SERVICE',
      'EVENT_GUEST',
    ]),
  })
  .strict();

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

async function lockSocietyGate(db, societyId) {
  await db.$queryRaw`SELECT id FROM "societies" WHERE id = ${societyId}::uuid FOR UPDATE`;
}

function canSeeAll(role) {
  return ['SOCIETY_ADMIN', 'COMMITTEE_MEMBER', 'SECURITY_GUARD'].includes(role);
}

function isGuard(role) {
  return ['SOCIETY_ADMIN', 'SECURITY_GUARD'].includes(role);
}

function indiaLocalWindow(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[values.weekday];
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    dayIndex,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

visitorsRouter.use(requireAuthenticated);

visitorsRouter.get('/flats', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const residentFlats =
      currentMember.role === 'RESIDENT'
        ? await prisma.resident.findMany({
            where: { societyId: societyId.data, email: req.auth.user.email, status: 'ACTIVE' },
            select: { flatId: true },
          })
        : null;
    const flats = await prisma.flat.findMany({
      where: {
        societyId: societyId.data,
        ...(residentFlats ? { id: { in: residentFlats.map(({ flatId }) => flatId) } } : {}),
      },
      orderBy: [{ building: { name: 'asc' } }, { flatNumber: 'asc' }],
      select: { id: true, flatNumber: true, building: { select: { name: true } } },
    });
    res.json({ flats });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.get('/approvals', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (currentMember.role !== 'RESIDENT')
      return fail(res, 403, 'FORBIDDEN', 'Resident access is required');
    const flats = await prisma.resident.findMany({
      where: { societyId: societyId.data, email: req.auth.user.email, status: 'ACTIVE' },
      select: { flatId: true },
    });
    await prisma.visitorPass.updateMany({
      where: {
        societyId: societyId.data,
        flatId: { in: flats.map(({ flatId }) => flatId) },
        status: { in: ['PENDING_APPROVAL', 'APPROVED', 'EXPECTED'] },
        expiresAt: { lte: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    const arrivals = await prisma.visitorPass.findMany({
      where: {
        societyId: societyId.data,
        flatId: { in: flats.map(({ flatId }) => flatId) },
        status: { in: ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED'] },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        visitorName: true,
        visitorPhone: true,
        visitorType: true,
        vehicleNumber: true,
        vehicleType: true,
        parkingLocation: true,
        parkingAlert: true,
        groupSize: true,
        expectedDurationMinutes: true,
        deliveryPlatform: true,
        deliveryHandoverStatus: true,
        deliveryHandoverAt: true,
        purpose: true,
        status: true,
        expectedAt: true,
        expiresAt: true,
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
      },
    });
    res.json({ arrivals });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.get('/recurring-authorizations', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (currentMember.role !== 'RESIDENT')
      return fail(res, 403, 'FORBIDDEN', 'Resident access is required');
    const residentFlats = await prisma.resident.findMany({
      where: { societyId: societyId.data, email: req.auth.user.email, status: 'ACTIVE' },
      select: { flatId: true },
    });
    const authorizations = await prisma.recurringVisitorAuthorization.findMany({
      where: {
        societyId: societyId.data,
        flatId: { in: residentFlats.map(({ flatId }) => flatId) },
      },
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        flatId: true,
        visitorName: true,
        visitorPhone: true,
        visitorType: true,
        purpose: true,
        validFrom: true,
        validUntil: true,
        weekdays: true,
        startMinute: true,
        endMinute: true,
        active: true,
        revokedAt: true,
        createdAt: true,
        createdBy: { select: { email: true } },
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
      },
    });
    res.json({ authorizations });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/recurring-authorizations', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = recurringAuthorizationSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Enter a valid worker, flat, date range, weekdays and daily time window',
    );
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (currentMember.role !== 'RESIDENT') return { kind: 'forbidden' };
      const resident = await tx.resident.findFirst({
        where: {
          societyId: societyId.data,
          flatId: parsed.data.flatId,
          email: req.auth.user.email,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (!resident) return { kind: 'flat_missing' };
      const duplicate = await tx.recurringVisitorAuthorization.findFirst({
        where: {
          societyId: societyId.data,
          flatId: parsed.data.flatId,
          visitorPhone: parsed.data.visitorPhone,
          visitorType: parsed.data.visitorType,
          active: true,
          revokedAt: null,
          validFrom: { lte: new Date(`${parsed.data.validUntil}T00:00:00.000Z`) },
          validUntil: { gte: new Date(`${parsed.data.validFrom}T00:00:00.000Z`) },
        },
        select: { id: true },
      });
      if (duplicate) return { kind: 'duplicate' };
      const authorization = await tx.recurringVisitorAuthorization.create({
        data: {
          societyId: societyId.data,
          flatId: parsed.data.flatId,
          createdById: req.auth.user.id,
          visitorName: parsed.data.visitorName,
          visitorPhone: parsed.data.visitorPhone,
          visitorType: parsed.data.visitorType,
          purpose: parsed.data.purpose,
          validFrom: new Date(`${parsed.data.validFrom}T00:00:00.000Z`),
          validUntil: new Date(`${parsed.data.validUntil}T00:00:00.000Z`),
          weekdays: [...parsed.data.weekdays].sort((a, b) => a - b),
          startMinute: parsed.data.startMinute,
          endMinute: parsed.data.endMinute,
        },
        select: { id: true, flatId: true, visitorName: true, visitorType: true, active: true },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'RECURRING_VISITOR_AUTHORIZATION_CREATED',
          resourceType: 'RECURRING_VISITOR_AUTHORIZATION',
          resourceId: authorization.id,
        },
      });
      return { kind: 'created', authorization };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Resident access is required');
    if (result.kind === 'flat_missing')
      return fail(res, 404, 'FLAT_NOT_FOUND', 'That flat is not linked to your resident account');
    if (result.kind === 'duplicate')
      return fail(
        res,
        409,
        'AUTHORIZATION_EXISTS',
        'An active authorization already covers this worker and validity period',
      );
    res.status(201).json({ authorization: result.authorization });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post(
  '/recurring-authorizations/:authorizationId/revoke',
  requireCsrf,
  async (req, res, next) => {
    const societyId = uuid.safeParse(req.params.societyId);
    const authorizationId = uuid.safeParse(req.params.authorizationId);
    if (!societyId.success || !authorizationId.success)
      return fail(res, 400, 'VALIDATION_ERROR', 'Invalid authorization');
    try {
      const result = await prisma.$transaction(async (tx) => {
        const currentMember = await member(tx, societyId.data, req.auth.user.id);
        if (!currentMember) return 'inaccessible';
        if (currentMember.role !== 'RESIDENT') return 'forbidden';
        const residentFlats = await tx.resident.findMany({
          where: { societyId: societyId.data, email: req.auth.user.email, status: 'ACTIVE' },
          select: { flatId: true },
        });
        const authorization = await tx.recurringVisitorAuthorization.findFirst({
          where: {
            id: authorizationId.data,
            societyId: societyId.data,
            flatId: { in: residentFlats.map(({ flatId }) => flatId) },
            active: true,
          },
          select: { id: true },
        });
        if (!authorization) return 'missing';
        await tx.recurringVisitorAuthorization.update({
          where: { id: authorization.id },
          data: { active: false, revokedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            societyId: societyId.data,
            actorUserId: req.auth.user.id,
            eventType: 'RECURRING_VISITOR_AUTHORIZATION_REVOKED',
            resourceType: 'RECURRING_VISITOR_AUTHORIZATION',
            resourceId: authorization.id,
          },
        });
        return 'revoked';
      });
      if (result === 'inaccessible')
        return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (result === 'forbidden') return fail(res, 403, 'FORBIDDEN', 'Resident access is required');
      if (result === 'missing')
        return fail(
          res,
          404,
          'AUTHORIZATION_NOT_FOUND',
          'Authorization not found or already revoked',
        );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

visitorsRouter.get('/passes', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (currentMember.role === 'SECURITY_GUARD') {
      await prisma.visitorPass.updateMany({
        where: {
          societyId: societyId.data,
          status: { in: ['PENDING_APPROVAL', 'APPROVED', 'EXPECTED'] },
          expiresAt: { lte: new Date() },
        },
        data: { status: 'EXPIRED' },
      });
    }
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const where = {
      societyId: societyId.data,
      ...(!canSeeAll(currentMember.role) ? { createdById: req.auth.user.id } : {}),
      ...(search
        ? {
            OR: [
              { visitorName: { contains: search, mode: 'insensitive' } },
              { visitorPhone: { contains: search } },
              { purpose: { contains: search, mode: 'insensitive' } },
              { flat: { flatNumber: { contains: search, mode: 'insensitive' } } },
              { flat: { building: { name: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const passes = await prisma.visitorPass.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 300,
      select: {
        id: true,
        flatId: true,
        visitorName: true,
        visitorPhone: true,
        visitorType: true,
        vehicleNumber: true,
        vehicleType: true,
        parkingLocation: true,
        parkingAlert: true,
        groupSize: true,
        expectedDurationMinutes: true,
        deliveryPlatform: true,
        deliveryHandoverStatus: true,
        deliveryHandoverAt: true,
        purpose: true,
        expectedAt: true,
        expiresAt: true,
        status: true,
        checkedInAt: true,
        checkedOutAt: true,
        createdAt: true,
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
      },
    });
    let metrics;
    if (currentMember.role === 'SECURITY_GUARD') {
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const start = new Date(`${today}T00:00:00+05:30`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      const [entriesToday, inside, pendingApprovals, completedExits] = await Promise.all([
        prisma.visitorPass.count({
          where: { societyId: societyId.data, checkedInAt: { gte: start, lt: end } },
        }),
        prisma.visitorPass.count({ where: { societyId: societyId.data, status: 'CHECKED_IN' } }),
        prisma.visitorPass.count({
          where: { societyId: societyId.data, status: 'PENDING_APPROVAL' },
        }),
        prisma.visitorPass.count({
          where: { societyId: societyId.data, checkedOutAt: { gte: start, lt: end } },
        }),
      ]);
      metrics = { entriesToday, inside, pendingApprovals, completedExits };
    }
    res.json({
      passes,
      ...(metrics ? { metrics } : {}),
      role: currentMember.role,
      canManage: isGuard(currentMember.role),
      canCreate: currentMember.role !== 'SECURITY_GUARD',
    });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.get('/history', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const cursor = req.query.cursor ? uuid.safeParse(req.query.cursor) : null;
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  if (!societyId.success || (cursor && !cursor.success))
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid visitor history query');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (currentMember.role !== 'SECURITY_GUARD')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    const rows = await prisma.visitorPass.findMany({
      where: {
        societyId: societyId.data,
        status: { in: ['CHECKED_OUT', 'REJECTED', 'CANCELLED', 'EXPIRED'] },
        ...(search
          ? {
              OR: [
                { visitorName: { contains: search, mode: 'insensitive' } },
                { visitorPhone: { contains: search } },
                { purpose: { contains: search, mode: 'insensitive' } },
                { flat: { flatNumber: { contains: search, mode: 'insensitive' } } },
                { flat: { building: { name: { contains: search, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 101,
      ...(cursor?.success ? { cursor: { id: cursor.data }, skip: 1 } : {}),
      select: {
        id: true,
        flatId: true,
        visitorName: true,
        visitorPhone: true,
        visitorType: true,
        vehicleNumber: true,
        vehicleType: true,
        parkingLocation: true,
        parkingAlert: true,
        groupSize: true,
        expectedDurationMinutes: true,
        deliveryPlatform: true,
        deliveryHandoverStatus: true,
        purpose: true,
        expectedAt: true,
        expiresAt: true,
        status: true,
        checkedInAt: true,
        checkedOutAt: true,
        createdAt: true,
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
      },
    });
    const hasMore = rows.length > 100;
    const passes = hasMore ? rows.slice(0, 100) : rows;
    res.json({ passes, nextCursor: hasMore ? passes.at(-1).id : null });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/arrivals', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = arrivalSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Enter the visitor, mobile, flat and purpose details',
    );
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (currentMember.role !== 'SECURITY_GUARD') return { kind: 'forbidden' };
      await lockSocietyGate(tx, societyId.data);
      if (parsed.data.clientRequestId) {
        const replay = await tx.visitorPass.findUnique({
          where: {
            societyId_clientRequestId: {
              societyId: societyId.data,
              clientRequestId: parsed.data.clientRequestId,
            },
          },
          select: {
            id: true,
            visitorName: true,
            visitorType: true,
            status: true,
            flatId: true,
            expiresAt: true,
          },
        });
        if (replay) return { kind: 'replay', pass: replay };
      }
      const flat = await tx.flat.findFirst({
        where: { id: parsed.data.flatId, societyId: societyId.data },
        select: { id: true, flatNumber: true, building: { select: { name: true } } },
      });
      if (!flat) return { kind: 'flat_missing' };
      const residents = await tx.resident.findMany({
        where: {
          societyId: societyId.data,
          flatId: flat.id,
          status: 'ACTIVE',
          email: { not: null },
        },
        select: { email: true },
      });
      const notificationRecipients = [
        ...new Set(residents.map(({ email }) => email).filter(Boolean)),
      ];
      if (!notificationRecipients.length) return { kind: 'no_resident_contact' };
      const duplicateActiveVisitor = await tx.visitorPass.findFirst({
        where: {
          societyId: societyId.data,
          status: 'CHECKED_IN',
          visitorPhone: parsed.data.visitorPhone,
        },
        select: { id: true },
      });
      if (duplicateActiveVisitor) return { kind: 'already_inside' };
      const now = new Date();
      let recurringAuthorization = null;
      if (
        parsed.data.identityConfirmed &&
        ['DOMESTIC_WORKER', 'SERVICE_PERSONNEL'].includes(parsed.data.visitorType)
      ) {
        const localWindow = indiaLocalWindow(now);
        const localDate = new Date(`${localWindow.date}T00:00:00.000Z`);
        const activeResidentEmails = new Set(
          residents.map(({ email }) => email?.toLowerCase()).filter(Boolean),
        );
        const candidates = await tx.recurringVisitorAuthorization.findMany({
          where: {
            societyId: societyId.data,
            flatId: flat.id,
            visitorPhone: parsed.data.visitorPhone,
            visitorType: parsed.data.visitorType,
            active: true,
            revokedAt: null,
            validFrom: { lte: localDate },
            validUntil: { gte: localDate },
          },
          select: {
            id: true,
            createdById: true,
            visitorName: true,
            weekdays: true,
            startMinute: true,
            endMinute: true,
            createdBy: { select: { email: true } },
          },
        });
        recurringAuthorization = candidates.find(
          (authorization) =>
            authorization.visitorName.trim().toLocaleLowerCase() ===
              parsed.data.visitorName.trim().toLocaleLowerCase() &&
            activeResidentEmails.has(authorization.createdBy.email.toLowerCase()) &&
            authorization.weekdays.includes(localWindow.dayIndex) &&
            localWindow.minute >= authorization.startMinute &&
            localWindow.minute < authorization.endMinute,
        );
      }
      const pass = await tx.visitorPass.create({
        data: {
          societyId: societyId.data,
          flatId: flat.id,
          createdById: req.auth.user.id,
          tokenHash: hashCode(randomBytes(32).toString('base64url')),
          clientRequestId: parsed.data.clientRequestId ?? null,
          visitorName: parsed.data.visitorName,
          visitorPhone: parsed.data.visitorPhone,
          visitorType: parsed.data.visitorType,
          vehicleNumber: parsed.data.vehicleNumber || null,
          vehicleType: parsed.data.vehicleType || null,
          parkingLocation: parsed.data.parkingLocation || null,
          parkingAlert: parsed.data.parkingAlert,
          groupSize: parsed.data.groupSize,
          expectedDurationMinutes: parsed.data.expectedDurationMinutes,
          deliveryPlatform: parsed.data.deliveryPlatform || null,
          purpose: parsed.data.purpose,
          expectedAt: now,
          expiresAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
          status: recurringAuthorization ? 'APPROVED' : 'PENDING_APPROVAL',
          ...(recurringAuthorization
            ? { authorizedAt: now, authorizedById: recurringAuthorization.createdById }
            : {}),
        },
        select: {
          id: true,
          visitorName: true,
          visitorType: true,
          status: true,
          flatId: true,
          expiresAt: true,
        },
      });
      const society = await tx.society.findUnique({
        where: { id: societyId.data },
        select: { name: true },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: recurringAuthorization
            ? 'VISITOR_RECURRING_AUTHORIZATION_USED'
            : 'VISITOR_ARRIVAL_REGISTERED',
          resourceType: 'VISITOR_PASS',
          resourceId: pass.id,
        },
      });
      return {
        kind: 'created',
        pass,
        societyName: society.name,
        flatLabel: `${flat.building.name} · ${flat.flatNumber}`,
        notificationRecipients,
        recurringAuthorizationApplied: Boolean(recurringAuthorization),
      };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    if (result.kind === 'flat_missing') return fail(res, 404, 'FLAT_NOT_FOUND', 'Flat not found');
    if (result.kind === 'replay')
      return res
        .status(200)
        .json({ pass: result.pass, replayed: true, approvalNotificationSent: false });
    if (result.kind === 'no_resident_contact')
      return fail(
        res,
        409,
        'HOST_CONTACT_MISSING',
        'The destination flat has no active resident contact to approve entry',
      );
    if (result.kind === 'already_inside')
      return fail(
        res,
        409,
        'VISITOR_ALREADY_INSIDE',
        'This mobile number already has an active visitor entry',
      );
    const approvalUrl = new URL('/', env.WEB_ORIGIN).toString();
    const emailResults = result.recurringAuthorizationApplied
      ? []
      : await Promise.allSettled(
          result.notificationRecipients.map((email) =>
            sendGateApprovalEmail(email, approvalUrl, {
              societyName: result.societyName,
              visitorName: result.pass.visitorName,
              flatLabel: result.flatLabel,
              expiresAt: result.pass.expiresAt,
            }),
          ),
        );
    res.status(201).json({
      pass: result.pass,
      recurringAuthorizationApplied: result.recurringAuthorizationApplied,
      approvalNotificationSent:
        !result.recurringAuthorizationApplied &&
        emailResults.every(
          (resultItem) => resultItem.status === 'fulfilled' && !resultItem.value.previewUrl,
        ),
    });
  } catch (error) {
    if (error?.code === 'P2002' && parsed.data.clientRequestId) {
      const replay = await prisma.visitorPass.findUnique({
        where: {
          societyId_clientRequestId: {
            societyId: societyId.data,
            clientRequestId: parsed.data.clientRequestId,
          },
        },
        select: { id: true, visitorName: true, visitorType: true, status: true, flatId: true },
      });
      if (replay)
        return res
          .status(200)
          .json({ pass: replay, replayed: true, approvalNotificationSent: false });
    }
    next(error);
  }
});

for (const [action, nextStatus, eventType] of [
  ['approve', 'APPROVED', 'VISITOR_ARRIVAL_APPROVED'],
  ['reject', 'REJECTED', 'VISITOR_ARRIVAL_REJECTED'],
]) {
  visitorsRouter.post(`/arrivals/:passId/${action}`, requireCsrf, async (req, res, next) => {
    const societyId = uuid.safeParse(req.params.societyId);
    const passId = uuid.safeParse(req.params.passId);
    if (!societyId.success || !passId.success)
      return fail(res, 400, 'VALIDATION_ERROR', 'Invalid visitor arrival');
    try {
      const result = await prisma.$transaction(async (tx) => {
        const currentMember = await member(tx, societyId.data, req.auth.user.id);
        if (!currentMember) return 'inaccessible';
        if (currentMember.role !== 'RESIDENT') return 'forbidden';
        await lockSocietyGate(tx, societyId.data);
        const now = new Date();
        const target = await tx.visitorPass.findFirst({
          where: {
            id: passId.data,
            societyId: societyId.data,
            status: 'PENDING_APPROVAL',
            expiresAt: { gt: now },
          },
          select: { flatId: true },
        });
        if (!target) return 'missing';
        const resident = await tx.resident.findFirst({
          where: {
            societyId: societyId.data,
            flatId: target.flatId,
            email: req.auth.user.email,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (!resident) return 'forbidden';
        const updated = await tx.visitorPass.updateMany({
          where: {
            id: passId.data,
            societyId: societyId.data,
            status: 'PENDING_APPROVAL',
            expiresAt: { gt: now },
          },
          data: { status: nextStatus, authorizedAt: now, authorizedById: req.auth.user.id },
        });
        if (!updated.count) return 'missing';
        await tx.auditLog.create({
          data: {
            societyId: societyId.data,
            actorUserId: req.auth.user.id,
            eventType,
            resourceType: 'VISITOR_PASS',
            resourceId: passId.data,
          },
        });
        return 'updated';
      });
      if (result === 'inaccessible')
        return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (result === 'forbidden')
        return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
      if (result === 'missing')
        return fail(
          res,
          409,
          'VISITOR_ARRIVAL_NOT_PENDING',
          'This arrival is no longer awaiting approval',
        );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}

visitorsRouter.post('/arrivals/:passId/enter', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const passId = uuid.safeParse(req.params.passId);
  if (!societyId.success || !passId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid visitor arrival');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      if (currentMember.role !== 'SECURITY_GUARD') return 'forbidden';
      await lockSocietyGate(tx, societyId.data);
      const now = new Date();
      const pendingPass = await tx.visitorPass.findFirst({
        where: { id: passId.data, societyId: societyId.data, status: 'APPROVED' },
        select: { visitorPhone: true, visitorName: true, flatId: true },
      });
      if (!pendingPass) return 'missing';
      const duplicate = await tx.visitorPass.findFirst({
        where: {
          societyId: societyId.data,
          id: { not: passId.data },
          status: 'CHECKED_IN',
          ...(pendingPass.visitorPhone
            ? { visitorPhone: pendingPass.visitorPhone }
            : { visitorName: pendingPass.visitorName, flatId: pendingPass.flatId }),
        },
        select: { id: true },
      });
      if (duplicate) return 'already_inside';
      const updated = await tx.visitorPass.updateMany({
        where: {
          id: passId.data,
          societyId: societyId.data,
          status: 'APPROVED',
          authorizedAt: { not: null },
          expiresAt: { gt: now },
        },
        data: { status: 'CHECKED_IN', checkedInAt: now, checkedInById: req.auth.user.id },
      });
      if (!updated.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'VISITOR_CHECKED_IN',
          resourceType: 'VISITOR_PASS',
          resourceId: passId.data,
        },
      });
      return 'entered';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    if (result === 'missing')
      return fail(
        res,
        409,
        'VISITOR_NOT_AUTHORIZED',
        'This visitor is not approved or the approval has expired',
      );
    if (result === 'already_inside')
      return fail(res, 409, 'VISITOR_ALREADY_INSIDE', 'This visitor already has an active entry');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

visitorsRouter.patch('/arrivals/:passId/destination', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const passId = uuid.safeParse(req.params.passId);
  const parsed = z.object({ flatId: uuid }).strict().safeParse(req.body);
  if (!societyId.success || !passId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Choose a valid destination flat');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      if (currentMember.role !== 'SECURITY_GUARD') return 'forbidden';
      await lockSocietyGate(tx, societyId.data);
      const flat = await tx.flat.findFirst({
        where: { id: parsed.data.flatId, societyId: societyId.data },
        select: { id: true },
      });
      if (!flat) return 'flat_missing';
      const changed = await tx.visitorPass.updateMany({
        where: {
          id: passId.data,
          societyId: societyId.data,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
          expiresAt: { gt: new Date() },
        },
        data: {
          flatId: flat.id,
          status: 'PENDING_APPROVAL',
          authorizedAt: null,
          authorizedById: null,
        },
      });
      if (!changed.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'VISITOR_DESTINATION_CHANGED',
          resourceType: 'VISITOR_PASS',
          resourceId: passId.data,
        },
      });
      return 'changed';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    if (result === 'flat_missing') return fail(res, 404, 'FLAT_NOT_FOUND', 'Flat not found');
    if (result === 'missing')
      return fail(
        res,
        409,
        'VISITOR_ARRIVAL_NOT_PENDING',
        'Only an unexpired pending or approved arrival can change destination',
      );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/passes', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = passSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the visitor details and expected time');
  try {
    const token = randomBytes(32).toString('base64url');
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (currentMember.role === 'SECURITY_GUARD') return { kind: 'forbidden' };
      const flat = await tx.flat.findFirst({
        where: { id: parsed.data.flatId, societyId: societyId.data },
        select: { id: true },
      });
      if (!flat) return { kind: 'flat_missing' };
      if (currentMember.role === 'RESIDENT') {
        const resident = await tx.resident.findFirst({
          where: {
            societyId: societyId.data,
            flatId: flat.id,
            email: req.auth.user.email,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (!resident) return { kind: 'flat_forbidden' };
      }
      const expectedAt = new Date(parsed.data.expectedAt);
      const expiresAt = new Date(expectedAt.getTime() + 6 * 60 * 60 * 1000);
      const pass = await tx.visitorPass.create({
        data: {
          societyId: societyId.data,
          flatId: flat.id,
          createdById: req.auth.user.id,
          tokenHash: hashCode(token),
          visitorName: parsed.data.visitorName,
          visitorPhone: parsed.data.visitorPhone || null,
          purpose: parsed.data.purpose,
          expectedAt,
          expiresAt,
        },
        select: {
          id: true,
          visitorName: true,
          purpose: true,
          expectedAt: true,
          expiresAt: true,
          status: true,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'VISITOR_PASS_CREATED',
          resourceType: 'VISITOR_PASS',
          resourceId: pass.id,
        },
      });
      return { kind: 'created', pass };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guards cannot create visitor passes');
    if (result.kind === 'flat_missing') return fail(res, 404, 'FLAT_NOT_FOUND', 'Flat not found');
    if (result.kind === 'flat_forbidden')
      return fail(
        res,
        403,
        'FLAT_FORBIDDEN',
        'A resident can only create passes for their registered flat',
      );
    res.status(201).json({ pass: result.pass, code: token });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/verify', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = verifySchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Enter a valid visitor pass code');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (!isGuard(currentMember.role)) return { kind: 'forbidden' };
      await lockSocietyGate(tx, societyId.data);
      const pass = await tx.visitorPass.findFirst({
        where: { societyId: societyId.data, tokenHash: hashCode(parsed.data.code) },
        select: {
          id: true,
          flatId: true,
          visitorName: true,
          visitorPhone: true,
          visitorType: true,
          purpose: true,
          expectedAt: true,
          expiresAt: true,
          status: true,
          flat: { select: { flatNumber: true, building: { select: { name: true } } } },
        },
      });
      if (!pass) return { kind: 'invalid' };
      const now = new Date();
      if (pass.status !== 'EXPECTED') return { kind: 'used' };
      if (pass.expectedAt > now) return { kind: 'early' };
      if (pass.expiresAt <= now) {
        await tx.visitorPass.updateMany({
          where: { id: pass.id, societyId: societyId.data, status: 'EXPECTED' },
          data: { status: 'EXPIRED' },
        });
        return { kind: 'expired' };
      }
      const duplicateActiveVisitor = await tx.visitorPass.findFirst({
        where: {
          societyId: societyId.data,
          id: { not: pass.id },
          status: 'CHECKED_IN',
          ...(pass.visitorPhone
            ? { visitorPhone: pass.visitorPhone }
            : { visitorName: pass.visitorName, flatId: pass.flatId }),
        },
        select: { id: true },
      });
      if (duplicateActiveVisitor) return { kind: 'already_inside' };
      const checkedIn = await tx.visitorPass.updateMany({
        where: {
          id: pass.id,
          societyId: societyId.data,
          status: 'EXPECTED',
          expiresAt: { gt: now },
        },
        data: { status: 'CHECKED_IN', checkedInAt: now, checkedInById: req.auth.user.id },
      });
      if (!checkedIn.count) return { kind: 'used' };
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'VISITOR_CHECKED_IN',
          resourceType: 'VISITOR_PASS',
          resourceId: pass.id,
        },
      });
      return { kind: 'checked_in', pass };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    if (result.kind === 'invalid')
      return fail(res, 404, 'VISITOR_PASS_NOT_FOUND', 'Pass not found');
    if (result.kind === 'used')
      return fail(
        res,
        409,
        'VISITOR_PASS_USED',
        'This visitor pass has already been used or cancelled',
      );
    if (result.kind === 'early')
      return fail(res, 409, 'VISITOR_NOT_EXPECTED', 'This visitor is not expected yet');
    if (result.kind === 'expired')
      return fail(res, 410, 'VISITOR_PASS_EXPIRED', 'This visitor pass has expired');
    if (result.kind === 'already_inside')
      return fail(res, 409, 'VISITOR_ALREADY_INSIDE', 'This visitor already has an active entry');
    res.json({ checkedIn: true, pass: result.pass });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/passes/:passId/checkout', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const passId = uuid.safeParse(req.params.passId);
  if (!societyId.success || !passId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid visitor pass');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      if (!isGuard(currentMember.role)) return 'forbidden';
      const updated = await tx.visitorPass.updateMany({
        where: { id: passId.data, societyId: societyId.data, status: 'CHECKED_IN' },
        data: { status: 'CHECKED_OUT', checkedOutAt: new Date(), checkedOutById: req.auth.user.id },
      });
      if (!updated.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'VISITOR_CHECKED_OUT',
          resourceType: 'VISITOR_PASS',
          resourceId: passId.data,
        },
      });
      return 'checked_out';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    if (result === 'missing')
      return fail(
        res,
        409,
        'VISITOR_NOT_CHECKED_IN',
        'Only checked-in visitors can be checked out',
      );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/passes/:passId/cancel', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const passId = uuid.safeParse(req.params.passId);
  if (!societyId.success || !passId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid visitor pass');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      const updated = await tx.visitorPass.updateMany({
        where: {
          id: passId.data,
          societyId: societyId.data,
          status: 'EXPECTED',
          expectedAt: { gt: new Date() },
          ...(!canSeeAll(currentMember.role) ? { createdById: req.auth.user.id } : {}),
        },
        data: { status: 'CANCELLED' },
      });
      if (!updated.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'VISITOR_PASS_CANCELLED',
          resourceType: 'VISITOR_PASS',
          resourceId: passId.data,
        },
      });
      return 'cancelled';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'missing')
      return fail(res, 404, 'VISITOR_PASS_NOT_FOUND', 'A cancellable pass was not found');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/passes/:passId/delivery-handover', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const passId = uuid.safeParse(req.params.passId);
  const parsed = z
    .object({ outcome: z.enum(['HANDED_AT_GATE', 'TAKEN_DOORSTEP', 'REFUSED']) })
    .strict()
    .safeParse(req.body);
  if (!societyId.success || !passId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Choose a valid delivery handover outcome');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      if (currentMember.role !== 'SECURITY_GUARD') return 'forbidden';
      const changed = await tx.visitorPass.updateMany({
        where: {
          id: passId.data,
          societyId: societyId.data,
          visitorType: 'DELIVERY',
          status: 'CHECKED_IN',
          deliveryHandoverStatus: 'NOT_RECORDED',
        },
        data: {
          deliveryHandoverStatus: parsed.data.outcome,
          deliveryHandoverAt: new Date(),
          deliveryHandoverById: req.auth.user.id,
        },
      });
      if (!changed.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'DELIVERY_HANDOVER_RECORDED',
          resourceType: 'VISITOR_PASS',
          resourceId: passId.data,
        },
      });
      return 'updated';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    if (result === 'missing')
      return fail(
        res,
        409,
        'DELIVERY_NOT_ACTIVE',
        'Only an active delivery without a recorded handover can be updated',
      );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

const incidentSchema = z
  .object({
    category: z.enum([
      'SUSPICIOUS_ACTIVITY',
      'UNAUTHORIZED_ENTRY',
      'LOST_ITEM',
      'EMERGENCY',
      'OTHER',
    ]),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    description: z.string().trim().min(5).max(2000),
    location: z.string().trim().max(160).optional().default(''),
  })
  .strict();

visitorsRouter.get('/emergency', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (currentMember.role !== 'SECURITY_GUARD')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    const visitors = await prisma.visitorPass.findMany({
      where: { societyId: societyId.data, status: 'CHECKED_IN' },
      orderBy: [{ checkedInAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        visitorName: true,
        visitorPhone: true,
        visitorType: true,
        vehicleNumber: true,
        vehicleType: true,
        parkingLocation: true,
        parkingAlert: true,
        groupSize: true,
        expectedDurationMinutes: true,
        deliveryPlatform: true,
        deliveryHandoverStatus: true,
        purpose: true,
        status: true,
        checkedInAt: true,
        checkedOutAt: true,
        createdAt: true,
        checkedInBy: { select: { email: true } },
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
      },
    });
    res.json({ generatedAt: new Date(), count: visitors.length, visitors });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.get('/incidents', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (currentMember.role !== 'SECURITY_GUARD')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    const incidents = await prisma.guardIncident.findMany({
      where: { societyId: societyId.data },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        category: true,
        severity: true,
        status: true,
        description: true,
        location: true,
        createdAt: true,
        resolvedAt: true,
        reporter: { select: { email: true } },
      },
    });
    res.json({ incidents });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/incidents', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = incidentSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(
      res,
      400,
      'VALIDATION_ERROR',
      'Enter an incident category, severity and description',
    );
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (currentMember.role !== 'SECURITY_GUARD') return { kind: 'forbidden' };
      const incident = await tx.guardIncident.create({
        data: {
          societyId: societyId.data,
          reportedById: req.auth.user.id,
          category: parsed.data.category,
          severity: parsed.data.severity,
          description: parsed.data.description,
          location: parsed.data.location || null,
        },
        select: { id: true, category: true, severity: true, status: true, createdAt: true },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'GUARD_INCIDENT_REPORTED',
          resourceType: 'GUARD_INCIDENT',
          resourceId: incident.id,
        },
      });
      return { kind: 'created', incident };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    res.status(201).json({ incident: result.incident });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/incidents/:incidentId/resolve', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const incidentId = uuid.safeParse(req.params.incidentId);
  if (!societyId.success || !incidentId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid incident');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      if (currentMember.role !== 'SECURITY_GUARD') return 'forbidden';
      const updated = await tx.guardIncident.updateMany({
        where: { id: incidentId.data, societyId: societyId.data, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: req.auth.user.id },
      });
      if (!updated.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'GUARD_INCIDENT_RESOLVED',
          resourceType: 'GUARD_INCIDENT',
          resourceId: incidentId.data,
        },
      });
      return 'resolved';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    if (result === 'missing')
      return fail(res, 409, 'INCIDENT_NOT_OPEN', 'This incident is already resolved');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

visitorsRouter.get('/handovers', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (currentMember.role !== 'SECURITY_GUARD')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    const handovers = await prisma.guardShiftHandover.findMany({
      where: { societyId: societyId.data },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30,
      select: {
        id: true,
        activeVisitorsCount: true,
        pendingApprovalsCount: true,
        openIncidentsCount: true,
        notes: true,
        createdAt: true,
        guard: { select: { email: true } },
      },
    });
    res.json({ handovers });
  } catch (error) {
    next(error);
  }
});

visitorsRouter.post('/handovers', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = z
    .object({ notes: z.string().trim().min(3).max(2000) })
    .strict()
    .safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Add a short handover note');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (currentMember.role !== 'SECURITY_GUARD') return { kind: 'forbidden' };
      const [activeVisitorsCount, pendingApprovalsCount, openIncidentsCount] = await Promise.all([
        tx.visitorPass.count({ where: { societyId: societyId.data, status: 'CHECKED_IN' } }),
        tx.visitorPass.count({ where: { societyId: societyId.data, status: 'PENDING_APPROVAL' } }),
        tx.guardIncident.count({ where: { societyId: societyId.data, status: 'OPEN' } }),
      ]);
      const handover = await tx.guardShiftHandover.create({
        data: {
          societyId: societyId.data,
          guardId: req.auth.user.id,
          activeVisitorsCount,
          pendingApprovalsCount,
          openIncidentsCount,
          notes: parsed.data.notes,
        },
        select: {
          id: true,
          activeVisitorsCount: true,
          pendingApprovalsCount: true,
          openIncidentsCount: true,
          notes: true,
          createdAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'GUARD_SHIFT_HANDOVER_RECORDED',
          resourceType: 'GUARD_SHIFT_HANDOVER',
          resourceId: handover.id,
        },
      });
      return { kind: 'created', handover };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Security guard access is required');
    res.status(201).json({ handover: result.handover });
  } catch (error) {
    next(error);
  }
});
