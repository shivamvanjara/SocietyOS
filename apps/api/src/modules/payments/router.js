import { randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';
import {
  createRazorpayOrder,
  fetchRazorpayPayment,
  razorpayKeysConfigured,
  verifyCheckoutSignature,
} from './razorpay.js';
import { societyRazorpayCredentials } from './secrets.js';

export const paymentsRouter = express.Router({ mergeParams: true });
const uuid = z.uuid();
const orderSchema = z.object({ invoiceId: uuid }).strict();
const verifySchema = z
  .object({
    orderId: z.string().regex(/^order_[A-Za-z0-9]+$/),
    paymentId: z.string().regex(/^pay_[A-Za-z0-9]+$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function isResidentHome(invoice, email) {
  return invoice.flat.residents.some(
    (resident) => resident.email === email && resident.status === 'ACTIVE',
  );
}

paymentsRouter.use(requireAuthenticated);

paymentsRouter.get('/status', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    const membership = await prisma.societyMembership.findFirst({
      where: {
        societyId: societyId.data,
        userId: req.auth.user.id,
        active: true,
        role: 'RESIDENT',
        society: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
    if (!membership) return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const account = await prisma.societyRazorpayAccount.findFirst({
      where: { societyId: societyId.data, active: true },
      select: { id: true },
    });
    res.json({ onlinePaymentsEnabled: Boolean(account) });
  } catch (error) {
    next(error);
  }
});

paymentsRouter.post('/orders', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const body = orderSchema.safeParse(req.body);
  if (!societyId.success || !body.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid invoice for online payment');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const membership = await tx.societyMembership.findFirst({
        where: {
          societyId: societyId.data,
          userId: req.auth.user.id,
          active: true,
          role: 'RESIDENT',
          society: { status: 'ACTIVE' },
        },
        select: { id: true },
      });
      if (!membership) return { kind: 'inaccessible' };

      const activeAccount = await tx.societyRazorpayAccount.findFirst({
        where: { societyId: societyId.data, active: true },
        select: {
          id: true,
          keyId: true,
          apiSecretEncrypted: true,
          webhookSecretEncrypted: true,
        },
      });

      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${body.data.invoiceId}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({
        where: { id: body.data.invoiceId, societyId: societyId.data, status: { not: 'VOID' } },
        select: {
          id: true,
          amountPaise: true,
          payments: { select: { amountPaise: true } },
          flat: {
            select: {
              residents: { where: { status: 'ACTIVE' }, select: { email: true, status: true } },
            },
          },
        },
      });
      if (!invoice || !isResidentHome(invoice, req.auth.user.email))
        return { kind: 'inaccessible' };
      const balancePaise =
        invoice.amountPaise -
        invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0n);
      if (balancePaise <= 0n) return { kind: 'settled' };

      const existing = await tx.paymentOrder.findFirst({
        where: {
          societyId: societyId.data,
          invoiceId: invoice.id,
          status: 'CREATED',
        },
        orderBy: { createdAt: 'desc' },
        select: {
          userId: true,
          providerOrderId: true,
          amountPaise: true,
          razorpayAccount: {
            select: {
              id: true,
              keyId: true,
              apiSecretEncrypted: true,
              webhookSecretEncrypted: true,
            },
          },
        },
      });
      if (existing) {
        if (existing.userId !== req.auth.user.id) return { kind: 'payment_pending' };
        if (existing.amountPaise !== balancePaise) return { kind: 'payment_pending' };
        const credentials = existing.razorpayAccount
          ? societyRazorpayCredentials(existing.razorpayAccount)
          : razorpayKeysConfigured()
            ? { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }
            : null;
        if (!credentials) return { kind: 'not_configured' };
        return {
          kind: 'ready',
          orderId: existing.providerOrderId,
          amountPaise: existing.amountPaise,
          keyId: credentials.keyId,
        };
      }

      if (!activeAccount) return { kind: 'not_configured' };
      const credentials = societyRazorpayCredentials(activeAccount);

      const providerOrder = await createRazorpayOrder({
        amountPaise: Number(balancePaise),
        receipt: `so-${randomUUID().replaceAll('-', '').slice(0, 30)}`,
        notes: { societyId: societyId.data, invoiceId: invoice.id, userId: req.auth.user.id },
        credentials,
      });
      if (
        typeof providerOrder.id !== 'string' ||
        providerOrder.amount !== Number(balancePaise) ||
        providerOrder.currency !== 'INR'
      )
        return { kind: 'provider_error' };
      await tx.paymentOrder.create({
        data: {
          societyId: societyId.data,
          razorpayAccountId: activeAccount.id,
          invoiceId: invoice.id,
          userId: req.auth.user.id,
          providerOrderId: providerOrder.id,
          amountPaise: balancePaise,
        },
      });
      return {
        kind: 'ready',
        orderId: providerOrder.id,
        amountPaise: balancePaise,
        keyId: credentials.keyId,
      };
    });
    if (result.kind === 'inaccessible')
      return fail(res, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (result.kind === 'settled')
      return fail(res, 409, 'INVOICE_SETTLED', 'This invoice has no outstanding balance');
    if (result.kind === 'not_configured')
      return fail(
        res,
        503,
        'PAYMENTS_NOT_CONFIGURED',
        'This society has not configured its Razorpay merchant account',
      );
    if (result.kind === 'payment_pending')
      return fail(
        res,
        409,
        'PAYMENT_IN_PROGRESS',
        'A payment is already in progress for this invoice',
      );
    if (result.kind === 'provider_error')
      return fail(
        res,
        502,
        'PAYMENT_PROVIDER_ERROR',
        'The payment provider returned an invalid order',
      );
    res.status(201).json({
      keyId: result.keyId,
      orderId: result.orderId,
      amountPaise: Number(result.amountPaise),
      currency: 'INR',
    });
  } catch (error) {
    if (error?.message === 'Payment provider request failed' || error?.name === 'TimeoutError')
      return fail(res, 502, 'PAYMENT_PROVIDER_ERROR', 'Could not start payment. Please try again.');
    next(error);
  }
});

paymentsRouter.post('/verify', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const body = verifySchema.safeParse(req.body);
  if (!societyId.success || !body.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid payment verification details');
  try {
    const order = await prisma.paymentOrder.findFirst({
      where: {
        societyId: societyId.data,
        providerOrderId: body.data.orderId,
        userId: req.auth.user.id,
      },
      select: {
        id: true,
        invoiceId: true,
        amountPaise: true,
        status: true,
        providerPaymentId: true,
        razorpayAccount: {
          select: {
            id: true,
            keyId: true,
            apiSecretEncrypted: true,
            webhookSecretEncrypted: true,
          },
        },
      },
    });
    if (!order) return fail(res, 404, 'PAYMENT_ORDER_NOT_FOUND', 'Payment order not found');
    const credentials = order.razorpayAccount
      ? societyRazorpayCredentials(order.razorpayAccount)
      : razorpayKeysConfigured()
        ? { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }
        : null;
    if (!credentials)
      return fail(res, 503, 'PAYMENTS_NOT_CONFIGURED', 'Payment account is unavailable');
    if (
      !verifyCheckoutSignature(
        body.data.orderId,
        body.data.paymentId,
        body.data.signature,
        credentials.keySecret,
      )
    )
      return fail(res, 400, 'PAYMENT_SIGNATURE_INVALID', 'Payment verification failed');
    if (order.status === 'PAID' && order.providerPaymentId === body.data.paymentId)
      return res.json({ status: 'PAID', invoiceId: order.invoiceId });
    if (order.status !== 'CREATED')
      return fail(res, 409, 'PAYMENT_ORDER_CLOSED', 'This payment order is no longer active');

    const providerPayment = await fetchRazorpayPayment(body.data.paymentId, credentials);
    if (
      providerPayment.order_id !== body.data.orderId ||
      providerPayment.status !== 'captured' ||
      providerPayment.captured !== true ||
      providerPayment.amount !== Number(order.amountPaise) ||
      providerPayment.currency !== 'INR'
    )
      return fail(
        res,
        409,
        'PAYMENT_NOT_CAPTURED',
        'The payment has not been captured for this invoice',
      );

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${order.invoiceId}::uuid AND society_id = ${societyId.data}::uuid FOR UPDATE`;
      const lockedOrder = await tx.paymentOrder.findUnique({ where: { id: order.id } });
      if (lockedOrder.status === 'PAID' && lockedOrder.providerPaymentId === body.data.paymentId)
        return { kind: 'already_paid' };
      if (lockedOrder.status !== 'CREATED') return { kind: 'closed' };
      const invoice = await tx.invoice.findFirst({
        where: { id: order.invoiceId, societyId: societyId.data },
        include: { payments: { select: { amountPaise: true } } },
      });
      if (!invoice || invoice.status === 'VOID') return { kind: 'missing' };
      const balancePaise =
        invoice.amountPaise -
        invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0n);
      if (order.amountPaise > balancePaise) return { kind: 'balance_changed' };
      const payment = await tx.payment.create({
        data: {
          societyId: societyId.data,
          invoiceId: invoice.id,
          amountPaise: order.amountPaise,
          method: 'RAZORPAY',
          reference: body.data.paymentId,
          providerPaymentId: body.data.paymentId,
          receivedAt: new Date(providerPayment.created_at * 1000),
        },
      });
      const nextBalance = balancePaise - order.amountPaise;
      const status = nextBalance === 0n ? 'PAID' : 'PARTIAL';
      await tx.invoice.update({ where: { id: invoice.id }, data: { status } });
      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { status: 'PAID', providerPaymentId: body.data.paymentId },
      });
      await tx.auditLog.create({
        data: {
          societyId: societyId.data,
          actorUserId: req.auth.user.id,
          eventType: 'ONLINE_PAYMENT_CAPTURED',
          resourceType: 'INVOICE',
          resourceId: invoice.id,
        },
      });
      return { kind: 'paid', paymentId: payment.id, status };
    });
    if (result.kind === 'missing') return fail(res, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (result.kind === 'closed')
      return fail(res, 409, 'PAYMENT_ORDER_CLOSED', 'This payment order is no longer active');
    if (result.kind === 'balance_changed')
      return fail(
        res,
        409,
        'INVOICE_BALANCE_CHANGED',
        'Contact the society office to reconcile this payment',
      );
    res.json({
      status: 'PAID',
      invoiceId: order.invoiceId,
      invoiceStatus: result.status ?? 'PAID',
    });
  } catch (error) {
    if (error?.message === 'Payment provider request failed' || error?.name === 'TimeoutError')
      return fail(
        res,
        502,
        'PAYMENT_PROVIDER_ERROR',
        'Could not verify payment yet. Please retry shortly.',
      );
    if (error?.code === 'P2002')
      return fail(
        res,
        409,
        'PAYMENT_ALREADY_RECORDED',
        'This provider payment was already recorded',
      );
    next(error);
  }
});

paymentsRouter.post('/:orderId/cancel', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const orderId = z
    .string()
    .regex(/^order_[A-Za-z0-9]+$/)
    .safeParse(req.params.orderId);
  if (!societyId.success || !orderId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid payment order');
  try {
    const result = await prisma.paymentOrder.updateMany({
      where: {
        societyId: societyId.data,
        userId: req.auth.user.id,
        providerOrderId: orderId.data,
        status: 'CREATED',
      },
      data: { status: 'FAILED' },
    });
    if (!result.count) return fail(res, 404, 'PAYMENT_ORDER_NOT_FOUND', 'Payment order not found');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
