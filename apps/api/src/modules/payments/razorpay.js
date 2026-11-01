import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

export function razorpayKeysConfigured() {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export function razorpaySubscriptionsConfigured() {
  return razorpayKeysConfigured() && Boolean(env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET);
}

function authorization(credentials) {
  const keyId = credentials?.keyId ?? env.RAZORPAY_KEY_ID;
  const keySecret = credentials?.keySecret ?? env.RAZORPAY_KEY_SECRET;
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

function signaturesMatch(expected, provided) {
  if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/i.test(provided)) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const providedBytes = Buffer.from(provided, 'hex');
  return (
    expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
  );
}

async function razorpayRequest(path, options = {}, credentials = null) {
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: authorization(credentials),
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Payment provider request failed');
  return payload;
}

export async function createRazorpayOrder({ amountPaise, receipt, notes, credentials }) {
  return razorpayRequest(
    '/orders',
    {
      method: 'POST',
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt, notes }),
    },
    credentials,
  );
}

export async function createRazorpayPlan({ name, description, billingInterval, amountPaise }) {
  return razorpayRequest('/plans', {
    method: 'POST',
    body: JSON.stringify({
      period: billingInterval === 'ANNUAL' ? 'yearly' : 'monthly',
      interval: 1,
      item: {
        name,
        ...(description ? { description } : {}),
        amount: amountPaise,
        currency: 'INR',
      },
    }),
  });
}

export async function createRazorpaySubscription({
  planId,
  societySubscriptionId,
  societyId,
  billingInterval,
}) {
  return razorpayRequest('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: planId,
      total_count: billingInterval === 'ANNUAL' ? 10 : 120,
      quantity: 1,
      customer_notify: false,
      notes: { societyos_subscription_id: societySubscriptionId, society_id: societyId },
    }),
  });
}

export async function cancelRazorpaySubscription(subscriptionId, cancelAtCycleEnd) {
  return razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancel_at_cycle_end: cancelAtCycleEnd }),
  });
}

export async function fetchRazorpaySubscription(subscriptionId) {
  return razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function fetchRazorpayPayment(paymentId, credentials = null) {
  return razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`, {}, credentials);
}

export function verifyCheckoutSignature(
  orderId,
  paymentId,
  providedSignature,
  keySecret = env.RAZORPAY_KEY_SECRET,
) {
  if (!keySecret) return false;
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return signaturesMatch(expected, providedSignature);
}

export function verifyWebhookSignature(
  rawBody,
  providedSignature,
  secret = env.RAZORPAY_WEBHOOK_SECRET,
) {
  if (!secret || !Buffer.isBuffer(rawBody)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return signaturesMatch(expected, providedSignature);
}
