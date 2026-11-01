import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    societyMembership: { findFirst: vi.fn() },
    facility: { findMany: vi.fn() },
    facilityBooking: { findMany: vi.fn() },
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

const token = 'facilities-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const facilityId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

describe('facility booking API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'resident@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
  });

  it('limits a resident booking history to their own requests', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'member-id', role: 'RESIDENT' });
    prisma.facilityBooking.findMany.mockResolvedValue([]);
    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/facilities/bookings`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(prisma.facilityBooking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { societyId, requesterId: userId },
      }),
    );
  });

  it('rejects an overlapping facility booking under the locked facility transaction', async () => {
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'member-id', role: 'RESIDENT' }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      facility: { findFirst: vi.fn().mockResolvedValue({ id: facilityId }) },
      facilityBooking: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing-booking' }),
        create: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/facilities/bookings`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({
        facilityId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        purpose: 'Community gathering',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BOOKING_CONFLICT');
    expect(transaction.$queryRaw).toHaveBeenCalled();
    expect(transaction.facilityBooking.create).not.toHaveBeenCalled();
  });
});
