import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    session: { findUnique: vi.fn() },
    societyMembership: { findFirst: vi.fn() },
    subscriptionPlan: { findMany: vi.fn(), update: vi.fn() },
    societySubscription: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../config/database.js', () => ({ prisma }));

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
process.env.RAZORPAY_KEY_ID = 'rzp_test_subscriptions';
process.env.RAZORPAY_KEY_SECRET = 'subscriptions-test-secret';
process.env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET = 'subscriptions-webhook-test-secret';
const [{ app }, { createCsrfToken }] = await Promise.all([
  import('../../app.js'),
  import('../auth/security.js'),
]);

const token = 'subscriptions-test-session-token';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const planId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
const subscriptionId = 'e55a1ccb-3a30-46fb-9451-7e0a62fe4939';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

describe('society recurring subscription checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'admin@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'admin-membership' });
    prisma.subscriptionPlan.update.mockResolvedValue({});
  });

  it('creates a pending, price-snapshotted subscription and provider checkout', async () => {
    const plan = {
      id: planId,
      name: 'Community Plus',
      description: 'Society management',
      billingInterval: 'MONTHLY',
      pricePaise: 125000n,
      maxBuildings: 12,
      maxFlats: 500,
      razorpayPlanId: null,
      providerPricePaise: null,
      providerInterval: null,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: societyId, status: 'ACTIVE' }]),
      societySubscription: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: subscriptionId }),
      },
      subscriptionPlan: { findFirst: vi.fn().mockResolvedValue(plan) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(tx));
    prisma.societySubscription.update.mockResolvedValue({
      id: subscriptionId,
      societyId,
      planId,
      status: 'PENDING',
      pricePaise: 125000n,
      billingInterval: 'MONTHLY',
      providerSubscriptionId: 'sub_razorpay_test',
      providerPlanId: 'plan_razorpay_test',
      checkoutUrl: 'https://rzp.io/i/test-checkout',
      charges: [],
      plan: { id: planId, name: 'Community Plus' },
    });
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'plan_razorpay_test' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'sub_razorpay_test', short_url: 'https://rzp.io/i/test-checkout' }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', providerFetch);

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/subscription/checkout`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ planId });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      subscription: { status: 'PENDING', price: '1250.00' },
      checkoutUrl: 'https://rzp.io/i/test-checkout',
    });
    expect(tx.societySubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId,
        planId,
        createdById: userId,
        status: 'PENDING',
        pricePaise: 125000n,
        maxBuildings: 12,
        maxFlats: 500,
      }),
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const planRequest = JSON.parse(providerFetch.mock.calls[0][1].body);
    const subscriptionRequest = JSON.parse(providerFetch.mock.calls[1][1].body);
    expect(planRequest).toMatchObject({
      period: 'monthly',
      interval: 1,
      item: { amount: 125000, currency: 'INR' },
    });
    expect(subscriptionRequest).toMatchObject({ plan_id: 'plan_razorpay_test', total_count: 120 });
    expect(tx.societySubscription.findFirst).toHaveBeenCalledWith({
      where: { societyId, status: { in: ['PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE'] } },
      include: { plan: true },
    });
  });

  it('requires the authorized society administrator and CSRF protection', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/subscription/checkout`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ planId });
    expect(response.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
