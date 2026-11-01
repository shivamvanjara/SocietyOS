import { randomUUID, createHmac } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.RAZORPAY_KEY_ID = 'rzp_test_subscription_integration';
process.env.RAZORPAY_KEY_SECRET = 'subscription-integration-api-secret';
process.env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET = 'subscription-integration-webhook-secret';
const [{ env }, { prisma: appPrisma }, { app }, { createCsrfToken, hashSessionToken }] =
  await Promise.all([
    import('../../config/env.js'),
    import('../../config/database.js'),
    import('../../app.js'),
    import('../auth/security.js'),
  ]);

const integration = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 }),
});
const id = randomUUID();
const token = `subscription-integration-${id}`;
const webhookSecret = env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET;
let user;
let society;
let plan;

function signature(rawBody) {
  return createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
}

function webhook(eventId, payload) {
  const rawBody = JSON.stringify(payload);
  return request(app)
    .post('/api/v1/subscriptions/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', signature(rawBody))
    .set('X-Razorpay-Event-Id', eventId)
    .send(rawBody);
}

integration('recurring society subscription lifecycle with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    user = await prisma.user.create({
      data: { email: `subscription-${id}@example.test`, passwordHash: 'integration-test-hash' },
    });
    society = await prisma.society.create({
      data: { name: 'Subscription Integration Society', slug: `sub-${id.slice(0, 16)}` },
    });
    await prisma.societyMembership.create({
      data: { societyId: society.id, userId: user.id, role: 'SOCIETY_ADMIN' },
    });
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    plan = await prisma.subscriptionPlan.create({
      data: {
        name: `Recurring ${id.slice(0, 8)}`,
        billingInterval: 'MONTHLY',
        pricePaise: 50000n,
        maxBuildings: 4,
        maxFlats: 120,
      },
    });
  });

  afterAll(async () => {
    if (society) {
      const subscriptions = await prisma.societySubscription.findMany({
        where: { societyId: society.id },
        select: { id: true },
      });
      const ids = subscriptions.map(({ id: subscriptionId }) => subscriptionId);
      await prisma.societySubscriptionCharge.deleteMany({
        where: { societySubscriptionId: { in: ids } },
      });
      await prisma.societySubscriptionWebhookEvent.deleteMany({
        where: { societySubscriptionId: { in: ids } },
      });
      await prisma.societySubscription.deleteMany({ where: { societyId: society.id } });
      await prisma.societyMembership.deleteMany({ where: { societyId: society.id } });
      await prisma.society.delete({ where: { id: society.id } });
    }
    if (plan) await prisma.subscriptionPlan.delete({ where: { id: plan.id } });
    if (user) {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('checks out, activates, records a renewal once, and schedules cancellation', async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'plan_integration_test' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'sub_integration_test',
            short_url: 'https://rzp.io/i/sub-integration',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', providerFetch);
    const cookie = `societyos_session=${token}`;
    const csrfToken = createCsrfToken(token);
    const checkout = await request(app)
      .post(`/api/v1/societies/${society.id}/subscription/checkout`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ planId: plan.id });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.subscription).toMatchObject({ status: 'PENDING', price: '500.00' });
    expect(checkout.body.checkoutUrl).toBe('https://rzp.io/i/sub-integration');

    const endsAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const activated = await webhook('evt_subscription_activated', {
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: {
            id: 'sub_integration_test',
            plan_id: 'plan_integration_test',
            status: 'active',
            current_end: endsAt,
          },
        },
      },
    });
    expect(activated.status).toBe(200);

    const chargePayload = {
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: 'sub_integration_test',
            plan_id: 'plan_integration_test',
            status: 'active',
            current_end: endsAt + 30 * 24 * 60 * 60,
          },
        },
        payment: {
          entity: {
            id: 'pay_subscription_integration',
            amount: 50000,
            currency: 'INR',
          },
        },
      },
    };
    providerFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'pay_subscription_integration',
          subscription_id: 'sub_integration_test',
          amount: 50000,
          currency: 'INR',
          status: 'captured',
          captured: true,
          created_at: Math.floor(Date.now() / 1000),
        }),
        { status: 200 },
      ),
    );
    const charged = await webhook('evt_subscription_charge', chargePayload);
    expect(charged.status).toBe(200);
    providerFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'pay_subscription_integration',
          subscription_id: 'sub_integration_test',
          amount: 50000,
          currency: 'INR',
          status: 'captured',
          captured: true,
          created_at: Math.floor(Date.now() / 1000),
        }),
        { status: 200 },
      ),
    );
    const duplicate = await webhook('evt_subscription_charge', chargePayload);
    expect(duplicate.status).toBe(200);

    expect(
      await prisma.societySubscriptionCharge.count({
        where: { providerPaymentId: 'pay_subscription_integration' },
      }),
    ).toBe(1);
    expect(
      await prisma.societySubscription.findFirst({
        where: { societyId: society.id },
        select: { status: true, pricePaise: true, endsAt: true },
      }),
    ).toEqual({
      status: 'ACTIVE',
      pricePaise: 50000n,
      endsAt: new Date(chargePayload.payload.subscription.entity.current_end * 1000),
    });

    providerFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'sub_integration_test',
          status: 'active',
          current_end: chargePayload.payload.subscription.entity.current_end,
        }),
        { status: 200 },
      ),
    );
    const cancel = await request(app)
      .post(`/api/v1/societies/${society.id}/subscription/${checkout.body.subscription.id}/cancel`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.subscription.cancelAtCycleEnd).toBe(true);
  });
});
