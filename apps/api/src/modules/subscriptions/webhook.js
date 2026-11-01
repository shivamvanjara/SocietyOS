import { env } from '../../config/env.js';
import { prisma } from '../../config/database.js';
import { fetchRazorpayPayment, verifyWebhookSignature } from '../payments/razorpay.js';

const subscriptionEvents = new Map([
  ['subscription.activated', 'ACTIVE'],
  ['subscription.charged', 'ACTIVE'],
  ['subscription.pending', 'PAST_DUE'],
  ['subscription.halted', 'PAST_DUE'],
  ['subscription.cancelled', 'CANCELED'],
  ['subscription.completed', 'EXPIRED'],
]);

function respondError(res, status, code) {
  return res
    .status(status)
    .json({ error: { code, message: 'Subscription webhook could not be processed' } });
}

function fromUnixSeconds(value) {
  return Number.isInteger(value) && value > 0 ? new Date(value * 1000) : undefined;
}

export async function razorpaySubscriptionWebhook(request, response) {
  const rawBody = request.body;
  const signature = request.get('x-razorpay-signature');
  const eventId = request.get('x-razorpay-event-id');
  if (
    !Buffer.isBuffer(rawBody) ||
    !verifyWebhookSignature(rawBody, signature, env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET)
  )
    return respondError(response, 400, 'WEBHOOK_SIGNATURE_INVALID');
  if (!eventId || eventId.length > 120)
    return respondError(response, 400, 'WEBHOOK_EVENT_ID_INVALID');

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return respondError(response, 400, 'WEBHOOK_BODY_INVALID');
  }
  const nextStatus = subscriptionEvents.get(event.event);
  if (!nextStatus) return response.sendStatus(200);
  const providerSubscription = event.payload?.subscription?.entity;
  if (!providerSubscription?.id) return respondError(response, 400, 'WEBHOOK_BODY_INVALID');

  let verifiedPayment = null;
  if (event.event === 'subscription.charged') {
    const payment = event.payload?.payment?.entity;
    if (!payment?.id) return respondError(response, 400, 'WEBHOOK_BODY_INVALID');
    try {
      verifiedPayment = await fetchRazorpayPayment(payment.id);
    } catch {
      return respondError(response, 503, 'PAYMENT_VERIFICATION_UNAVAILABLE');
    }
    if (
      verifiedPayment.id !== payment.id ||
      verifiedPayment.subscription_id !== providerSubscription.id ||
      verifiedPayment.status !== 'captured' ||
      verifiedPayment.captured !== true ||
      verifiedPayment.currency !== 'INR' ||
      verifiedPayment.amount !== payment.amount
    )
      return respondError(response, 409, 'SUBSCRIPTION_PAYMENT_NOT_CAPTURED');
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.societySubscriptionWebhookEvent.create({
        data: { providerEventId: eventId, eventType: event.event },
      });
      const subscription = await tx.societySubscription.findUnique({
        where: { providerSubscriptionId: providerSubscription.id },
        include: { plan: { select: { id: true } } },
      });
      if (!subscription) {
        await tx.societySubscriptionWebhookEvent.update({
          where: { providerEventId: eventId },
          data: { processedAt: new Date() },
        });
        return;
      }
      if (subscription.providerPlanId !== providerSubscription.plan_id)
        throw new Error('SUBSCRIPTION_PLAN_MISMATCH');
      if (verifiedPayment && verifiedPayment.amount !== Number(subscription.pricePaise))
        throw new Error('SUBSCRIPTION_AMOUNT_MISMATCH');

      const terminal = ['CANCELED', 'EXPIRED'].includes(subscription.status);
      const chargedPaymentId = verifiedPayment?.id;
      if (verifiedPayment && chargedPaymentId) {
        await tx.societySubscriptionCharge.create({
          data: {
            societySubscriptionId: subscription.id,
            providerPaymentId: chargedPaymentId,
            providerEventId: eventId,
            amountPaise: BigInt(verifiedPayment.amount),
            currency: verifiedPayment.currency,
            status: 'CAPTURED',
            paidAt: fromUnixSeconds(verifiedPayment.created_at) ?? new Date(),
          },
        });
      }

      const endsAt = fromUnixSeconds(providerSubscription.current_end);
      if (!terminal) {
        await tx.societySubscription.update({
          where: { id: subscription.id },
          data: {
            status: nextStatus,
            ...(event.event === 'subscription.cancelled' ? { canceledAt: new Date() } : {}),
            ...(nextStatus === 'CANCELED' || nextStatus === 'EXPIRED'
              ? { endsAt: fromUnixSeconds(providerSubscription.ended_at) ?? new Date() }
              : endsAt
                ? { endsAt }
                : {}),
          },
        });
      }
      await tx.societySubscriptionWebhookEvent.update({
        where: { providerEventId: eventId },
        data: { societySubscriptionId: subscription.id, processedAt: new Date() },
      });
    });
    return response.sendStatus(200);
  } catch (error) {
    if (error?.code === 'P2002') return response.sendStatus(200);
    return response
      .status(503)
      .json({ error: { code: 'WEBHOOK_RETRY', message: 'Webhook processing will be retried' } });
  }
}
