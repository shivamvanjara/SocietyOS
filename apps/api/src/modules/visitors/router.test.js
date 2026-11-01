import { createHash } from 'node:crypto';
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

const token = 'visitors-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const flatId = '2f5b0176-271c-4055-a69d-96183f4ad6e1';
const passId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

describe('visitor pass API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'admin@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
  });

  it('stores only a hash and returns the one-time visitor code', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'admin-id', role: 'SOCIETY_ADMIN' }),
      },
      flat: {
        findFirst: vi.fn().mockResolvedValue({
          id: flatId,
          flatNumber: '10A',
          building: { name: 'North' },
        }),
      },
      society: { findUnique: vi.fn().mockResolvedValue({ name: 'Cedar Court' }) },
      resident: { findMany: vi.fn().mockResolvedValue([{ email: 'resident@example.test' }]) },
      visitorPass: {
        create: vi.fn().mockResolvedValue({ id: passId, visitorName: 'Guest', status: 'EXPECTED' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const expectedAt = new Date(Date.now() + 60 * 60 * 1000);
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/passes`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        flatId,
        visitorName: 'Guest',
        purpose: 'Delivery',
        expectedAt: expectedAt.toISOString(),
      });

    expect(response.status).toBe(201);
    expect(response.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const savedHash = transaction.visitorPass.create.mock.calls[0][0].data.tokenHash;
    expect(savedHash).toBe(createHash('sha256').update(response.body.code).digest('hex'));
    expect(JSON.stringify(transaction.visitorPass.create.mock.calls)).not.toContain(
      response.body.code,
    );
  });

  it('checks an expected visitor in atomically through the guard endpoint', async () => {
    const code = 'A'.repeat(43);
    const pass = {
      id: passId,
      visitorName: 'Guest',
      visitorPhone: null,
      purpose: 'Delivery',
      expectedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: 'EXPECTED',
      flat: { flatNumber: '10A', building: { name: 'North' } },
    };
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'guard-id', role: 'SECURITY_GUARD' }),
      },
      visitorPass: {
        findFirst: vi.fn().mockResolvedValue(pass),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/verify`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ code });

    expect(response.status).toBe(200);
    expect(response.body.checkedIn).toBe(true);
    expect(response.body.pass.visitorName).toBe('Guest');
    expect(transaction.visitorPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'EXPECTED' }),
        data: expect.objectContaining({ status: 'CHECKED_IN', checkedInById: userId }),
      }),
    );
  });

  it('registers gate arrivals as pending approval with society scoped flat data', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'guard-id', role: 'SECURITY_GUARD' }),
      },
      flat: {
        findFirst: vi.fn().mockResolvedValue({
          id: flatId,
          flatNumber: '10A',
          building: { name: 'North' },
        }),
      },
      society: { findUnique: vi.fn().mockResolvedValue({ name: 'Cedar Court' }) },
      resident: { findMany: vi.fn().mockResolvedValue([{ email: 'resident@example.test' }]) },
      visitorPass: {
        create: vi.fn().mockResolvedValue({ id: passId, status: 'PENDING_APPROVAL' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        flatId,
        visitorName: 'Delivery Person',
        visitorPhone: '+919876543210',
        purpose: 'Parcel',
        visitorType: 'DELIVERY',
      });

    expect(response.status).toBe(201);
    expect(transaction.visitorPass.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          societyId,
          flatId,
          visitorType: 'DELIVERY',
          status: 'PENDING_APPROVAL',
          visitorPhone: '+919876543210',
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'VISITOR_ARRIVAL_REGISTERED' }),
      }),
    );
  });

  it('approves an arrival only as its destination resident', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'resident-membership', role: 'RESIDENT' }),
      },
      visitorPass: {
        findFirst: vi.fn().mockResolvedValue({ flatId }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      resident: { findFirst: vi.fn().mockResolvedValue({ id: 'resident-record' }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals/${passId}/approve`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({});

    expect(response.status).toBe(204);
    expect(transaction.visitorPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: passId, societyId, status: 'PENDING_APPROVAL' }),
        data: expect.objectContaining({ status: 'APPROVED', authorizedById: userId }),
      }),
    );
  });

  it('denies approval to guards and exit to residents', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'guard-id', role: 'SECURITY_GUARD' }),
      },
      visitorPass: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const approval = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals/${passId}/approve`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(approval.status).toBe(403);
    expect(transaction.visitorPass.updateMany).not.toHaveBeenCalled();

    const residentTransaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'resident-id', role: 'RESIDENT' }),
      },
      visitorPass: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(residentTransaction));
    const exit = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/passes/${passId}/checkout`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(exit.status).toBe(403);
    expect(residentTransaction.visitorPass.updateMany).not.toHaveBeenCalled();
  });

  it('records a guard visitor exit and audit entry', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'guard-id', role: 'SECURITY_GUARD' }),
      },
      visitorPass: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/passes/${passId}/checkout`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({});

    expect(response.status).toBe(204);
    expect(transaction.visitorPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: passId, societyId, status: 'CHECKED_IN' },
        data: expect.objectContaining({ status: 'CHECKED_OUT', checkedOutById: userId }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'VISITOR_CHECKED_OUT' }),
      }),
    );
  });
});
