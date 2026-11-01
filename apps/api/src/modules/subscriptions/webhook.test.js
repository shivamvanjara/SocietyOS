import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn() },
}));
vi.mock('../../config/database.js', () => ({ prisma }));

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
process.env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET = 'subscriptions-webhook-test-secret';
const { app } = await import('../../app.js');

const subscriptionId = 'e55a1ccb-3a30-46fb-9451-7e0a62fe4939';
const providerSubscriptionId = 'sub_razorpay_test';
const providerPlanId = 'plan_razorpay_test';
const eventId = 'evt_razorpay_subscription_test';
const secret = process.env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET;

function sign(rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('Razorpay society subscription webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('activates a subscription only from a signed webhook and records its billing period', async () => {
    const endsAtSeconds = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const tx = {
      societySubscriptionWebhookEvent: {
        create: vi.fn(),
        update: vi.fn(),
      },
      societySubscription: {
        findUnique: vi.fn().mockResolvedValue({
          id: subscriptionId,
          status: 'PENDING',
          pricePaise: 125000n,
          providerPlanId,
          plan: { id: 'local-plan-id' },
        }),
        update: vi.fn(),
      },
    };
    prisma.$transaction.mockImplementation((operation) => operation(tx));
    const rawBody = JSON.stringify({
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: {
            id: providerSubscriptionId,
            plan_id: providerPlanId,
            status: 'active',
            current_end: endsAtSeconds,
          },
        },
      },
    });

    const response = await request(app)
      .post('/api/v1/subscriptions/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sign(rawBody))
      .set('X-Razorpay-Event-Id', eventId)
      .send(rawBody);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(tx.societySubscription.update).toHaveBeenCalledWith({
      where: { id: subscriptionId },
      data: { status: 'ACTIVE', endsAt: new Date(endsAtSeconds * 1000) },
    });
    expect(tx.societySubscriptionWebhookEvent.update).toHaveBeenCalledWith({
      where: { providerEventId: eventId },
      data: { societySubscriptionId: subscriptionId, processedAt: expect.any(Date) },
    });
  });

  it('rejects an invalid signature before writing webhook events', async () => {
    const response = await request(app)
      .post('/api/v1/subscriptions/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', '0'.repeat(64))
      .set('X-Razorpay-Event-Id', eventId)
      .send('{"event":"subscription.activated"}');
    expect(response.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
