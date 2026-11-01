import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { fetchRazorpayPayment, verifyWebhookSignature } from './razorpay.js';
import { societyRazorpayCredentials } from './secrets.js';

function respondError(res, status, code) {
  return res.status(status).json({ error: { code, message: 'Webhook could not be processed' } });
}

export async function razorpayWebhook(request, response) {
  const rawBody = request.body;
  const signature = request.get('x-razorpay-signature');
  const eventId = request.get('x-razorpay-event-id');
  if (!Buffer.isBuffer(rawBody)) return respondError(response, 400, 'WEBHOOK_BODY_INVALID');
  if (!eventId || eventId.length > 120)
    return respondError(response, 400, 'WEBHOOK_EVENT_ID_INVALID');

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return respondError(response, 400, 'WEBHOOK_BODY_INVALID');
  }
  if (!['payment.captured', 'payment.failed'].includes(event.event))
    return response.sendStatus(200);
  const providerPayment = event.payload?.payment?.entity;
  if (!providerPayment?.id) return respondError(response, 400, 'WEBHOOK_BODY_INVALID');
  if (!providerPayment.order_id)
    return event.event === 'payment.failed'
      ? response.sendStatus(200)
      : respondError(response, 400, 'WEBHOOK_BODY_INVALID');

  try {
    const existingOrder = await prisma.paymentOrder.findUnique({
      where: { providerOrderId: providerPayment.order_id },
      select: {
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
    const credentials = existingOrder?.razorpayAccount
      ? societyRazorpayCredentials(existingOrder.razorpayAccount)
      : razorpayKeysConfiguredForLegacy();
    const webhookSecret = credentials?.webhookSecret ?? env.RAZORPAY_WEBHOOK_SECRET;
    if (!verifyWebhookSignature(rawBody, signature, webhookSecret))
      return respondError(response, 400, 'WEBHOOK_SIGNATURE_INVALID');

    if (event.event === 'payment.captured') {
      if (!credentials) return respondError(response, 503, 'PAYMENT_ACCOUNT_UNAVAILABLE');
      const current = await fetchRazorpayPayment(providerPayment.id, credentials);
      if (
        current.order_id !== providerPayment.order_id ||
        current.status !== 'captured' ||
        current.captured !== true ||
        current.amount !== providerPayment.amount ||
        current.currency !== 'INR'
      )
        return respondError(response, 409, 'PAYMENT_NOT_CAPTURED');
    }

    await prisma.$transaction(async (tx) => {
      await tx.paymentWebhookEvent.create({
        data: { providerEventId: eventId, eventType: event.event },
      });
      const order = await tx.paymentOrder.findUnique({
        where: { providerOrderId: providerPayment.order_id },
      });
      const mayProcessCaptured =
        order &&
        (order.status === 'CREATED' ||
          (order.status === 'FAILED' && event.event === 'payment.captured'));
      if (!mayProcessCaptured) {
        if (order?.status === 'PAID' && order.providerPaymentId === providerPayment.id) {
          await tx.paymentWebhookEvent.update({
            where: { providerEventId: eventId },
            data: { societyId: order.societyId, processedAt: new Date() },
          });
          return;
        }
        if (order?.status === 'PAID') throw new Error('PAYMENT_ORDER_ALREADY_PAID');
        await tx.paymentWebhookEvent.update({
          where: { providerEventId: eventId },
          data: { processedAt: new Date() },
        });
        return;
      }

      if (event.event === 'payment.failed') {
        await tx.paymentOrder.updateMany({
          where: { id: order.id, status: 'CREATED' },
          data: { status: 'FAILED' },
        });
        await tx.paymentWebhookEvent.update({
          where: { providerEventId: eventId },
          data: { societyId: order.societyId, processedAt: new Date() },
        });
        return;
      }

      if (providerPayment.amount !== Number(order.amountPaise))
        throw new Error('PAYMENT_AMOUNT_MISMATCH');
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${order.invoiceId}::uuid AND society_id = ${order.societyId}::uuid FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({
        where: { id: order.invoiceId, societyId: order.societyId },
        include: { payments: { select: { amountPaise: true } } },
      });
      if (!invoice || invoice.status === 'VOID') throw new Error('INVOICE_NOT_AVAILABLE');
      const balancePaise =
        invoice.amountPaise -
        invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0n);
      if (order.amountPaise > balancePaise) throw new Error('INVOICE_BALANCE_CHANGED');
      await tx.payment.create({
        data: {
          societyId: order.societyId,
          invoiceId: invoice.id,
          amountPaise: order.amountPaise,
          method: 'RAZORPAY',
          reference: providerPayment.id,
          providerPaymentId: providerPayment.id,
          receivedAt: new Date(providerPayment.created_at * 1000),
        },
      });
      const nextBalance = balancePaise - order.amountPaise;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: nextBalance === 0n ? 'PAID' : 'PARTIAL' },
      });
      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { status: 'PAID', providerPaymentId: providerPayment.id },
      });
      await tx.auditLog.create({
        data: {
          societyId: order.societyId,
          actorUserId: order.userId,
          eventType: 'ONLINE_PAYMENT_CAPTURED',
          resourceType: 'INVOICE',
          resourceId: invoice.id,
        },
      });
      await tx.paymentWebhookEvent.update({
        where: { providerEventId: eventId },
        data: { societyId: order.societyId, processedAt: new Date() },
      });
    });
    response.sendStatus(200);
  } catch (error) {
    if (error?.code === 'P2002') return response.sendStatus(200);
    response
      .status(503)
      .json({ error: { code: 'WEBHOOK_RETRY', message: 'Webhook processing will be retried' } });
  }
}

function razorpayKeysConfiguredForLegacy() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  return {
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
  };
}
