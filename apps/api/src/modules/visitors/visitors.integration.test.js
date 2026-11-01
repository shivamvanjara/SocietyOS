import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { prisma as appPrisma } from '../../config/database.js';
import { createCsrfToken, createSessionToken, hashSessionToken } from '../auth/security.js';
import { app } from '../../app.js';

const databaseTests = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 }),
});
const guardToken = createSessionToken();
const residentToken = createSessionToken();
const guardCookie = `societyos_session=${guardToken}`;
const residentCookie = `societyos_session=${residentToken}`;
const guardCsrf = createCsrfToken(guardToken);
const residentCsrf = createCsrfToken(residentToken);
let guardId;
let residentId;
let residentEmail;
let societyId;
let flatId;

databaseTests('Security Guard visitor desk with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    const guard = await prisma.user.create({
      data: { email: `guard-${randomUUID()}@example.test`, passwordHash: 'integration-test-hash' },
    });
    guardId = guard.id;
    residentEmail = `resident-${randomUUID()}@example.test`;
    const resident = await prisma.user.create({
      data: {
        email: residentEmail,
        passwordHash: 'integration-test-hash',
      },
    });
    residentId = resident.id;
    const society = await prisma.society.create({
      data: { name: 'Guard Desk Integration Society', slug: `guard-${randomUUID()}` },
    });
    societyId = society.id;
    const building = await prisma.building.create({ data: { societyId, name: 'North Block' } });
    const flat = await prisma.flat.create({
      data: { societyId, buildingId: building.id, flatNumber: '9A', floor: 9 },
    });
    flatId = flat.id;
    await prisma.resident.create({
      data: {
        societyId,
        flatId,
        fullName: 'Integration Resident',
        email: residentEmail,
        residentType: 'OWNER',
      },
    });
    await prisma.societyMembership.createMany({
      data: [
        { userId: guardId, societyId, role: 'SECURITY_GUARD' },
        { userId: residentId, societyId, role: 'RESIDENT' },
      ],
    });
    await prisma.session.createMany({
      data: [
        {
          userId: guardId,
          tokenHash: hashSessionToken(guardToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          userId: residentId,
          tokenHash: hashSessionToken(residentToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });
  });

  afterAll(async () => {
    if (societyId) {
      await prisma.visitorPass.deleteMany({ where: { societyId } });
      await prisma.auditLog.deleteMany({ where: { societyId } });
      await prisma.resident.deleteMany({ where: { societyId } });
      await prisma.societyMembership.deleteMany({ where: { societyId } });
      await prisma.session.deleteMany({
        where: { userId: { in: [guardId, residentId].filter(Boolean) } },
      });
      await prisma.flat.deleteMany({ where: { societyId } });
      await prisma.building.deleteMany({ where: { societyId } });
      await prisma.society.delete({ where: { id: societyId } });
    }
    if (guardId) await prisma.user.delete({ where: { id: guardId } });
    if (residentId) await prisma.user.delete({ where: { id: residentId } });
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('registers, approves, checks in, searches and checks out a visitor while enforcing guard access', async () => {
    const arrival = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals`)
      .set('Cookie', guardCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', guardCsrf)
      .send({
        flatId,
        visitorName: 'Maya Courier',
        visitorPhone: '+919876543210',
        purpose: 'Parcel delivery',
        visitorType: 'DELIVERY',
      });
    expect(arrival.status).toBe(201);
    const passId = arrival.body.pass.id;
    expect(await prisma.visitorPass.findUnique({ where: { id: passId } })).toMatchObject({
      societyId,
      flatId,
      visitorType: 'DELIVERY',
      status: 'PENDING_APPROVAL',
      createdById: guardId,
    });

    const guardApproval = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals/${passId}/approve`)
      .set('Cookie', guardCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', guardCsrf)
      .send({});
    expect(guardApproval.status).toBe(403);

    const approvalQueue = await request(app)
      .get(`/api/v1/societies/${societyId}/visitors/approvals`)
      .set('Cookie', residentCookie);
    expect(approvalQueue.status).toBe(200);
    expect(approvalQueue.body.arrivals).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: passId, status: 'PENDING_APPROVAL' })]),
    );

    const residentApproval = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals/${passId}/approve`)
      .set('Cookie', residentCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', residentCsrf)
      .send({});
    expect(residentApproval.status).toBe(204);
    expect(await prisma.visitorPass.findUnique({ where: { id: passId } })).toMatchObject({
      status: 'APPROVED',
      authorizedById: residentId,
    });

    const admitted = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals/${passId}/enter`)
      .set('Cookie', guardCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', guardCsrf)
      .send({});
    expect(admitted.status).toBe(204);
    expect(await prisma.visitorPass.findUnique({ where: { id: passId } })).toMatchObject({
      status: 'CHECKED_IN',
      checkedInById: guardId,
    });

    const dashboard = await request(app)
      .get(`/api/v1/societies/${societyId}/visitors/passes`)
      .set('Cookie', guardCookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.metrics).toMatchObject({
      entriesToday: 1,
      inside: 1,
      pendingApprovals: 0,
      completedExits: 0,
    });
    expect(dashboard.body.passes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: passId, visitorType: 'DELIVERY', status: 'CHECKED_IN' }),
      ]),
    );

    const residentExit = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/passes/${passId}/checkout`)
      .set('Cookie', residentCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', residentCsrf)
      .send({});
    expect(residentExit.status).toBe(403);

    const exited = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/passes/${passId}/checkout`)
      .set('Cookie', guardCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', guardCsrf)
      .send({});
    expect(exited.status).toBe(204);
    const history = await request(app)
      .get(`/api/v1/societies/${societyId}/visitors/passes?search=Maya`)
      .set('Cookie', guardCookie);
    expect(history.body.passes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: passId, status: 'CHECKED_OUT' })]),
    );
    expect(history.body.metrics).toMatchObject({
      entriesToday: 1,
      inside: 0,
      pendingApprovals: 0,
      completedExits: 1,
    });

    const declinedArrival = await request(app)
      .post(`/api/v1/societies/${societyId}/visitors/arrivals`)
      .set('Cookie', guardCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', guardCsrf)
      .send({
        flatId,
        visitorName: 'Service Technician',
        visitorPhone: '+919876543211',
        purpose: 'Repair request not approved',
        visitorType: 'SERVICE_PERSONNEL',
      });
    expect(declinedArrival.status).toBe(201);
    const declinedByGuard = await request(app)
      .post(
        `/api/v1/societies/${societyId}/visitors/arrivals/${declinedArrival.body.pass.id}/reject`,
      )
      .set('Cookie', guardCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', guardCsrf)
      .send({});
    expect(declinedByGuard.status).toBe(403);
    const declined = await request(app)
      .post(
        `/api/v1/societies/${societyId}/visitors/arrivals/${declinedArrival.body.pass.id}/reject`,
      )
      .set('Cookie', residentCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', residentCsrf)
      .send({});
    expect(declined.status).toBe(204);
    expect(
      await prisma.visitorPass.findUnique({ where: { id: declinedArrival.body.pass.id } }),
    ).toMatchObject({ status: 'REJECTED', visitorType: 'SERVICE_PERSONNEL' });

    const otherSociety = await request(app)
      .get(`/api/v1/societies/${randomUUID()}/visitors/passes`)
      .set('Cookie', guardCookie);
    expect(otherSociety.status).toBe(404);
  });
});
