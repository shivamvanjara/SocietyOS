import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    societyMembership: { findFirst: vi.fn() },
    building: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    flat: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
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

const token = 'building-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const buildingId = '73c5ceef-d911-4dbe-a27e-661808ef72f2';
const flatId = '2f5b0176-271c-4055-a69d-96183f4ad6e1';
const cookie = `societyos_session=${token}`;
const origin = 'http://localhost:5173';
const csrfToken = createCsrfToken(token);

describe('building and flat management API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'admin@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
    prisma.societyMembership.findFirst.mockResolvedValue({ role: 'SOCIETY_ADMIN' });
  });

  it('lists only the authenticated member’s buildings and real occupancy totals', async () => {
    prisma.building.findMany.mockResolvedValue([
      { id: buildingId, societyId, name: 'Block A', _count: { flats: 2 } },
    ]);
    prisma.building.count.mockResolvedValue(1);
    prisma.flat.groupBy.mockResolvedValue([
      { occupancyStatus: 'OCCUPIED', _count: { _all: 1 } },
      { occupancyStatus: 'VACANT', _count: { _all: 1 } },
    ]);

    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/buildings`)
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({
      buildingCount: 1,
      flatCount: 2,
      occupiedCount: 1,
      vacantCount: 1,
    });
    expect(prisma.building.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { societyId } }),
    );
    expect(prisma.societyMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { societyId, userId, active: true, society: { status: 'ACTIVE' } },
      }),
    );
  });

  it('creates a building under the society ID from the authorized route', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: societyId }]),
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ role: 'SOCIETY_ADMIN' }) },
      societySubscription: { findFirst: vi.fn().mockResolvedValue(null) },
      building: {
        count: vi.fn().mockResolvedValue(0),
        create: vi
          .fn()
          .mockResolvedValue({ id: buildingId, societyId, name: 'Block A', _count: { flats: 0 } }),
      },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/buildings`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Block A' });

    expect(response.status).toBe(201);
    expect(transaction.building.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { societyId, name: 'Block A' } }),
    );
  });

  it('denies creating a building for a society the caller does not belong to', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: societyId }]),
      societyMembership: { findFirst: vi.fn().mockResolvedValue(null) },
      societySubscription: { findFirst: vi.fn().mockResolvedValue(null) },
      building: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/buildings`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Other Society Block' });

    expect(response.status).toBe(404);
    expect(transaction.building.create).not.toHaveBeenCalled();
  });

  it('creates a flat within a building belonging to the same authorized society', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: societyId }]),
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ role: 'SOCIETY_ADMIN' }) },
      societySubscription: { findFirst: vi.fn().mockResolvedValue(null) },
      building: { findFirst: vi.fn().mockResolvedValue({ id: buildingId }) },
      flat: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({
          id: flatId,
          societyId,
          buildingId,
          flatNumber: '101',
          floor: 1,
          occupancyStatus: 'VACANT',
        }),
      },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/buildings/${buildingId}/flats`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ flatNumber: '101', floor: 1, flatType: '2 BHK' });

    expect(response.status).toBe(201);
    expect(transaction.flat.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          societyId,
          buildingId,
          flatNumber: '101',
          floor: 1,
          occupancyStatus: 'VACANT',
        }),
      }),
    );
  });

  it('rejects a building that would exceed the active plan limit', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: societyId }]),
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ role: 'SOCIETY_ADMIN' }) },
      societySubscription: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: null,
          maxBuildings: 1,
          maxFlats: 100,
        }),
      },
      building: { count: vi.fn().mockResolvedValue(1), create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/buildings`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Block B' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(transaction.building.create).not.toHaveBeenCalled();
  });

  it('rejects a flat that would exceed the active plan limit', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: societyId }]),
      societyMembership: { findFirst: vi.fn().mockResolvedValue({ role: 'SOCIETY_ADMIN' }) },
      societySubscription: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: null,
          maxBuildings: 10,
          maxFlats: 1,
        }),
      },
      building: {
        findFirst: vi.fn().mockResolvedValue({ id: buildingId }),
      },
      flat: { count: vi.fn().mockResolvedValue(1), create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/buildings/${buildingId}/flats`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ flatNumber: '102', floor: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(transaction.flat.create).not.toHaveBeenCalled();
  });

  it('does not reveal buildings when the caller has no active society membership', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/buildings/${buildingId}/flats`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SOCIETY_NOT_FOUND');
    expect(prisma.flat.findMany).not.toHaveBeenCalled();
  });

  it('rejects a floor outside the database-supported range', async () => {
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/buildings/${buildingId}/flats`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ flatNumber: '201', floor: 201 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
