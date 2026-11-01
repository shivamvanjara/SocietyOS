import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    paymentOrder: { findFirst: vi.fn(), findUnique: vi.fn() },
    session: { findUnique: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock('../../config/database.js', () => ({ prisma }));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
process.env.RAZORPAY_KEY_ID ??= 'rzp_test_public';
process.env.RAZORPAY_KEY_SECRET ??= 'razorpay-test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET ??= 'razorpay-webhook-test-secret';
process.env.RAZORPAY_ACCOUNT_ENCRYPTION_KEY ??= 'A'.repeat(43);
const [{ app }, { createCsrfToken }, { encryptRazorpaySecret }] = await Promise.all([
  import('../../app.js'),
  import('../auth/security.js'),
  import('./secrets.js'),
]);

const token = 'payments-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const invoiceId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
const orderId = 'order_123456789';
const paymentId = 'pay_123456789';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);
const origin = 'http://localhost:5173';
const societyAccount = {
  id: 'b3f13d36-cba8-48f7-81f0-dcd6d2d4a13f',
  keyId: 'rzp_test_public',
  apiSecretEncrypted: encryptRazorpaySecret('razorpay-test-secret'),
  webhookSecretEncrypted: encryptRazorpaySecret('razorpay-webhook-test-secret'),
};

describe('resident Razorpay payments API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'resident@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
    prisma.paymentOrder.findUnique.mockResolvedValue(null);
  });

  it('creates a provider order using the server-calculated outstanding balance', async () => {
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'resident-membership' }) },
      societyRazorpayAccount: { findFirst: vi.fn().mockResolvedValue(societyAccount) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      invoice: {
        findFirst: vi.fn().mockResolvedValue({
          id: invoiceId,
          amountPaise: 20000n,
          payments: [{ amountPaise: 5000n }],
          flat: { residents: [{ email: 'resident@example.test', status: 'ACTIVE' }] },
        }),
      },
      paymentOrder: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: orderId, amount: 15000, currency: 'INR' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/payments/orders`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ invoiceId });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      keyId: 'rzp_test_public',
      orderId,
      amountPaise: 15000,
      currency: 'INR',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      amount: 15000,
      currency: 'INR',
    });
    expect(transaction.paymentOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId,
        invoiceId,
        userId,
        razorpayAccountId: societyAccount.id,
        providerOrderId: orderId,
        amountPaise: 15000n,
      }),
    });
  });

  it('verifies a captured payment with the provider before recording the receipt', async () => {
    const signature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    prisma.paymentOrder.findFirst.mockResolvedValue({
      id: 'payment-order-id',
      invoiceId,
      amountPaise: 12000n,
      status: 'CREATED',
      providerPaymentId: null,
      razorpayAccount: societyAccount,
    });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      paymentOrder: {
        findUnique: vi.fn().mockResolvedValue({ id: 'payment-order-id', status: 'CREATED' }),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: {
        findFirst: vi.fn().mockResolvedValue({
          id: invoiceId,
          amountPaise: 12000n,
          status: 'ISSUED',
          payments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      payment: { create: vi.fn().mockResolvedValue({ id: 'recorded-payment' }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: paymentId,
            order_id: orderId,
            status: 'captured',
            captured: true,
            amount: 12000,
            currency: 'INR',
            created_at: 1_800_000_000,
          }),
          { status: 200 },
        ),
      ),
    );

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/payments/verify`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ orderId, paymentId, signature });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'PAID', invoiceId, invoiceStatus: 'PAID' });
    expect(transaction.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId,
        invoiceId,
        amountPaise: 12000n,
        method: 'RAZORPAY',
        reference: paymentId,
      }),
    });
    expect(transaction.paymentOrder.update).toHaveBeenCalledWith({
      where: { id: 'payment-order-id' },
      data: { status: 'PAID', providerPaymentId: paymentId },
    });
  });

  it('rejects a forged callback signature without contacting the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/payments/verify`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ orderId, paymentId, signature: '0'.repeat(64) });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PAYMENT_SIGNATURE_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.paymentOrder.findFirst).toHaveBeenCalled();
  });

  it('processes a captured webhook only after raw-body signature and provider-state checks', async () => {
    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            status: 'captured',
            captured: true,
            amount: 12000,
            currency: 'INR',
            created_at: 1_800_000_000,
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const eventId = 'evt_123456789';
    const signature = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    const transaction = {
      paymentWebhookEvent: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentOrder: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'payment-order-id',
          societyId,
          invoiceId,
          userId,
          amountPaise: 12000n,
          status: 'CREATED',
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      invoice: {
        findFirst: vi.fn().mockResolvedValue({
          id: invoiceId,
          amountPaise: 12000n,
          status: 'ISSUED',
          payments: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      payment: { create: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    prisma.paymentOrder.findUnique.mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(payload.payload.payment.entity), { status: 200 }),
        ),
    );

    const response = await request(app)
      .post('/api/v1/payments/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', signature)
      .set('X-Razorpay-Event-Id', eventId)
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(transaction.paymentWebhookEvent.create).toHaveBeenCalledWith({
      data: { providerEventId: eventId, eventType: 'payment.captured' },
    });
    expect(transaction.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId,
        invoiceId,
        amountPaise: 12000n,
        method: 'RAZORPAY',
        providerPaymentId: paymentId,
      }),
    });
    expect(transaction.paymentOrder.update).toHaveBeenCalledWith({
      where: { id: 'payment-order-id' },
      data: { status: 'PAID', providerPaymentId: paymentId },
    });
  });
});
