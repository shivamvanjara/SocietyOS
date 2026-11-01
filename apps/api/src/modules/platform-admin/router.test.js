import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    society: { count: vi.fn(), findMany: vi.fn() },
    user: { count: vi.fn(), findMany: vi.fn() },
    flat: { count: vi.fn() },
    platformAuditLog: { findMany: vi.fn() },
    subscriptionPlan: { findMany: vi.fn() },
    societySubscription: { findMany: vi.fn() },
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

const token = 'platform-admin-test-session-token';
const adminId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const otherId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const societyId = '73c5ceef-d911-4dbe-a27e-661808ef72f2';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);
const origin = 'http://localhost:5173';

describe('platform administration API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: adminId,
        email: 'platform@example.test',
        platformRole: 'SUPER_ADMIN',
        status: 'ACTIVE',
      },
    });
  });

  it('denies platform endpoints to ordinary society users', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-id',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: adminId, email: 'member@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });

    const response = await request(app)
      .get('/api/v1/platform-admin/overview')
      .set('Cookie', cookie);

    expect(response.status).toBe(403);
    expect(prisma.society.count).not.toHaveBeenCalled();
  });

  it('returns real platform totals and identifies the current administrator', async () => {
    prisma.society.count.mockResolvedValueOnce(4).mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    prisma.user.count.mockResolvedValueOnce(20).mockResolvedValueOnce(19).mockResolvedValueOnce(1);
    prisma.flat.count.mockResolvedValue(62);

    const response = await request(app)
      .get('/api/v1/platform-admin/overview')
      .set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      currentUserId: adminId,
      societies: { total: 4, active: 3, suspended: 1 },
      users: { total: 20, active: 19, suspended: 1 },
      flats: { total: 62 },
    });
  });

  it('suspends a society and records the platform audit event atomically', async () => {
    const tx = {
      society: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: societyId, name: 'Cedar Court', status: 'ACTIVE' }),
        update: vi
          .fn()
          .mockResolvedValue({ id: societyId, name: 'Cedar Court', status: 'SUSPENDED' }),
      },
      platformAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await request(app)
      .patch(`/api/v1/platform-admin/societies/${societyId}/status`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'SUSPENDED' });

    expect(response.status).toBe(200);
    expect(response.body.society.status).toBe('SUSPENDED');
    expect(tx.platformAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: adminId,
        eventType: 'SOCIETY_SUSPENDED',
        resourceType: 'SOCIETY',
        resourceId: societyId,
      },
    });
  });

  it('revokes sessions and records an audit entry when suspending a user', async () => {
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: otherId,
          email: 'member@example.test',
          status: 'ACTIVE',
          platformRole: 'USER',
        }),
        update: vi.fn().mockResolvedValue({
          id: otherId,
          email: 'member@example.test',
          status: 'SUSPENDED',
          platformRole: 'USER',
        }),
      },
      session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      platformAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await request(app)
      .patch(`/api/v1/platform-admin/users/${otherId}/status`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'SUSPENDED' });

    expect(response.status).toBe(200);
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: otherId } });
    expect(tx.platformAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: adminId,
        eventType: 'USER_SUSPENDED',
        resourceType: 'USER',
        resourceId: otherId,
      },
    });
  });

  it('does not allow an administrator to suspend their own account', async () => {
    const response = await request(app)
      .patch(`/api/v1/platform-admin/users/${adminId}/status`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'SUSPENDED' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SELF_SUSPENSION_NOT_ALLOWED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates a configurable subscription plan and audits its creation', async () => {
    const plan = {
      id: 'f7bd7967-195e-438e-b0b7-e3c2019243f7',
      name: 'Community',
      description: null,
      billingInterval: 'MONTHLY',
      pricePaise: 15000n,
      maxBuildings: 2,
      maxFlats: 50,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tx = {
      subscriptionPlan: { create: vi.fn().mockResolvedValue(plan) },
      platformAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await request(app)
      .post('/api/v1/platform-admin/subscription-plans')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Community',
        billingInterval: 'MONTHLY',
        price: '150.00',
        maxBuildings: 2,
        maxFlats: 50,
      });

    expect(response.status).toBe(201);
    expect(response.body.subscriptionPlan).toMatchObject({ name: 'Community', price: '150.00' });
    expect(tx.subscriptionPlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pricePaise: 15000n,
        billingInterval: 'MONTHLY',
        maxBuildings: 2,
        maxFlats: 50,
      }),
    });
    expect(tx.platformAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'SUBSCRIPTION_PLAN_CREATED',
        resourceType: 'SUBSCRIPTION_PLAN',
      }),
    });
  });

  it('assigns an active plan under the society lock and preserves the price snapshot', async () => {
    const planId = 'f7bd7967-195e-438e-b0b7-e3c2019243f7';
    const subscription = {
      id: 'ea593f24-2a23-4711-843b-e6427b269ac0',
      societyId,
      planId,
      status: 'TRIAL',
      billingInterval: 'ANNUAL',
      pricePaise: 150000n,
      maxBuildings: 2,
      maxFlats: 25,
      startsAt: new Date(),
      endsAt: null,
      society: { id: societyId, name: 'Cedar Court', status: 'ACTIVE' },
      plan: { id: planId, name: 'Community', active: true },
      createdBy: { id: adminId, email: 'platform@example.test' },
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: societyId, status: 'ACTIVE' }]),
      societySubscription: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(subscription),
      },
      subscriptionPlan: {
        findFirst: vi.fn().mockResolvedValue({
          id: planId,
          billingInterval: 'ANNUAL',
          pricePaise: 150000n,
          maxBuildings: 2,
          maxFlats: 25,
        }),
      },
      platformAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const response = await request(app)
      .post(`/api/v1/platform-admin/societies/${societyId}/subscriptions`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ planId, status: 'TRIAL' });

    expect(response.status).toBe(201);
    expect(response.body.subscription).toMatchObject({
      status: 'TRIAL',
      billingInterval: 'ANNUAL',
      price: '1500.00',
      maxBuildings: 2,
      maxFlats: 25,
    });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.societySubscription.findFirst).toHaveBeenCalledWith({
      where: { societyId, status: { in: ['PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE'] } },
      select: { id: true },
    });
    expect(tx.societySubscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          maxBuildings: 2,
          maxFlats: 25,
        }),
      }),
    );
  });
});
