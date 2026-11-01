import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { prisma as appPrisma } from '../../config/database.js';
import { app } from '../../app.js';
import { createCsrfToken, hashSessionToken, SESSION_COOKIE } from '../auth/security.js';

const integration = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 }),
});
const id = randomUUID();
const adminToken = `platform-admin-token-${id}`;
let platformAdmin;
let targetUser;
let society;
let plan;

integration('platform administration with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    platformAdmin = await prisma.user.create({
      data: {
        email: `platform-admin-${id}@example.test`,
        passwordHash: 'integration-test-hash',
        platformRole: 'SUPER_ADMIN',
      },
    });
    targetUser = await prisma.user.create({
      data: {
        email: `platform-member-${id}@example.test`,
        passwordHash: 'integration-test-hash',
      },
    });
    society = await prisma.society.create({
      data: { name: 'Platform Admin Integration Society', slug: `platform-${id.slice(0, 12)}` },
    });
    await prisma.societyMembership.createMany({
      data: [
        { societyId: society.id, userId: platformAdmin.id, role: 'SOCIETY_ADMIN' },
        { societyId: society.id, userId: targetUser.id, role: 'RESIDENT' },
      ],
    });
    await prisma.session.createMany({
      data: [platformAdmin.id, targetUser.id].map((userId) => ({
        userId,
        tokenHash: hashSessionToken(userId === platformAdmin.id ? adminToken : `member-${id}`),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })),
    });
  });

  afterAll(async () => {
    if (platformAdmin) {
      await prisma.platformAuditLog.deleteMany({ where: { actorUserId: platformAdmin.id } });
      await prisma.session.deleteMany({ where: { userId: platformAdmin.id } });
    }
    if (society) await prisma.societySubscription.deleteMany({ where: { societyId: society.id } });
    if (society) {
      await prisma.flat.deleteMany({ where: { societyId: society.id } });
      await prisma.building.deleteMany({ where: { societyId: society.id } });
      await prisma.societyMembership.deleteMany({ where: { societyId: society.id } });
      await prisma.society.deleteMany({ where: { id: society.id } });
    }
    if (plan) await prisma.subscriptionPlan.deleteMany({ where: { id: plan.id } });
    if (targetUser) await prisma.session.deleteMany({ where: { userId: targetUser.id } });
    await prisma.user.deleteMany({
      where: { id: { in: [platformAdmin?.id, targetUser?.id].filter(Boolean) } },
    });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('lists, suspends and restores a society with durable audit events', async () => {
    const cookie = `${SESSION_COOKIE}=${adminToken}`;
    const csrfToken = createCsrfToken(adminToken);
    const listed = await request(app)
      .get(
        `/api/v1/platform-admin/societies?search=${encodeURIComponent('Platform Admin Integration Society')}`,
      )
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.societies).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: society.id, status: 'ACTIVE' })]),
    );

    for (const status of ['SUSPENDED', 'ACTIVE']) {
      const changed = await request(app)
        .patch(`/api/v1/platform-admin/societies/${society.id}/status`)
        .set('Cookie', cookie)
        .set('Origin', env.WEB_ORIGIN)
        .set('X-CSRF-Token', csrfToken)
        .send({ status });
      expect(changed.status, `${status}: ${JSON.stringify(changed.body)}`).toBe(200);
      expect(changed.body.society.status).toBe(status);
    }

    const audit = await prisma.platformAuditLog.findMany({
      where: { actorUserId: platformAdmin.id, resourceId: society.id },
      orderBy: { eventType: 'asc' },
    });
    expect(audit.map((entry) => entry.eventType)).toEqual(['SOCIETY_ACTIVE', 'SOCIETY_SUSPENDED']);
  });

  it('revokes a suspended member’s sessions and records the status change', async () => {
    const memberToken = `member-${id}`;
    const changed = await request(app)
      .patch(`/api/v1/platform-admin/users/${targetUser.id}/status`)
      .set('Cookie', `${SESSION_COOKIE}=${adminToken}`)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', createCsrfToken(adminToken))
      .send({ status: 'SUSPENDED' });

    expect(changed.status).toBe(200);
    expect(
      await prisma.user.findUnique({ where: { id: targetUser.id }, select: { status: true } }),
    ).toEqual({
      status: 'SUSPENDED',
    });
    expect(
      await prisma.session.count({ where: { tokenHash: hashSessionToken(memberToken) } }),
    ).toBe(0);
    expect(
      await prisma.platformAuditLog.count({
        where: {
          actorUserId: platformAdmin.id,
          eventType: 'USER_SUSPENDED',
          resourceId: targetUser.id,
        },
      }),
    ).toBe(1);
  });

  it('creates plans, assigns a society subscription, and records lifecycle changes', async () => {
    const cookie = `${SESSION_COOKIE}=${adminToken}`;
    const csrfToken = createCsrfToken(adminToken);
    const planResponse = await request(app)
      .post('/api/v1/platform-admin/subscription-plans')
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: `Integration ${id.slice(0, 8)}`,
        description: 'Test plan',
        billingInterval: 'ANNUAL',
        price: '1500.00',
        maxBuildings: 1,
        maxFlats: 1,
      });
    expect(planResponse.status).toBe(201);
    expect(planResponse.body.subscriptionPlan.price).toBe('1500.00');
    plan = await prisma.subscriptionPlan.findUnique({
      where: { id: planResponse.body.subscriptionPlan.id },
    });

    const assigned = await request(app)
      .post(`/api/v1/platform-admin/societies/${society.id}/subscriptions`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ planId: plan.id, status: 'TRIAL' });
    expect(assigned.status).toBe(201);
    expect(assigned.body.subscription).toMatchObject({
      status: 'TRIAL',
      price: '1500.00',
      maxBuildings: 1,
      maxFlats: 1,
    });

    const subscriptionId = assigned.body.subscription.id;
    const activated = await request(app)
      .patch(`/api/v1/platform-admin/subscriptions/${subscriptionId}/status`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'ACTIVE' });
    expect(activated.status).toBe(200);
    expect(activated.body.subscription.status).toBe('ACTIVE');

    const changedLimits = await request(app)
      .patch(`/api/v1/platform-admin/subscription-plans/${plan.id}`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ maxBuildings: 3, maxFlats: 2 });
    expect(changedLimits.status).toBe(200);
    expect(changedLimits.body.subscriptionPlan).toMatchObject({ maxBuildings: 3, maxFlats: 2 });

    const buildingsRoot = `/api/v1/societies/${society.id}/buildings`;
    const buildingResults = await Promise.all(
      ['Block A', 'Block B'].map((name) =>
        request(app)
          .post(buildingsRoot)
          .set('Cookie', cookie)
          .set('Origin', env.WEB_ORIGIN)
          .set('X-CSRF-Token', csrfToken)
          .send({ name }),
      ),
    );
    expect(buildingResults.map((result) => result.status).sort()).toEqual([201, 409]);
    const firstBuilding = buildingResults.find((result) => result.status === 201);
    expect(buildingResults.find((result) => result.status === 409).body.error.code).toBe(
      'PLAN_LIMIT_REACHED',
    );

    const flatsRoot = `${buildingsRoot}/${firstBuilding.body.building.id}/flats`;
    const flatResults = await Promise.all(
      ['101', '102'].map((flatNumber) =>
        request(app)
          .post(flatsRoot)
          .set('Cookie', cookie)
          .set('Origin', env.WEB_ORIGIN)
          .set('X-CSRF-Token', csrfToken)
          .send({ flatNumber, floor: 1 }),
      ),
    );
    expect(flatResults.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(flatResults.find((result) => result.status === 409).body.error.code).toBe(
      'PLAN_LIMIT_REACHED',
    );

    const duplicate = await request(app)
      .post(`/api/v1/platform-admin/societies/${society.id}/subscriptions`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ planId: plan.id, status: 'ACTIVE' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('SUBSCRIPTION_ALREADY_ACTIVE');

    const editedPlan = await request(app)
      .patch(`/api/v1/platform-admin/subscription-plans/${plan.id}`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ price: '2000.00' });
    expect(editedPlan.status).toBe(200);
    expect(editedPlan.body.subscriptionPlan.price).toBe('2000.00');
    const listed = await request(app)
      .get(
        `/api/v1/platform-admin/subscriptions?search=${encodeURIComponent('Platform Admin Integration Society')}`,
      )
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.subscriptions[0].price).toBe('1500.00');
    expect(listed.body.subscriptions[0].maxBuildings).toBe(1);
    expect(listed.body.subscriptions[0].maxFlats).toBe(1);

    const canceled = await request(app)
      .patch(`/api/v1/platform-admin/subscriptions/${subscriptionId}/status`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'CANCELED' });
    expect(canceled.status).toBe(200);
    expect(canceled.body.subscription.status).toBe('CANCELED');
    const afterCancellation = await request(app)
      .post(buildingsRoot)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Block C' });
    expect(afterCancellation.status).toBe(402);
    expect(afterCancellation.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(
      await prisma.platformAuditLog.count({
        where: {
          actorUserId: platformAdmin.id,
          resourceType: 'SOCIETY_SUBSCRIPTION',
          resourceId: subscriptionId,
        },
      }),
    ).toBe(3);
  });
});
