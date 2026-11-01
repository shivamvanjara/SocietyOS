import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';
import { encryptRazorpaySecret, razorpayAccountEncryptionConfigured } from '../payments/secrets.js';

export const billingRouter = express.Router({ mergeParams: true });

const uuid = z.uuid();
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_INVOICE = 10;
const attachmentTypes = new Map([
  ['application/pdf', Buffer.from('%PDF-')],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
]);
const nullableText = (maxLength) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().min(1).max(maxLength).nullable(),
  );
const nullableAccountNumber = z.preprocess(
  (value) => (value === null ? null : typeof value === 'string' ? value.trim() || null : value),
  z
    .string()
    .regex(/^\d{6,34}$/)
    .nullable(),
);
const nullableIfsc = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() || null : value),
  z
    .string()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/)
    .nullable(),
);
const nullableUpiId = z.preprocess(
  (value) => (value === null ? null : typeof value === 'string' ? value.trim() || null : value),
  z
    .string()
    .regex(/^[A-Za-z0-9._-]{2,50}@[A-Za-z0-9.-]{2,50}$/)
    .nullable(),
);
const paymentInstructionsSchema = z
  .object({
    bankAccountName: nullableText(160),
    bankAccountNumber: nullableAccountNumber,
    bankName: nullableText(120),
    bankIfscCode: nullableIfsc,
    upiId: nullableUpiId,
    instructions: nullableText(500),
  })
  .strict()
  .refine(
    (details) => {
      const bankFields = [
        details.bankAccountName,
        details.bankAccountNumber,
        details.bankName,
        details.bankIfscCode,
      ];
      const allBankFieldsSet = bankFields.every(Boolean);
      const noBankFieldsSet = bankFields.every((value) => !value);
      return (
        (allBankFieldsSet || noBankFieldsSet) &&
        (allBankFieldsSet || Boolean(details.upiId) || !details.instructions)
      );
    },
    { message: 'Provide all bank fields, a UPI ID, or clear the transfer instructions' },
  );
const razorpayAccountSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      keyId: z
        .string()
        .trim()
        .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/),
      keySecret: z.string().trim().min(8).max(256),
      webhookSecret: z.string().trim().min(8).max(256),
    })
    .strict(),
]);
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
});
const money = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  })
  .refine((amount) => amount > 0n);
const issueSchema = z
  .object({
    flatId: uuid,
    description: z.string().trim().min(2).max(200),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    amount: money,
    dueDate: z.iso.date(),
  })
  .strict();
const generateSchema = z
  .object({
    description: z.string().trim().min(2).max(200),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    amount: money,
    dueDate: z.iso.date(),
    scope: z.enum(['OCCUPIED', 'ALL']).default('OCCUPIED'),
  })
  .strict();
const paymentSchema = z
  .object({
    amount: money,
    method: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER']),
    reference: z.string().trim().max(100).nullable().optional(),
    receivedAt: z.iso.datetime().optional(),
  })
  .strict();

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

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

const attachmentSelect = {
  id: true,
  originalName: true,
  mimeType: true,
  byteSize: true,
  createdAt: true,
};

function routeIds(req) {
  const societyId = uuid.safeParse(req.params.societyId);
  const invoiceId = req.params.invoiceId ? uuid.safeParse(req.params.invoiceId) : undefined;
  return societyId.success && (!invoiceId || invoiceId.success)
    ? { societyId: societyId.data, ...(invoiceId ? { invoiceId: invoiceId.data } : {}) }
    : null;
}

async function isAdmin(db, societyId, userId) {
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

billingRouter.use(requireAuthenticated);

billingRouter.get('/payment-instructions', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const membership = await prisma.societyMembership.findFirst({
      where: {
        societyId: societyId.data,
        userId: req.auth.user.id,
        active: true,
        role: { in: ['SOCIETY_ADMIN', 'ACCOUNTANT', 'RESIDENT'] },
        society: { status: 'ACTIVE' },
      },
      select: {
        society: {
          select: {
            bankAccountName: true,
            bankAccountNumber: true,
            bankName: true,
            bankIfscCode: true,
            upiId: true,
            transferInstructions: true,
          },
        },
      },
    });
    if (!membership) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const details = membership.society;
    const configured = Boolean(details.bankAccountNumber || details.upiId);
    return res.json({
      paymentInstructions: configured
        ? {
            bankAccountName: details.bankAccountName,
            bankAccountNumber: details.bankAccountNumber,
            bankName: details.bankName,
            bankIfscCode: details.bankIfscCode,
            upiId: details.upiId,
            instructions: details.transferInstructions,
          }
        : null,
    });
  } catch (error) {
    return next(error);
  }
});

billingRouter.get('/razorpay-account', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const membership = await prisma.societyMembership.findFirst({
      where: {
        societyId: societyId.data,
        userId: req.auth.user.id,
        active: true,
        role: 'SOCIETY_ADMIN',
        society: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!membership) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const account = await prisma.societyRazorpayAccount.findFirst({
      where: { societyId: societyId.data, active: true },
      orderBy: { createdAt: 'desc' },
      select: { keyId: true, createdAt: true },
    });
    return res.json({
      paymentAccount: account
        ? { configured: true, keyId: account.keyId, configuredAt: account.createdAt }
        : { configured: false },
    });
  } catch (error) {
    return next(error);
  }
});

billingRouter.put('/razorpay-account', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const body = razorpayAccountSchema.safeParse(req.body);
  if (!societyId.success || !body.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Enter valid Razorpay merchant settings');
  if (body.data.enabled && !razorpayAccountEncryptionConfigured())
    return fail(
      res,
      503,
      'CREDENTIAL_ENCRYPTION_NOT_CONFIGURED',
      'Secure payment credential storage is not configured',
    );
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM societies WHERE id = ${societyId.data}::uuid FOR UPDATE`;
      const membership = await tx.societyMembership.findFirst({
        where: {
          societyId: societyId.data,
          userId: req.auth.user.id,
          active: true,
          role: 'SOCIETY_ADMIN',
          society: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (!membership) return { kind: 'inaccessible' };

      await tx.societyRazorpayAccount.updateMany({
        where: { societyId: societyId.data, active: true },
        data: { active: false },
      });
      const account = body.data.enabled
        ? await tx.societyRazorpayAccount.create({
            data: {
              societyId: societyId.data,
              keyId: body.data.keyId,
              apiSecretEncrypted: encryptRazorpaySecret(body.data.keySecret),
              webhookSecretEncrypted: encryptRazorpaySecret(body.data.webhookSecret),
            },
            select: { keyId: true, createdAt: true },
          })
        : null;
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: body.data.enabled
            ? 'RAZORPAY_ACCOUNT_CONFIGURED'
            : 'RAZORPAY_ACCOUNT_DISABLED',
          resourceType: 'SOCIETY',
          resourceId: societyId.data,
        },
      });
      return { kind: 'updated', account };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    return res.json({
      paymentAccount: result.account
        ? { configured: true, keyId: result.account.keyId, configuredAt: result.account.createdAt }
        : { configured: false },
    });
  } catch (error) {
    return next(error);
  }
});

billingRouter.get('/payments/:paymentId/receipt', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const paymentId = uuid.safeParse(req.params.paymentId);
  if (!societyId.success || !paymentId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid payment receipt');

  try {
    const membership = await prisma.societyMembership.findFirst({
      where: {
        societyId: societyId.data,
        userId: req.auth.user.id,
        active: true,
        role: { in: ['SOCIETY_ADMIN', 'ACCOUNTANT', 'RESIDENT'] },
        society: { status: 'ACTIVE' },
      },
      select: { role: true },
    });
    if (!membership) return fail(res, 404, 'RECEIPT_NOT_FOUND', 'Receipt not found');

    const canViewAll = ['SOCIETY_ADMIN', 'ACCOUNTANT'].includes(membership.role);
    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId.data,
        societyId: societyId.data,
        ...(!canViewAll
          ? {
              invoice: {
                flat: {
                  residents: { some: { email: req.auth.user.email, status: 'ACTIVE' } },
                },
              },
            }
          : {}),
      },
      select: {
        id: true,
        amountPaise: true,
        method: true,
        reference: true,
        receivedAt: true,
        invoice: {
          select: {
            description: true,
            period: true,
            society: { select: { name: true } },
            flat: {
              select: {
                flatNumber: true,
                building: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!payment) return fail(res, 404, 'RECEIPT_NOT_FOUND', 'Receipt not found');

    return res.json({
      receipt: {
        receiptNumber: `SO-${payment.id.toUpperCase()}`,
        societyName: payment.invoice.society.name,
        home: `${payment.invoice.flat.building.name} · ${payment.invoice.flat.flatNumber}`,
        charge: payment.invoice.description,
        period: payment.invoice.period,
        amountPaise: payment.amountPaise.toString(),
        method: payment.method,
        reference: payment.reference,
        receivedAt: payment.receivedAt,
      },
    });
  } catch (error) {
    return next(error);
  }
});

billingRouter.put('/payment-instructions', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const body = paymentInstructionsSchema.safeParse(req.body);
  if (!societyId.success || !body.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Enter complete and valid transfer details');
  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (
        !(await tx.societyMembership.findFirst({
          where: {
            societyId: societyId.data,
            userId: req.auth.user.id,
            active: true,
            role: 'SOCIETY_ADMIN',
            society: { status: 'ACTIVE' },
          },
          select: { id: true },
        }))
      )
        return null;
      const society = await tx.society.update({
        where: { id: societyId.data },
        data: {
          bankAccountName: body.data.bankAccountName,
          bankAccountNumber: body.data.bankAccountNumber,
          bankName: body.data.bankName,
          bankIfscCode: body.data.bankIfscCode,
          upiId: body.data.upiId,
          transferInstructions: body.data.instructions,
        },
        select: {
          bankAccountName: true,
          bankAccountNumber: true,
          bankName: true,
          bankIfscCode: true,
          upiId: true,
          transferInstructions: true,
        },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'PAYMENT_INSTRUCTIONS_UPDATED',
          resourceType: 'SOCIETY',
          resourceId: societyId.data,
        },
      });
      return society;
    });
    if (!updated) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    return res.json({
      paymentInstructions: {
        bankAccountName: updated.bankAccountName,
        bankAccountNumber: updated.bankAccountNumber,
        bankName: updated.bankName,
        bankIfscCode: updated.bankIfscCode,
        upiId: updated.upiId,
        instructions: updated.transferInstructions,
      },
    });
  } catch (error) {
    return next(error);
  }
});

billingRouter.get('/mine', async (req, res, next) => {
  const ids = routeIds(req);
  if (!ids) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid billing request');
  try {
    const membership = await prisma.societyMembership.findFirst({
      where: {
        societyId: ids.societyId,
        userId: req.auth.user.id,
        active: true,
        role: 'RESIDENT',
        society: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!membership) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');

    const residents = await prisma.resident.findMany({
      where: { societyId: ids.societyId, email: req.auth.user.email, status: 'ACTIVE' },
      select: {
        id: true,
        fullName: true,
        residentType: true,
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
      },
    });
    const flatIds = [...new Set(residents.map((resident) => resident.flat.id))];
    const invoices = await prisma.invoice.findMany({
      where: { societyId: ids.societyId, flatId: { in: flatIds }, status: { not: 'VOID' } },
      orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        flatId: true,
        description: true,
        period: true,
        amountPaise: true,
        dueDate: true,
        status: true,
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
        attachments: { select: attachmentSelect, orderBy: { createdAt: 'asc' } },
        payments: {
          select: { id: true, amountPaise: true, method: true, reference: true, receivedAt: true },
        },
      },
    });
    res.json({
      residents,
      invoices: invoices.map((invoice) => {
        const paidPaise = invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0n);
        const { amountPaise, ...details } = invoice;
        return {
          ...details,
          amount: Number(amountPaise) / 100,
          paidAmount: Number(paidPaise) / 100,
          balance: Math.max(0, Number(amountPaise - paidPaise) / 100),
          payments: invoice.payments.map(({ amountPaise: paid, ...payment }) => ({
            ...payment,
            amount: Number(paid) / 100,
          })),
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.get('/', async (req, res, next) => {
  const ids = routeIds(req);
  const page = pageSchema.safeParse(req.query);
  if (!ids || !page.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid billing request');
  try {
    if (!(await isAdmin(prisma, ids.societyId, req.auth.user.id)))
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const rows = await prisma.invoice.findMany({
      where: { societyId: ids.societyId, status: { not: 'VOID' } },
      orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }],
      take: page.data.limit + 1,
      ...(page.data.cursor ? { cursor: { id: page.data.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        flatId: true,
        description: true,
        period: true,
        amountPaise: true,
        dueDate: true,
        status: true,
        createdAt: true,
        flat: { select: { flatNumber: true, building: { select: { name: true } } } },
        attachments: { select: attachmentSelect, orderBy: { createdAt: 'asc' } },
        payments: {
          select: { id: true, amountPaise: true, method: true, reference: true, receivedAt: true },
        },
      },
    });
    const hasMore = rows.length > page.data.limit;
    if (hasMore) rows.pop();
    res.json({
      invoices: rows.map((invoice) => {
        const paidPaise = invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0n);
        const { amountPaise, ...details } = invoice;
        return {
          ...details,
          amount: Number(amountPaise) / 100,
          paidAmount: Number(paidPaise) / 100,
          balance: Math.max(0, Number(amountPaise - paidPaise) / 100),
          payments: invoice.payments.map(({ amountPaise: paid, ...payment }) => ({
            ...payment,
            amount: Number(paid) / 100,
          })),
        };
      }),
      nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/generate', requireCsrf, async (req, res, next) => {
  const ids = routeIds(req);
  const body = generateSchema.safeParse(req.body);
  if (!ids || !body.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the monthly billing details and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!(await isAdmin(tx, ids.societyId, req.auth.user.id))) return { kind: 'inaccessible' };
      const flats = await tx.flat.findMany({
        where: {
          societyId: ids.societyId,
          ...(body.data.scope === 'OCCUPIED' ? { occupancyStatus: 'OCCUPIED' } : {}),
        },
        select: { id: true },
      });
      if (!flats.length) return { kind: 'created', createdCount: 0, candidateCount: 0 };
      const created = await tx.invoice.createMany({
        data: flats.map((flat) => ({
          societyId: ids.societyId,
          flatId: flat.id,
          description: body.data.description,
          period: body.data.period,
          amountPaise: body.data.amount,
          dueDate: new Date(`${body.data.dueDate}T00:00:00.000Z`),
        })),
        skipDuplicates: true,
      });
      if (created.count) {
        await tx.auditLog.create({
          data: {
            societyId: ids.societyId,
            actorUserId: req.auth.user.id,
            eventType: 'BILLING_BATCH_GENERATED',
            resourceType: 'BILLING_BATCH',
          },
        });
      }
      return {
        kind: 'created',
        createdCount: created.count,
        candidateCount: flats.length,
      };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    res.status(201).json({
      createdCount: result.createdCount,
      skippedCount: result.candidateCount - result.createdCount,
      scope: body.data.scope,
      period: body.data.period,
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/', requireCsrf, async (req, res, next) => {
  const ids = routeIds(req);
  const body = issueSchema.safeParse(req.body);
  if (!ids || !body.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the charge details and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!(await isAdmin(tx, ids.societyId, req.auth.user.id))) return { kind: 'inaccessible' };
      const flat = await tx.flat.findFirst({
        where: { id: body.data.flatId, societyId: ids.societyId },
        select: { id: true },
      });
      if (!flat) return { kind: 'flat_missing' };
      const duplicate = await tx.invoice.findFirst({
        where: {
          societyId: ids.societyId,
          flatId: flat.id,
          period: body.data.period,
          description: body.data.description,
          status: { not: 'VOID' },
        },
        select: { id: true },
      });
      if (duplicate) return { kind: 'duplicate' };
      const invoice = await tx.invoice.create({
        data: {
          societyId: ids.societyId,
          flatId: flat.id,
          description: body.data.description,
          period: body.data.period,
          amountPaise: body.data.amount,
          dueDate: new Date(`${body.data.dueDate}T00:00:00.000Z`),
        },
        select: { id: true, amountPaise: true, status: true, dueDate: true },
      });
      await tx.auditLog.create({
        data: {
          societyId: ids.societyId,
          actorUserId: req.auth.user.id,
          eventType: 'INVOICE_ISSUED',
          resourceType: 'INVOICE',
          resourceId: invoice.id,
        },
      });
      return { kind: 'created', invoice };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'flat_missing') return fail(res, 404, 'FLAT_NOT_FOUND', 'Flat not found');
    if (result.kind === 'duplicate')
      return fail(
        res,
        409,
        'DUPLICATE_INVOICE',
        'A charge with this description already exists for that flat and period',
      );
    const { amountPaise, ...invoice } = result.invoice;
    res.status(201).json({ invoice: { ...invoice, amount: Number(amountPaise) / 100 } });
  } catch (error) {
    if (error?.code === 'P2002')
      return fail(
        res,
        409,
        'DUPLICATE_INVOICE',
        'A charge with this description already exists for that flat and period',
      );
    next(error);
  }
});

billingRouter.post(
  '/:invoiceId/attachments',
  requireCsrf,
  express.raw({ type: [...attachmentTypes.keys()], limit: MAX_ATTACHMENT_BYTES }),
  async (req, res, next) => {
    const ids = routeIds(req);
    const mimeType = req.get('content-type')?.split(';')[0].trim().toLowerCase();
    const signature = attachmentTypes.get(mimeType);
    const filename = cleanFilename(req.get('x-file-name'));
    if (!ids) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid invoice document');
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
        if (!(await isAdmin(tx, ids.societyId, req.auth.user.id))) return { kind: 'inaccessible' };
        await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${ids.invoiceId}::uuid AND society_id = ${ids.societyId}::uuid FOR UPDATE`;
        const invoice = await tx.invoice.findFirst({
          where: { id: ids.invoiceId, societyId: ids.societyId },
          select: { id: true, status: true },
        });
        if (!invoice || invoice.status === 'VOID') return { kind: 'missing' };
        const count = await tx.invoiceAttachment.count({
          where: { societyId: ids.societyId, invoiceId: invoice.id },
        });
        if (count >= MAX_ATTACHMENTS_PER_INVOICE) return { kind: 'limit' };
        const attachment = await tx.invoiceAttachment.create({
          data: {
            societyId: ids.societyId,
            invoiceId: invoice.id,
            uploadedById: req.auth.user.id,
            originalName: filename,
            mimeType,
            byteSize: req.body.length,
            bytes: req.body,
          },
          select: attachmentSelect,
        });
        await tx.auditLog.create({
          data: {
            societyId: ids.societyId,
            actorUserId: req.auth.user.id,
            eventType: 'INVOICE_DOCUMENT_ADDED',
            resourceType: 'INVOICE',
            resourceId: invoice.id,
          },
        });
        return { kind: 'created', attachment };
      });
      if (result.kind === 'inaccessible')
        return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (result.kind === 'missing')
        return fail(res, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      if (result.kind === 'limit')
        return fail(res, 409, 'ATTACHMENT_LIMIT', 'An invoice can have at most 10 documents');
      return res.status(201).json({ attachment: result.attachment });
    } catch (error) {
      return next(error);
    }
  },
);

billingRouter.get('/:invoiceId/attachments/:attachmentId', async (req, res, next) => {
  const ids = routeIds(req);
  const attachmentId = uuid.safeParse(req.params.attachmentId);
  if (!ids || !attachmentId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid invoice document');
  try {
    const manager = await isAdmin(prisma, ids.societyId, req.auth.user.id);
    if (!manager) {
      const member = await prisma.societyMembership.findFirst({
        where: {
          societyId: ids.societyId,
          userId: req.auth.user.id,
          active: true,
          role: 'RESIDENT',
          society: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (!member) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      const ownInvoice = await prisma.invoice.findFirst({
        where: {
          id: ids.invoiceId,
          societyId: ids.societyId,
          status: { not: 'VOID' },
          flat: { residents: { some: { email: req.auth.user.email, status: 'ACTIVE' } } },
        },
        select: { id: true },
      });
      if (!ownInvoice) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }
    const attachment = await prisma.invoiceAttachment.findFirst({
      where: {
        id: attachmentId.data,
        societyId: ids.societyId,
        invoiceId: ids.invoiceId,
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
    return next(error);
  }
});

billingRouter.post('/:invoiceId/payments', requireCsrf, async (req, res, next) => {
  const ids = routeIds(req);
  const body = paymentSchema.safeParse(req.body);
  if (!ids || !body.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the payment details and try again');
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!(await isAdmin(tx, ids.societyId, req.auth.user.id))) return { kind: 'inaccessible' };
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${ids.invoiceId}::uuid AND society_id = ${ids.societyId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({
        where: { id: ids.invoiceId, societyId: ids.societyId },
        include: { payments: { select: { amountPaise: true } } },
      });
      if (!invoice || invoice.status === 'VOID') return { kind: 'invoice_missing' };
      const activeOnlineOrder = await tx.paymentOrder.findFirst({
        where: { societyId: ids.societyId, invoiceId: invoice.id, status: 'CREATED' },
        select: { id: true },
      });
      if (activeOnlineOrder) return { kind: 'online_payment_pending' };
      const balancePaise =
        invoice.amountPaise -
        invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0n);
      const amountPaise = body.data.amount;
      if (amountPaise > balancePaise)
        return { kind: 'overpayment', balance: Number(balancePaise) / 100 };
      const payment = await tx.payment.create({
        data: {
          societyId: ids.societyId,
          invoiceId: ids.invoiceId,
          amountPaise,
          method: body.data.method,
          ...(body.data.reference ? { reference: body.data.reference } : {}),
          receivedAt: body.data.receivedAt ? new Date(body.data.receivedAt) : new Date(),
        },
      });
      const status = amountPaise === balancePaise ? 'PAID' : 'PARTIAL';
      await tx.invoice.update({ where: { id: invoice.id }, data: { status } });
      await tx.auditLog.create({
        data: {
          societyId: ids.societyId,
          actorUserId: req.auth.user.id,
          eventType: 'PAYMENT_RECORDED',
          resourceType: 'INVOICE',
          resourceId: invoice.id,
        },
      });
      return {
        kind: 'created',
        payment,
        status,
        balance: Number(balancePaise - amountPaise) / 100,
      };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (result.kind === 'invoice_missing')
      return fail(res, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (result.kind === 'online_payment_pending')
      return fail(
        res,
        409,
        'PAYMENT_IN_PROGRESS',
        'An online payment is in progress for this invoice',
      );
    if (result.kind === 'overpayment')
      return fail(
        res,
        409,
        'PAYMENT_EXCEEDS_BALANCE',
        `Payment exceeds the outstanding balance of ${result.balance.toFixed(2)}`,
      );
    const { amountPaise, ...payment } = result.payment;
    res.status(201).json({
      payment: { ...payment, amount: Number(amountPaise) / 100 },
      status: result.status,
      balance: result.balance,
    });
  } catch (error) {
    next(error);
  }
});
