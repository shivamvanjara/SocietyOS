import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const expensesRouter = express.Router({ mergeParams: true });

const uuid = z.uuid();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
});
const amountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  })
  .refine((value) => value > 0n);
const expenseSchema = z
  .object({
    category: z.string().trim().min(2).max(80),
    description: z.string().trim().min(2).max(200),
    vendor: z.string().trim().max(160).nullable().optional(),
    amount: amountSchema,
    spentAt: z.iso.date(),
    reference: z.string().trim().max(100).nullable().optional(),
  })
  .strict();
const expenseIdSchema = z.uuid();
const reviewSchema = z.object({ reason: z.string().trim().min(2).max(500) }).strict();
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_EXPENSE = 10;
const attachmentTypes = new Map([
  ['application/pdf', Buffer.from('%PDF-')],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
]);

function cleanFilename(header) {
  let filename = 'bill-document';
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

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

async function canManage(db, societyId, userId) {
  return db.societyMembership.findFirst({
    where: {
      societyId,
      userId,
      active: true,
      role: { in: ['SOCIETY_ADMIN', 'ACCOUNTANT'] },
      society: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
}

expensesRouter.use(requireAuthenticated);

expensesRouter.get('/', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const page = pageSchema.safeParse(req.query);
  if (!societyId.success || !page.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    if (!(await canManage(prisma, societyId.data, req.auth.user.id)))
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const expenses = await prisma.expense.findMany({
      where: { societyId: societyId.data },
      include: {
        attachments: {
          select: { id: true, originalName: true, mimeType: true, byteSize: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ spentAt: 'desc' }, { createdAt: 'desc' }],
      take: page.data.limit + 1,
      ...(page.data.cursor ? { cursor: { id: page.data.cursor }, skip: 1 } : {}),
    });
    const hasMore = expenses.length > page.data.limit;
    if (hasMore) expenses.pop();
    const totalPaise = expenses
      .filter((expense) => expense.status === 'APPROVED')
      .reduce((sum, expense) => sum + expense.amountPaise, 0n);
    const pendingPaise = expenses
      .filter((expense) => expense.status === 'SUBMITTED')
      .reduce((sum, expense) => sum + expense.amountPaise, 0n);
    res.json({
      expenses: expenses.map(({ amountPaise, ...expense }) => ({
        ...expense,
        amount: Number(amountPaise) / 100,
      })),
      total: Number(totalPaise) / 100,
      pendingTotal: Number(pendingPaise) / 100,
      nextCursor: hasMore ? (expenses.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    next(error);
  }
});

expensesRouter.post('/', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = expenseSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the expense details and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!(await canManage(tx, societyId.data, req.auth.user.id))) return null;
      const expense = await tx.expense.create({
        data: {
          societyId: societyId.data,
          category: parsed.data.category,
          description: parsed.data.description,
          vendor: parsed.data.vendor || null,
          amountPaise: parsed.data.amount,
          spentAt: new Date(`${parsed.data.spentAt}T00:00:00.000Z`),
          reference: parsed.data.reference || null,
          status: 'SUBMITTED',
          createdById: req.auth.user.id,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'EXPENSE_SUBMITTED',
          resourceType: 'EXPENSE',
          resourceId: expense.id,
        },
      });
      return expense;
    });
    if (!result) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const { amountPaise, ...expense } = result;
    res.status(201).json({ expense: { ...expense, amount: Number(amountPaise) / 100 } });
  } catch (error) {
    next(error);
  }
});

expensesRouter.post(
  '/:expenseId/attachments',
  requireCsrf,
  express.raw({
    type: [...attachmentTypes.keys()],
    limit: MAX_ATTACHMENT_BYTES,
  }),
  async (req, res, next) => {
    const societyId = uuid.safeParse(req.params.societyId);
    const expenseId = expenseIdSchema.safeParse(req.params.expenseId);
    const mimeType = req.get('content-type')?.split(';')[0].trim().toLowerCase();
    const signature = attachmentTypes.get(mimeType);
    const filename = cleanFilename(req.get('x-file-name'));
    if (!societyId.success || !expenseId.success)
      return fail(res, 400, 'VALIDATION_ERROR', 'Invalid expense');
    if (!signature || !Buffer.isBuffer(req.body))
      return fail(res, 415, 'UNSUPPORTED_FILE_TYPE', 'Upload a PDF, PNG, or JPEG document');
    if (!filename) return fail(res, 400, 'INVALID_FILENAME', 'Enter a valid file name');
    if (
      req.body.length < signature.length ||
      !req.body.subarray(0, signature.length).equals(signature)
    )
      return fail(
        res,
        415,
        'FILE_CONTENT_MISMATCH',
        'The document content does not match its file type',
      );

    try {
      const result = await prisma.$transaction(async (tx) => {
        if (!(await canManage(tx, societyId.data, req.auth.user.id)))
          return { kind: 'inaccessible' };
        await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId.data}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
        const expense = await tx.expense.findFirst({
          where: { id: expenseId.data, societyId: societyId.data },
          select: { id: true },
        });
        if (!expense) return { kind: 'missing' };
        const count = await tx.expenseAttachment.count({
          where: { societyId: societyId.data, expenseId: expense.id },
        });
        if (count >= MAX_ATTACHMENTS_PER_EXPENSE) return { kind: 'limit' };
        const attachment = await tx.expenseAttachment.create({
          data: {
            societyId: societyId.data,
            expenseId: expense.id,
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
            eventType: 'EXPENSE_DOCUMENT_ADDED',
            resourceType: 'EXPENSE',
            resourceId: expense.id,
          },
        });
        return { kind: 'created', attachment };
      });
      if (result.kind === 'inaccessible')
        return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (result.kind === 'missing')
        return fail(res, 404, 'EXPENSE_NOT_FOUND', 'Expense not found');
      if (result.kind === 'limit')
        return fail(res, 409, 'ATTACHMENT_LIMIT', 'An expense can have at most 10 documents');
      return res.status(201).json({ attachment: result.attachment });
    } catch (error) {
      next(error);
    }
  },
);

expensesRouter.get('/:expenseId/attachments/:attachmentId', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const expenseId = expenseIdSchema.safeParse(req.params.expenseId);
  const attachmentId = expenseIdSchema.safeParse(req.params.attachmentId);
  if (!societyId.success || !expenseId.success || !attachmentId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid expense document');
  try {
    if (!(await canManage(prisma, societyId.data, req.auth.user.id)))
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const attachment = await prisma.expenseAttachment.findFirst({
      where: {
        id: attachmentId.data,
        societyId: societyId.data,
        expenseId: expenseId.data,
      },
    });
    if (!attachment) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
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

expensesRouter.post('/:expenseId/approve', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const expenseId = expenseIdSchema.safeParse(req.params.expenseId);
  if (!societyId.success || !expenseId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid expense');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const administrator = await tx.societyMembership.findFirst({
        where: {
          societyId: societyId.data,
          userId: req.auth.user.id,
          active: true,
          role: 'SOCIETY_ADMIN',
          society: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (!administrator) return { kind: 'inaccessible' };
      await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId.data}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
      const expense = await tx.expense.findFirst({
        where: { id: expenseId.data, societyId: societyId.data },
        select: { id: true, status: true, createdById: true },
      });
      if (!expense) return { kind: 'missing' };
      if (expense.status !== 'SUBMITTED') return { kind: 'reviewed' };
      if (expense.createdById === req.auth.user.id) return { kind: 'self' };
      await tx.expense.update({
        where: { id: expense.id },
        data: { status: 'APPROVED', reviewedById: req.auth.user.id, reviewedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'EXPENSE_APPROVED',
          resourceType: 'EXPENSE',
          resourceId: expense.id,
        },
      });
      return { kind: 'approved' };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'missing') return fail(res, 404, 'EXPENSE_NOT_FOUND', 'Expense not found');
    if (result.kind === 'reviewed')
      return fail(res, 409, 'EXPENSE_ALREADY_REVIEWED', 'This expense has already been reviewed');
    if (result.kind === 'self')
      return fail(
        res,
        409,
        'SELF_APPROVAL_NOT_ALLOWED',
        'You cannot approve an expense you submitted',
      );
    return res.status(200).json({ status: 'APPROVED' });
  } catch (error) {
    next(error);
  }
});

expensesRouter.post('/:expenseId/reject', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const expenseId = expenseIdSchema.safeParse(req.params.expenseId);
  const parsed = reviewSchema.safeParse(req.body);
  if (!societyId.success || !expenseId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Enter a rejection reason and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const administrator = await tx.societyMembership.findFirst({
        where: {
          societyId: societyId.data,
          userId: req.auth.user.id,
          active: true,
          role: 'SOCIETY_ADMIN',
          society: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (!administrator) return { kind: 'inaccessible' };
      await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${expenseId.data}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
      const expense = await tx.expense.findFirst({
        where: { id: expenseId.data, societyId: societyId.data },
        select: { id: true, status: true },
      });
      if (!expense) return { kind: 'missing' };
      if (expense.status !== 'SUBMITTED') return { kind: 'reviewed' };
      await tx.expense.update({
        where: { id: expense.id },
        data: {
          status: 'REJECTED',
          reviewedById: req.auth.user.id,
          reviewedAt: new Date(),
          rejectionReason: parsed.data.reason,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'EXPENSE_REJECTED',
          resourceType: 'EXPENSE',
          resourceId: expense.id,
        },
      });
      return { kind: 'rejected' };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'missing') return fail(res, 404, 'EXPENSE_NOT_FOUND', 'Expense not found');
    if (result.kind === 'reviewed')
      return fail(res, 409, 'EXPENSE_ALREADY_REVIEWED', 'This expense has already been reviewed');
    return res.status(200).json({ status: 'REJECTED' });
  } catch (error) {
    next(error);
  }
});
