import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const facilitiesRouter = express.Router({ mergeParams: true });
const uuid = z.uuid();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
});
const facilitySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    capacity: z.number().int().min(1).max(1000).default(1),
  })
  .strict();
const bookingSchema = z
  .object({
    facilityId: uuid,
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    purpose: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((value) => {
    const start = Date.parse(value.startsAt);
    const end = Date.parse(value.endsAt);
    return start > Date.now() && end > start && end - start <= 12 * 60 * 60 * 1000;
  });

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

async function member(db, societyId, userId) {
  return db.societyMembership.findFirst({
    where: { societyId, userId, active: true, society: { status: 'ACTIVE' } },
    select: { id: true, role: true },
  });
}

function isStaff(role) {
  return ['SOCIETY_ADMIN', 'COMMITTEE_MEMBER'].includes(role);
}

facilitiesRouter.use(requireAuthenticated);

facilitiesRouter.get('/', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const facilities = await prisma.facility.findMany({
      where: {
        societyId: societyId.data,
        ...(isStaff(currentMember.role) ? {} : { active: true }),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, description: true, capacity: true, active: true },
    });
    res.json({ facilities, canManage: isStaff(currentMember.role) });
  } catch (error) {
    next(error);
  }
});

facilitiesRouter.post('/', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = facilitySchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the facility details and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (currentMember.role !== 'SOCIETY_ADMIN') return { kind: 'forbidden' };
      const facility = await tx.facility.create({
        data: { societyId: societyId.data, ...parsed.data },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'FACILITY_CREATED',
          resourceType: 'FACILITY',
          resourceId: facility.id,
        },
      });
      return { kind: 'created', facility };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Society administrator access is required');
    res.status(201).json({ facility: result.facility });
  } catch (error) {
    if (error?.code === 'P2002')
      return fail(res, 409, 'FACILITY_NAME_TAKEN', 'This facility name is already in use');
    next(error);
  }
});

facilitiesRouter.patch('/:facilityId', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const facilityId = uuid.safeParse(req.params.facilityId);
  const parsed = z.object({ active: z.boolean() }).strict().safeParse(req.body);
  if (!societyId.success || !facilityId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid facility update');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      if (currentMember.role !== 'SOCIETY_ADMIN') return 'forbidden';
      const updated = await tx.facility.updateMany({
        where: { id: facilityId.data, societyId: societyId.data },
        data: parsed.data,
      });
      if (!updated.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: parsed.data.active ? 'FACILITY_ACTIVATED' : 'FACILITY_DEACTIVATED',
          resourceType: 'FACILITY',
          resourceId: facilityId.data,
        },
      });
      return 'updated';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Society administrator access is required');
    if (result === 'missing') return fail(res, 404, 'FACILITY_NOT_FOUND', 'Facility not found');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

facilitiesRouter.get('/bookings', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const page = pageSchema.safeParse(req.query);
  if (!societyId.success || !page.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid booking query');
  try {
    const currentMember = await member(prisma, societyId.data, req.auth.user.id);
    if (!currentMember) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const rows = await prisma.facilityBooking.findMany({
      where: {
        societyId: societyId.data,
        ...(!isStaff(currentMember.role) ? { requesterId: req.auth.user.id } : {}),
      },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      take: page.data.limit + 1,
      ...(page.data.cursor ? { cursor: { id: page.data.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        facilityId: true,
        startsAt: true,
        endsAt: true,
        purpose: true,
        status: true,
        createdAt: true,
        facility: { select: { name: true } },
        requester: { select: { email: true } },
      },
    });
    const hasMore = rows.length > page.data.limit;
    if (hasMore) rows.pop();
    res.json({
      bookings: rows,
      nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
      canManage: isStaff(currentMember.role),
    });
  } catch (error) {
    next(error);
  }
});

facilitiesRouter.post('/bookings', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = bookingSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Choose a future time slot up to 12 hours long');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!(await member(tx, societyId.data, req.auth.user.id))) return { kind: 'inaccessible' };
      await tx.$queryRaw`SELECT id FROM facilities WHERE id = ${parsed.data.facilityId}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
      const facility = await tx.facility.findFirst({
        where: { id: parsed.data.facilityId, societyId: societyId.data, active: true },
        select: { id: true },
      });
      if (!facility) return { kind: 'facility_missing' };
      const conflict = await tx.facilityBooking.findFirst({
        where: {
          societyId: societyId.data,
          facilityId: facility.id,
          status: { in: ['REQUESTED', 'APPROVED'] },
          startsAt: { lt: new Date(parsed.data.endsAt) },
          endsAt: { gt: new Date(parsed.data.startsAt) },
        },
        select: { id: true },
      });
      if (conflict) return { kind: 'conflict' };
      const booking = await tx.facilityBooking.create({
        data: {
          societyId: societyId.data,
          facilityId: facility.id,
          requesterId: req.auth.user.id,
          startsAt: new Date(parsed.data.startsAt),
          endsAt: new Date(parsed.data.endsAt),
          purpose: parsed.data.purpose || null,
        },
        select: { id: true, facilityId: true, startsAt: true, endsAt: true, status: true },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'FACILITY_BOOKING_REQUESTED',
          resourceType: 'FACILITY_BOOKING',
          resourceId: booking.id,
        },
      });
      return { kind: 'created', booking };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'facility_missing')
      return fail(res, 404, 'FACILITY_NOT_FOUND', 'Facility not found');
    if (result.kind === 'conflict')
      return fail(res, 409, 'BOOKING_CONFLICT', 'That time slot is already requested or approved');
    res.status(201).json({ booking: result.booking });
  } catch (error) {
    next(error);
  }
});

facilitiesRouter.patch('/bookings/:bookingId/status', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const bookingId = uuid.safeParse(req.params.bookingId);
  const parsed = z
    .object({ status: z.enum(['APPROVED', 'REJECTED']) })
    .strict()
    .safeParse(req.body);
  if (!societyId.success || !bookingId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid booking update');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return { kind: 'inaccessible' };
      if (!isStaff(currentMember.role)) return { kind: 'forbidden' };
      const booking = await tx.facilityBooking.findFirst({
        where: { id: bookingId.data, societyId: societyId.data },
        select: { id: true, facilityId: true, startsAt: true, endsAt: true, status: true },
      });
      if (!booking) return { kind: 'missing' };
      if (booking.status !== 'REQUESTED') return { kind: 'invalid_state' };
      if (parsed.data.status === 'APPROVED') {
        await tx.$queryRaw`SELECT id FROM facilities WHERE id = ${booking.facilityId}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
        const conflict = await tx.facilityBooking.findFirst({
          where: {
            societyId: societyId.data,
            facilityId: booking.facilityId,
            id: { not: booking.id },
            status: { in: ['REQUESTED', 'APPROVED'] },
            startsAt: { lt: booking.endsAt },
            endsAt: { gt: booking.startsAt },
          },
          select: { id: true },
        });
        if (conflict) return { kind: 'conflict' };
      }
      const updated = await tx.facilityBooking.updateMany({
        where: { id: booking.id, societyId: societyId.data, status: 'REQUESTED' },
        data: { status: parsed.data.status },
      });
      if (!updated.count) return { kind: 'invalid_state' };
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: `FACILITY_BOOKING_${parsed.data.status}`,
          resourceType: 'FACILITY_BOOKING',
          resourceId: booking.id,
        },
      });
      return { kind: 'updated' };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Committee access is required');
    if (result.kind === 'missing') return fail(res, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
    if (result.kind === 'conflict')
      return fail(res, 409, 'BOOKING_CONFLICT', 'That time slot is already requested or approved');
    if (result.kind === 'invalid_state')
      return fail(
        res,
        409,
        'INVALID_BOOKING_STATE',
        'Only pending requests can be approved or rejected',
      );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

facilitiesRouter.post('/bookings/:bookingId/cancel', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const bookingId = uuid.safeParse(req.params.bookingId);
  if (!societyId.success || !bookingId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid booking');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentMember = await member(tx, societyId.data, req.auth.user.id);
      if (!currentMember) return 'inaccessible';
      const updated = await tx.facilityBooking.updateMany({
        where: {
          id: bookingId.data,
          societyId: societyId.data,
          ...(!isStaff(currentMember.role) ? { requesterId: req.auth.user.id } : {}),
          status: { in: ['REQUESTED', 'APPROVED'] },
          startsAt: { gt: new Date() },
        },
        data: { status: 'CANCELLED' },
      });
      if (!updated.count) return 'missing';
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'FACILITY_BOOKING_CANCELLED',
          resourceType: 'FACILITY_BOOKING',
          resourceId: bookingId.data,
        },
      });
      return 'cancelled';
    });
    if (result === 'inaccessible') return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result === 'missing')
      return fail(res, 404, 'BOOKING_NOT_FOUND', 'A cancellable booking was not found');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
