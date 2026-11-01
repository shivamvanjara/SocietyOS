import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    societyMembership: { findFirst: vi.fn() },
    session: { findUnique: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock('../../config/database.js', () => ({ prisma }));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
const [{ app }, { createCsrfToken }] = await Promise.all([
  import('../../app.js'),
  import('../auth/security.js'),
]);

const token = 'expenses-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

describe('society expense API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: userId,
        email: 'accountant@example.test',
        platformRole: 'USER',
        status: 'ACTIVE',
      },
    });
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'membership-id' });
  });

  it('stores an expense amount in integer paise and audits the record', async () => {
    const expense = {
      id: 'ce413c49-265d-4668-ab36-4b3ef6ac1f70',
      societyId,
      category: 'Utilities',
      description: 'Water pump repair',
      amountPaise: 125050n,
      spentAt: new Date('2026-10-31T00:00:00.000Z'),
    };
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-id' }) },
      expense: { create: vi.fn().mockResolvedValue(expense) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/expenses`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        category: 'Utilities',
        description: 'Water pump repair',
        amount: '1250.50',
        spentAt: '2026-10-31',
      });

    expect(response.status).toBe(201);
    expect(response.body.expense.amount).toBe(1250.5);
    expect(transaction.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ societyId, amountPaise: 125050n }),
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId,
        actorUserId: userId,
        eventType: 'EXPENSE_SUBMITTED',
      }),
    });
  });

  it('rejects amounts with fractions smaller than one paise', async () => {
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/expenses`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        category: 'Utilities',
        description: 'Water pump repair',
        amount: '1.001',
        spentAt: '2026-10-31',
      });
    expect(response.status).toBe(400);
  });

  it('stores a validated bill document for an expense in the same society', async () => {
    const expenseId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
    const attachment = {
      id: '1cc8a1d3-1df9-4b12-a37e-00aa734a80ee',
      originalName: 'repair-bill.pdf',
      mimeType: 'application/pdf',
      byteSize: 12,
      createdAt: new Date('2026-10-31T00:00:00.000Z'),
    };
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-id' }) },
      $queryRaw: vi.fn(),
      expense: { findFirst: vi.fn().mockResolvedValue({ id: expenseId }) },
      expenseAttachment: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue(attachment),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const bytes = Buffer.from('%PDF-1.7 doc');
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/expenses/${expenseId}/attachments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .set('X-File-Name', 'repair-bill.pdf')
      .set('Content-Type', 'application/pdf')
      .send(bytes);

    expect(response.status).toBe(201);
    expect(response.body.attachment).toMatchObject({ originalName: 'repair-bill.pdf' });
    expect(transaction.expenseAttachment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId,
        expenseId,
        uploadedById: userId,
        bytes,
      }),
      select: expect.any(Object),
    });
  });

  it('rejects documents whose content does not match the declared file type', async () => {
    const response = await request(app)
      .post(
        `/api/v1/societies/${societyId}/expenses/ce413c49-265d-4668-ab36-4b3ef6ac1f70/attachments`,
      )
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

  it('allows only a different society administrator to approve a submitted expense', async () => {
    const expense = {
      id: 'ce413c49-265d-4668-ab36-4b3ef6ac1f70',
      status: 'SUBMITTED',
      createdById: '8c5f7e8b-5002-47bf-b997-d5d50ebeeedf',
    };
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-membership' }) },
      $queryRaw: vi.fn(),
      expense: {
        findFirst: vi.fn().mockResolvedValue(expense),
        update: vi.fn().mockResolvedValue({}),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/expenses/${expense.id}/approve`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({});

    expect(response.status).toBe(200);
    expect(transaction.expense.update).toHaveBeenCalledWith({
      where: { id: expense.id },
      data: expect.objectContaining({ status: 'APPROVED', reviewedById: userId }),
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'EXPENSE_APPROVED' }),
    });
  });

  it('prevents an expense submitter from approving their own expense', async () => {
    const expense = {
      id: 'ce413c49-265d-4668-ab36-4b3ef6ac1f70',
      status: 'SUBMITTED',
      createdById: userId,
    };
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-membership' }) },
      $queryRaw: vi.fn(),
      expense: { findFirst: vi.fn().mockResolvedValue(expense), update: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/expenses/${expense.id}/approve`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
    expect(transaction.expense.update).not.toHaveBeenCalled();
  });
});
