import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    societyMembership: { findFirst: vi.fn() },
    flat: { findFirst: vi.fn() },
    resident: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
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

const token = 'resident-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const flatId = '2f5b0176-271c-4055-a69d-96183f4ad6e1';
const residentId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
const cookie = `societyos_session=${token}`;
const origin = 'http://localhost:5173';
const csrfToken = createCsrfToken(token);

describe('resident management API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'admin@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
    prisma.societyMembership.findFirst.mockResolvedValue({
      id: '46b53e67-efb1-42ea-8ee8-aa2cf86dbf80',
    });
  });

  it('restricts resident contact details to society administrators', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/residents`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SOCIETY_NOT_FOUND');
    expect(prisma.resident.findMany).not.toHaveBeenCalled();
  });

  it('returns only the active resident profiles linked to the signed-in email', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'resident-membership' });
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-id',
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: userId,
        email: 'resident@example.test',
        platformRole: 'USER',
        status: 'ACTIVE',
      },
    });
    prisma.resident.findMany.mockResolvedValue([
      {
        id: residentId,
        fullName: 'Sam Resident',
        residentType: 'OWNER',
        flat: { id: flatId, flatNumber: 'A-12', building: { name: 'Block A' } },
      },
    ]);

    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/residents/me`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.residents).toEqual([
      expect.objectContaining({
        fullName: 'Sam Resident',
        flat: expect.objectContaining({ flatNumber: 'A-12', building: { name: 'Block A' } }),
      }),
    ]);
    expect(prisma.resident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { societyId, email: 'resident@example.test', status: 'ACTIVE' },
      }),
    );
  });

  it('creates a resident only on a flat in the authorized society and writes a PII-free audit event', async () => {
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-id' }) },
      flat: { findFirst: vi.fn().mockResolvedValue({ id: flatId }) },
      resident: {
        create: vi.fn().mockResolvedValue({
          id: residentId,
          societyId,
          flatId,
          fullName: 'Sam Resident',
          residentType: 'OWNER',
          status: 'ACTIVE',
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/residents`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ fullName: 'Sam Resident', flatId, residentType: 'OWNER', phone: '+919876543210' });

    expect(response.status).toBe(201);
    expect(transaction.resident.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          societyId,
          flatId,
          fullName: 'Sam Resident',
          residentType: 'OWNER',
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        societyId,
        actorUserId: userId,
        eventType: 'RESIDENT_CREATED',
        resourceType: 'RESIDENT',
        resourceId: residentId,
      },
    });
    expect(JSON.stringify(transaction.auditLog.create.mock.calls)).not.toContain('Sam Resident');
  });

  it('rejects assigning a resident to another society’s flat', async () => {
    const transaction = {
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ id: 'membership-id' }) },
      flat: { findFirst: vi.fn().mockResolvedValue(null) },
      resident: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/residents`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ fullName: 'Sam Resident', flatId, residentType: 'TENANT' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('FLAT_NOT_FOUND');
    expect(transaction.resident.create).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects malformed phone numbers before writing personal data', async () => {
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/residents`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ fullName: 'Sam Resident', flatId, residentType: 'TENANT', phone: '123' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
