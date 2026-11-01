import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const complaintsRouter = express.Router({ mergeParams: true });
const uuid = z.uuid();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
});
const createSchema = z
  .object({
    category: z.string().trim().min(2).max(80),
    title: z.string().trim().min(3).max(180),
    description: z.string().trim().min(3).max(5000),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  })
  .strict();
const updateSchema = z
  .object({
    status: z.enum(['ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
    resolution: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => value.status !== 'RESOLVED' || Boolean(value.resolution?.trim()));
const commentSchema = z.object({ body: z.string().trim().min(1).max(3000) }).strict();
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_COMPLAINT = 5;
const attachmentTypes = new Map([
  ['image/jpeg', { signature: Buffer.from([0xff, 0xd8, 0xff]) }],
  ['image/png', { signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
  ['image/webp', { signature: Buffer.from('RIFF'), marker: Buffer.from('WEBP'), markerOffset: 8 }],
]);

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

function cleanFilename(header) {
  let filename = 'complaint-image';
  try {
    filename = decodeURIComponent(header || filename);
  } catch {
    return null;
  }
  filename = filename
    .split(/[\\/]/)
    .at(-1)
    .replace(/[^\p{L}\p{N} ._()\-]/gu, '_')
    .trim()
    .slice(0, 160);
  return filename || null;
}

function matchesSignature(bytes, { signature, marker, markerOffset = 0 }) {
  return (
    bytes.length >= Math.max(signature.length, markerOffset + (marker?.length ?? 0)) &&
    bytes.subarray(0, signature.length).equals(signature) &&
    (!marker || bytes.subarray(markerOffset, markerOffset + marker.length).equals(marker))
  );
}

const transitions = {
  SUBMITTED: ['ACKNOWLEDGED', 'CLOSED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'CLOSED'],
  IN_PROGRESS: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

complaintsRouter.use(requireAuthenticated);

complaintsRouter.get('/', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const page = pageSchema.safeParse(req.query);
  if (!societyId.success || !page.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid complaint query');
  try {
    const membership = await member(prisma, societyId.data, req.auth.user.id);
    if (!membership) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const where = {
      societyId: societyId.data,
      ...(!isStaff(membership.role) ? { submittedById: req.auth.user.id } : {}),
    };
    const rows = await prisma.complaint.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.data.limit + 1,
      ...(page.data.cursor ? { cursor: { id: page.data.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        category: true,
        title: true,
        description: true,
        priority: true,
        status: true,
        resolution: true,
        createdAt: true,
        updatedAt: true,
        submitter: { select: { email: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, authorId: true, body: true, createdAt: true },
        },
        attachments: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, originalName: true, mimeType: true, byteSize: true, createdAt: true },
        },
      },
    });
    const hasMore = rows.length > page.data.limit;
    if (hasMore) rows.pop();
    res.json({
      complaints: rows,
      nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
      canManage: isStaff(membership.role),
      viewerUserId: req.auth.user.id,
    });
  } catch (error) {
    next(error);
  }
});

complaintsRouter.post('/', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = createSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the complaint details and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!(await member(tx, societyId.data, req.auth.user.id))) return null;
      const complaint = await tx.complaint.create({
        data: { societyId: societyId.data, submittedById: req.auth.user.id, ...parsed.data },
        select: {
          id: true,
          title: true,
          category: true,
          priority: true,
          status: true,
          createdAt: true,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'COMPLAINT_SUBMITTED',
          resourceType: 'COMPLAINT',
          resourceId: complaint.id,
        },
      });
      return complaint;
    });
    if (!result) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    res.status(201).json({ complaint: result });
  } catch (error) {
    next(error);
  }
});

complaintsRouter.post(
  '/:complaintId/attachments',
  requireCsrf,
  express.raw({ type: [...attachmentTypes.keys()], limit: MAX_ATTACHMENT_BYTES }),
  async (req, res, next) => {
    const societyId = uuid.safeParse(req.params.societyId);
    const complaintId = uuid.safeParse(req.params.complaintId);
    const mimeType = req.get('content-type')?.split(';')[0].trim().toLowerCase();
    const type = attachmentTypes.get(mimeType);
    const filename = cleanFilename(req.get('x-file-name'));
    if (!societyId.success || !complaintId.success)
      return fail(res, 400, 'VALIDATION_ERROR', 'Invalid complaint');
    if (!type || !Buffer.isBuffer(req.body))
      return fail(res, 415, 'UNSUPPORTED_FILE_TYPE', 'Upload a JPEG, PNG, or WebP image');
    if (!filename) return fail(res, 400, 'INVALID_FILENAME', 'Enter a valid file name');
    if (!matchesSignature(req.body, type))
      return fail(res, 415, 'FILE_CONTENT_MISMATCH', 'The image content does not match its type');

    try {
      const result = await prisma.$transaction(async (tx) => {
        const membership = await member(tx, societyId.data, req.auth.user.id);
        if (!membership) return { kind: 'inaccessible' };
        await tx.$queryRaw`SELECT id FROM complaints WHERE id = ${complaintId.data}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
        const complaint = await tx.complaint.findFirst({
          where: {
            id: complaintId.data,
            societyId: societyId.data,
            ...(!isStaff(membership.role) ? { submittedById: req.auth.user.id } : {}),
          },
          select: { id: true },
        });
        if (!complaint) return { kind: 'missing' };
        const count = await tx.complaintAttachment.count({
          where: { societyId: societyId.data, complaintId: complaint.id },
        });
        if (count >= MAX_ATTACHMENTS_PER_COMPLAINT) return { kind: 'limit' };
        const attachment = await tx.complaintAttachment.create({
          data: {
            societyId: societyId.data,
            complaintId: complaint.id,
            uploadedById: req.auth.user.id,
            originalName: filename,
            mimeType,
            byteSize: req.body.length,
            bytes: req.body,
          },
          select: { id: true, originalName: true, mimeType: true, byteSize: true, createdAt: true },
        });
        await tx.auditLog.create({
          data: {
            societyId: societyId.data,
            actorUserId: req.auth.user.id,
            eventType: 'COMPLAINT_ATTACHMENT_ADDED',
            resourceType: 'COMPLAINT',
            resourceId: complaint.id,
          },
        });
        return { kind: 'created', attachment };
      });
      if (result.kind === 'inaccessible')
        return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (result.kind === 'missing')
        return fail(res, 404, 'COMPLAINT_NOT_FOUND', 'Complaint not found');
      if (result.kind === 'limit')
        return fail(res, 409, 'ATTACHMENT_LIMIT', 'A complaint can have at most five images');
      return res.status(201).json({ attachment: result.attachment });
    } catch (error) {
      next(error);
    }
  },
);

complaintsRouter.get('/:complaintId/attachments/:attachmentId', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const complaintId = uuid.safeParse(req.params.complaintId);
  const attachmentId = uuid.safeParse(req.params.attachmentId);
  if (!societyId.success || !complaintId.success || !attachmentId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid complaint image');
  try {
    const membership = await member(prisma, societyId.data, req.auth.user.id);
    if (!membership) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const complaint = await prisma.complaint.findFirst({
      where: {
        id: complaintId.data,
        societyId: societyId.data,
        ...(!isStaff(membership.role) ? { submittedById: req.auth.user.id } : {}),
      },
      select: { id: true },
    });
    if (!complaint) return fail(res, 404, 'COMPLAINT_NOT_FOUND', 'Complaint not found');
    const attachment = await prisma.complaintAttachment.findFirst({
      where: { id: attachmentId.data, societyId: societyId.data, complaintId: complaint.id },
    });
    if (!attachment) return fail(res, 404, 'IMAGE_NOT_FOUND', 'Complaint image not found');
    const safeName = encodeURIComponent(attachment.originalName).replaceAll("'", '%27');
    res.set({
      'Content-Type': attachment.mimeType,
      'Content-Length': String(attachment.byteSize),
      'Content-Disposition': `attachment; filename*=UTF-8''${safeName}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).send(Buffer.from(attachment.bytes));
  } catch (error) {
    next(error);
  }
});

complaintsRouter.patch('/:complaintId', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const complaintId = uuid.safeParse(req.params.complaintId);
  const parsed = updateSchema.safeParse(req.body);
  if (!societyId.success || !complaintId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the complaint update and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const membership = await member(tx, societyId.data, req.auth.user.id);
      if (!membership) return { kind: 'inaccessible' };
      if (!isStaff(membership.role)) return { kind: 'forbidden' };
      const complaint = await tx.complaint.findFirst({
        where: { id: complaintId.data, societyId: societyId.data },
        select: { id: true, status: true },
      });
      if (!complaint) return { kind: 'missing' };
      if (
        parsed.data.status !== complaint.status &&
        !transitions[complaint.status].includes(parsed.data.status)
      )
        return { kind: 'invalid_transition' };
      const updated = await tx.complaint.updateMany({
        where: { id: complaint.id, societyId: societyId.data, status: complaint.status },
        data: parsed.data,
      });
      if (!updated.count) return { kind: 'invalid_transition' };
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: `COMPLAINT_${parsed.data.status}`,
          resourceType: 'COMPLAINT',
          resourceId: complaintId.data,
        },
      });
      return { kind: 'updated' };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'forbidden')
      return fail(res, 403, 'FORBIDDEN', 'Committee access is required');
    if (result.kind === 'missing')
      return fail(res, 404, 'COMPLAINT_NOT_FOUND', 'Complaint not found');
    if (result.kind === 'invalid_transition')
      return fail(
        res,
        409,
        'INVALID_STATUS_TRANSITION',
        'This complaint cannot move to that status',
      );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

complaintsRouter.post('/:complaintId/comments', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const complaintId = uuid.safeParse(req.params.complaintId);
  const parsed = commentSchema.safeParse(req.body);
  if (!societyId.success || !complaintId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the reply and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const membership = await member(tx, societyId.data, req.auth.user.id);
      if (!membership) return { kind: 'inaccessible' };
      const complaint = await tx.complaint.findFirst({
        where: {
          id: complaintId.data,
          societyId: societyId.data,
          ...(!isStaff(membership.role) ? { submittedById: req.auth.user.id } : {}),
        },
        select: { id: true },
      });
      if (!complaint) return { kind: 'missing' };
      const comment = await tx.complaintComment.create({
        data: {
          societyId: societyId.data,
          complaintId: complaint.id,
          authorId: req.auth.user.id,
          body: parsed.data.body,
        },
      });
      return { kind: 'created', comment };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'missing')
      return fail(res, 404, 'COMPLAINT_NOT_FOUND', 'Complaint not found');
    res.status(201).json({ comment: result.comment });
  } catch (error) {
    next(error);
  }
});
