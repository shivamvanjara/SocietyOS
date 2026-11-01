import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    society: { update: vi.fn() },
    societyMembership: { findFirst: vi.fn() },
    invoice: { findMany: vi.fn(), findFirst: vi.fn() },
    invoiceAttachment: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    societyRazorpayAccount: { findFirst: vi.fn() },
    resident: { findMany: vi.fn() },
    session: { findUnique: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock('../../config/database.js', () => ({ prisma }));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
process.env.RAZORPAY_ACCOUNT_ENCRYPTION_KEY ??= 'A'.repeat(43);
const [{ app }, { createCsrfToken }] = await Promise.all([
  import('../../app.js'),
  import('../auth/security.js'),
]);

const token = 'billing-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const invoiceId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('society billing API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'admin@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'membership-id' });
  });

  it('hides billing records from users without society administrator access', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/billing`)
      .set('Cookie', cookie);
    expect(response.status).toBe(404);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('lets a society administrator save bank or UPI payment instructions', async () => {
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-membership' }) },
      society: {
        update: vi.fn().mockResolvedValue({
          bankAccountName: 'Sample Society Association',
          bankAccountNumber: '001234567890',
          bankName: 'Example Bank',
          bankIfscCode: 'EXAM0001234',
          upiId: 'sample.society@example',
          transferInstructions: 'Add the flat number to the reference.',
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .put(`/api/v1/societies/${societyId}/billing/payment-instructions`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        bankAccountName: 'Sample Society Association',
        bankAccountNumber: '001234567890',
        bankName: 'Example Bank',
        bankIfscCode: 'exam0001234',
        upiId: 'sample.society@example',
        instructions: 'Add the flat number to the reference.',
      });
    expect(response.status).toBe(200);
    expect(response.body.paymentInstructions.bankIfscCode).toBe('EXAM0001234');
    expect(transaction.society.update).toHaveBeenCalledWith({
      where: { id: societyId },
      data: expect.objectContaining({
        bankAccountNumber: '001234567890',
        bankIfscCode: 'EXAM0001234',
        upiId: 'sample.society@example',
      }),
      select: expect.any(Object),
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'PAYMENT_INSTRUCTIONS_UPDATED',
        resourceType: 'SOCIETY',
        resourceId: societyId,
      }),
    });
  });

  it('rejects incomplete bank details without saving any account information', async () => {
    const response = await request(app)
      .put(`/api/v1/societies/${societyId}/billing/payment-instructions`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        bankAccountName: 'Sample Society Association',
        bankAccountNumber: '',
        bankName: 'Example Bank',
        bankIfscCode: 'EXAM0001234',
        upiId: '',
        instructions: '',
      });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows an admin to publish a UPI-only transfer option', async () => {
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-membership' }) },
      society: {
        update: vi.fn().mockResolvedValue({
          bankAccountName: null,
          bankAccountNumber: null,
          bankName: null,
          bankIfscCode: null,
          upiId: 'sample.society@example',
          transferInstructions: null,
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .put(`/api/v1/societies/${societyId}/billing/payment-instructions`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        bankAccountName: null,
        bankAccountNumber: null,
        bankName: null,
        bankIfscCode: null,
        upiId: 'sample.society@example',
        instructions: null,
      });
    expect(response.status).toBe(200);
    expect(response.body.paymentInstructions.upiId).toBe('sample.society@example');
  });

  it('stores society Razorpay secrets encrypted and never returns the secrets', async () => {
    const transaction = {
      $queryRaw: vi.fn(),
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-membership' }) },
      societyRazorpayAccount: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockImplementation(({ data }) => ({
          ...data,
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
        })),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .put(`/api/v1/societies/${societyId}/billing/razorpay-account`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        enabled: true,
        keyId: 'rzp_test_society123',
        keySecret: 'society-api-secret',
        webhookSecret: 'society-webhook-secret',
      });

    expect(response.status).toBe(200);
    expect(response.body.paymentAccount).toMatchObject({
      configured: true,
      keyId: 'rzp_test_society123',
    });
    expect(JSON.stringify(response.body)).not.toContain('society-api-secret');
    expect(JSON.stringify(response.body)).not.toContain('society-webhook-secret');
    const saved = transaction.societyRazorpayAccount.create.mock.calls[0][0].data;
    expect(saved.apiSecretEncrypted).not.toBe('society-api-secret');
    expect(saved.webhookSecretEncrypted).not.toBe('society-webhook-secret');
    expect(saved.active).toBeUndefined();
  });

  it('rejects non-admin roles from configuring a society merchant account', async () => {
    const transaction = {
      $queryRaw: vi.fn(),
      societyMembership: { findFirst: vi.fn().mockResolvedValue(null) },
      societyRazorpayAccount: { updateMany: vi.fn(), create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .put(`/api/v1/societies/${societyId}/billing/razorpay-account`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        enabled: true,
        keyId: 'rzp_test_society123',
        keySecret: 'society-api-secret',
        webhookSecret: 'society-webhook-secret',
      });

    expect(response.status).toBe(404);
    expect(transaction.societyRazorpayAccount.create).not.toHaveBeenCalled();
  });

  it('lets society admins and accountants upload a verified invoice document', async () => {
    const attachment = {
      id: '1cc8a1d3-1df9-4b12-a37e-00aa734a80ee',
      originalName: 'maintenance-november.pdf',
      mimeType: 'application/pdf',
      byteSize: 12,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    };
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'accountant-membership' }) },
      $queryRaw: vi.fn(),
      invoice: { findFirst: vi.fn().mockResolvedValue({ id: invoiceId, status: 'ISSUED' }) },
      invoiceAttachment: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue(attachment),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const bytes = Buffer.from('%PDF-1.7 doc');
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/billing/${invoiceId}/attachments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .set('X-File-Name', 'maintenance-november.pdf')
      .set('Content-Type', 'application/pdf')
      .send(bytes);
    expect(response.status).toBe(201);
    expect(response.body.attachment).toMatchObject({ originalName: 'maintenance-november.pdf' });
    expect(transaction.invoiceAttachment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ societyId, invoiceId, uploadedById: userId, bytes }),
      select: expect.any(Object),
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'INVOICE_DOCUMENT_ADDED', resourceId: invoiceId }),
    });
  });

  it('rejects a bill document whose content does not match its declared type', async () => {
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/billing/${invoiceId}/attachments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .set('X-File-Name', 'fake.pdf')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('<script>alert(1)</script>'));
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe('FILE_CONTENT_MISMATCH');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets a resident download only an attached bill for their own flat', async () => {
    const attachment = {
      id: '1cc8a1d3-1df9-4b12-a37e-00aa734a80ee',
      originalName: 'maintenance-november.pdf',
      mimeType: 'application/pdf',
      byteSize: 12,
      bytes: Buffer.from('%PDF-1.7 doc'),
    };
    prisma.societyMembership.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'resident-membership' });
    prisma.invoice.findFirst.mockResolvedValueOnce({ id: invoiceId });
    prisma.invoiceAttachment.findFirst.mockResolvedValueOnce(attachment);
    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/billing/${invoiceId}/attachments/${attachment.id}`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(binaryParser);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('maintenance-november.pdf');
    expect(Buffer.from(response.body)).toEqual(attachment.bytes);
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
      where: {
        id: invoiceId,
        societyId,
        status: { not: 'VOID' },
        flat: { residents: { some: { email: 'admin@example.test', status: 'ACTIVE' } } },
      },
      select: { id: true },
    });
  });

  it('returns only bills for flats linked to the resident account email', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'resident-membership' });
    prisma.resident.findMany.mockResolvedValue([
      { id: 'resident-record', fullName: 'Resident User', flat: { id: 'own-flat' } },
    ]);
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: invoiceId,
        flatId: 'own-flat',
        amountPaise: 12500n,
        status: 'PARTIAL',
        payments: [{ id: 'payment-id', amountPaise: 2500n, method: 'UPI' }],
      },
    ]);

    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/billing/mine`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.invoices[0]).toMatchObject({
      flatId: 'own-flat',
      amount: 125,
      paidAmount: 25,
      balance: 100,
      payments: [{ amount: 25 }],
    });
    expect(prisma.resident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { societyId, email: 'admin@example.test', status: 'ACTIVE' },
      }),
    );
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ flatId: { in: ['own-flat'] } }) }),
    );
  });

  it('does not expose resident bills to other roles', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/billing/mine`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
    expect(prisma.resident.findMany).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('generates monthly charges for the selected flats and skips duplicates', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'accountant-membership' }),
      },
      flat: {
        findMany: vi.fn().mockResolvedValue([{ id: 'flat-one' }, { id: 'flat-two' }]),
      },
      invoice: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/billing/generate`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        description: 'Monthly maintenance',
        period: '2026-11',
        amount: '1800.00',
        dueDate: '2026-11-30',
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      createdCount: 1,
      skippedCount: 1,
      scope: 'OCCUPIED',
      period: '2026-11',
    });
    expect(transaction.flat.findMany).toHaveBeenCalledWith({
      where: { societyId, occupancyStatus: 'OCCUPIED' },
      select: { id: true },
    });
    expect(transaction.invoice.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ societyId, flatId: 'flat-one', amountPaise: 180000n }),
        expect.objectContaining({ societyId, flatId: 'flat-two', amountPaise: 180000n }),
      ]),
      skipDuplicates: true,
    });
  });

  it('rejects payments above the invoice balance without writing a receipt', async () => {
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-id' }) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      invoice: {
        findFirst: vi.fn().mockResolvedValue({
          id: invoiceId,
          status: 'ISSUED',
          amountPaise: 10000n,
          payments: [{ amountPaise: 2500n }],
        }),
        update: vi.fn(),
      },
      payment: { create: vi.fn() },
      paymentOrder: { findFirst: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/billing/${invoiceId}/payments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ amount: '80.00', method: 'UPI' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(transaction.payment.create).not.toHaveBeenCalled();
  });

  it('records a payment in integer paise and returns a safe decimal API amount', async () => {
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-id' }) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      invoice: {
        findFirst: vi.fn().mockResolvedValue({
          id: invoiceId,
          status: 'ISSUED',
          amountPaise: 10001n,
          payments: [{ amountPaise: 2500n }],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      payment: {
        create: vi.fn().mockResolvedValue({
          id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
          amountPaise: 7501n,
          method: 'UPI',
        }),
      },
      paymentOrder: { findFirst: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/billing/${invoiceId}/payments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ amount: '75.01', method: 'UPI' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'PAID', balance: 0, payment: { amount: 75.01 } });
    expect(transaction.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ societyId, invoiceId, amountPaise: 7501n, method: 'UPI' }),
    });
    expect(transaction.invoice.update).toHaveBeenCalledWith({
      where: { id: invoiceId },
      data: { status: 'PAID' },
    });
  });

  it('rejects currency precision finer than one paise', async () => {
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/billing/${invoiceId}/payments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ amount: '1.001', method: 'UPI' });
    expect(response.status).toBe(400);
  });
});
