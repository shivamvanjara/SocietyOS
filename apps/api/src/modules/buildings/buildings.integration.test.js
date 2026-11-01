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
const token = createSessionToken();
const csrfToken = createCsrfToken(token);
const userEmail = `buildings-${randomUUID()}@example.test`;
const cookie = `societyos_session=${token}`;
const residentToken = createSessionToken();
const residentCookie = `societyos_session=${residentToken}`;
const residentEmail = `resident-${randomUUID()}@example.test`;
let userId;
let residentUserId;
let societyId;
let otherSocietyId;
let otherBuildingId;
let otherFlatId;
let managedBuildingId;
let managedFlatId;

databaseTests('buildings and flats API with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    const user = await prisma.user.create({
      data: { email: userEmail, passwordHash: 'integration-test-hash' },
    });
    userId = user.id;
    const society = await prisma.society.create({
      data: { name: 'Buildings Integration Society', slug: `buildings-${randomUUID()}` },
    });
    societyId = society.id;
    const residentUser = await prisma.user.create({
      data: { email: residentEmail, passwordHash: 'integration-test-hash' },
    });
    residentUserId = residentUser.id;
    const otherSociety = await prisma.society.create({
      data: { name: 'Isolated Integration Society', slug: `isolated-${randomUUID()}` },
    });
    otherSocietyId = otherSociety.id;
    const otherBuilding = await prisma.building.create({
      data: { societyId: otherSocietyId, name: 'Private Block' },
    });
    otherBuildingId = otherBuilding.id;
    const otherFlat = await prisma.flat.create({
      data: { societyId: otherSocietyId, buildingId: otherBuildingId, flatNumber: '1', floor: 0 },
    });
    otherFlatId = otherFlat.id;
    await prisma.societyMembership.create({
      data: { userId, societyId, role: 'SOCIETY_ADMIN' },
    });
    await prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.societyMembership.create({
      data: { userId: residentUserId, societyId, role: 'RESIDENT' },
    });
    await prisma.session.create({
      data: {
        userId: residentUserId,
        tokenHash: hashSessionToken(residentToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    if (userId) {
      await prisma.resident.deleteMany({
        where: { societyId: { in: [societyId, otherSocietyId].filter(Boolean) } },
      });
      await prisma.payment.deleteMany({ where: { societyId } });
      await prisma.paymentOrder.deleteMany({ where: { societyId } });
      await prisma.paymentWebhookEvent.deleteMany({ where: { societyId } });
      await prisma.invoice.deleteMany({ where: { societyId } });
      await prisma.auditLog.deleteMany({
        where: { societyId: { in: [societyId, otherSocietyId].filter(Boolean) } },
      });
      await prisma.flat.deleteMany({
        where: { societyId: { in: [societyId, otherSocietyId].filter(Boolean) } },
      });
      await prisma.building.deleteMany({
        where: { societyId: { in: [societyId, otherSocietyId].filter(Boolean) } },
      });
      await prisma.societyMembership.deleteMany({
        where: { userId: { in: [userId, residentUserId].filter(Boolean) } },
      });
      await prisma.session.deleteMany({
        where: { userId: { in: [userId, residentUserId].filter(Boolean) } },
      });
      await prisma.society.deleteMany({
        where: { id: { in: [societyId, otherSocietyId].filter(Boolean) } },
      });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.user.deleteMany({ where: { id: residentUserId } });
    }
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('creates a building and flat, updates occupancy, and reports real totals', async () => {
    const browser = request.agent(app);
    const buildingResponse = await browser
      .post(`/api/v1/societies/${societyId}/buildings`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Block A' });
    expect(buildingResponse.status).toBe(201);
    const buildingId = buildingResponse.body.building.id;
    managedBuildingId = buildingId;

    const flatResponse = await browser
      .post(`/api/v1/societies/${societyId}/buildings/${buildingId}/flats`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ flatNumber: '101', floor: 1, flatType: '2 BHK' });
    expect(flatResponse.status).toBe(201);
    managedFlatId = flatResponse.body.flat.id;

    const changed = await browser
      .patch(
        `/api/v1/societies/${societyId}/buildings/${buildingId}/flats/${flatResponse.body.flat.id}`,
      )
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ occupancyStatus: 'OCCUPIED' });
    expect(changed.status).toBe(200);
    expect(changed.body.flat.occupancyStatus).toBe('OCCUPIED');

    const list = await browser
      .get(`/api/v1/societies/${societyId}/buildings`)
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.summary).toEqual({
      buildingCount: 1,
      flatCount: 1,
      occupiedCount: 1,
      vacantCount: 0,
    });
    expect(list.body.buildings[0]).toMatchObject({ id: buildingId, name: 'Block A', flatCount: 1 });

    const billingBody = {
      description: 'Generated monthly maintenance',
      period: '2026-12',
      amount: '1800.00',
      dueDate: '2026-12-31',
    };
    const generated = await browser
      .post(`/api/v1/societies/${societyId}/billing/generate`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send(billingBody);
    expect(generated.status).toBe(201);
    expect(generated.body).toMatchObject({ createdCount: 1, skippedCount: 0, scope: 'OCCUPIED' });
    const repeated = await browser
      .post(`/api/v1/societies/${societyId}/billing/generate`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send(billingBody);
    expect(repeated.status).toBe(201);
    expect(repeated.body).toMatchObject({ createdCount: 0, skippedCount: 1, period: '2026-12' });

    const generatedInvoice = await prisma.invoice.findFirst({
      where: { societyId, description: billingBody.description, period: billingBody.period },
    });
    const pendingOrder = await prisma.paymentOrder.create({
      data: {
        societyId,
        invoiceId: generatedInvoice.id,
        userId: residentUserId,
        providerOrderId: `order_test${randomUUID().replaceAll('-', '')}`,
        amountPaise: 180000n,
      },
    });
    const blockedManualReceipt = await browser
      .post(`/api/v1/societies/${societyId}/billing/${generatedInvoice.id}/payments`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ amount: '1800.00', method: 'UPI' });
    expect(blockedManualReceipt.status).toBe(409);
    expect(blockedManualReceipt.body.error.code).toBe('PAYMENT_IN_PROGRESS');
    await prisma.paymentOrder.delete({ where: { id: pendingOrder.id } });
  });

  it('manages residents on a society flat and writes audit events without contact details', async () => {
    const browser = request.agent(app);
    const created = await browser
      .post(`/api/v1/societies/${societyId}/residents`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({
        fullName: 'Resident Integration Test',
        flatId: managedFlatId,
        residentType: 'OWNER',
        email: residentEmail,
        phone: '+919876543210',
        emergencyContactName: 'Emergency Contact',
        emergencyContactPhone: '+919123456789',
      });
    expect(created.status).toBe(201);
    const residentId = created.body.resident.id;
    expect(created.body.resident.flat).toMatchObject({
      flatNumber: '101',
      building: { id: managedBuildingId, name: 'Block A' },
    });

    const anotherFlat = await prisma.flat.create({
      data: {
        societyId,
        buildingId: managedBuildingId,
        flatNumber: '102',
        floor: 1,
      },
    });
    const ownInvoice = await prisma.invoice.create({
      data: {
        societyId,
        flatId: managedFlatId,
        description: 'Resident portal test charge',
        period: '2026-11',
        amountPaise: 180000n,
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
      },
    });
    await prisma.invoice.create({
      data: {
        societyId,
        flatId: anotherFlat.id,
        description: 'Other flat test charge',
        period: '2026-11',
        amountPaise: 99000n,
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
      },
    });
    const residentBrowser = request.agent(app);
    const profile = await residentBrowser
      .get(`/api/v1/societies/${societyId}/residents/me`)
      .set('Cookie', residentCookie);
    expect(profile.status).toBe(200);
    expect(profile.body.residents).toHaveLength(1);
    expect(profile.body.residents[0]).toMatchObject({ id: created.body.resident.id });
    const ownBilling = await residentBrowser
      .get(`/api/v1/societies/${societyId}/billing/mine`)
      .set('Cookie', residentCookie);
    expect(ownBilling.status).toBe(200);
    expect(ownBilling.body.invoices).toHaveLength(2);
    expect(ownBilling.body.invoices.map((invoice) => invoice.flatId)).toEqual([
      managedFlatId,
      managedFlatId,
    ]);
    expect(ownBilling.body.invoices.map(({ id }) => id)).toContain(ownInvoice.id);

    const updated = await browser
      .patch(`/api/v1/societies/${societyId}/residents/${residentId}`)
      .set('Cookie', cookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'INACTIVE' });
    expect(updated.status).toBe(200);
    expect(updated.body.resident.status).toBe('INACTIVE');

    const listed = await browser
      .get(`/api/v1/societies/${societyId}/residents?status=INACTIVE`)
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.totalCount).toBe(1);
    expect(listed.body.residents[0].id).toBe(residentId);

    const events = await prisma.auditLog.findMany({
      where: { societyId, resourceId: residentId },
      select: { eventType: true, resourceType: true, resourceId: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      'RESIDENT_CREATED',
      'RESIDENT_DEACTIVATED',
    ]);
    expect(events.every((event) => !('email' in event) && !('phone' in event))).toBe(true);
  });

  it('hides resident contact records from other societies', async () => {
    const response = await request(app)
      .get(`/api/v1/societies/${otherSocietyId}/residents`)
      .set('Cookie', cookie);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SOCIETY_NOT_FOUND');
  });

  it('hides another society’s buildings from the authenticated tenant', async () => {
    const response = await request(app)
      .get(`/api/v1/societies/${otherSocietyId}/buildings/${otherBuildingId}/flats`)
      .set('Cookie', cookie);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SOCIETY_NOT_FOUND');
  });

  it('paginates building and flat lists with stable cursors', async () => {
    await prisma.building.createMany({
      data: [
        { societyId, name: 'Pagination Block One' },
        { societyId, name: 'Pagination Block Two' },
      ],
    });
    await prisma.flat.createMany({
      data: [
        { societyId, buildingId: managedBuildingId, flatNumber: '201', floor: 2 },
        { societyId, buildingId: managedBuildingId, flatNumber: '202', floor: 2 },
      ],
    });
    const browser = request.agent(app);
    const buildingsFirst = await browser
      .get(`/api/v1/societies/${societyId}/buildings?limit=1`)
      .set('Cookie', cookie);
    expect(buildingsFirst.status).toBe(200);
    expect(buildingsFirst.body.buildings).toHaveLength(1);
    expect(buildingsFirst.body.nextCursor).toBeTruthy();
    const buildingsSecond = await browser
      .get(
        `/api/v1/societies/${societyId}/buildings?limit=1&cursor=${buildingsFirst.body.nextCursor}`,
      )
      .set('Cookie', cookie);
    expect(buildingsSecond.status).toBe(200);
    expect(buildingsSecond.body.buildings[0].id).not.toBe(buildingsFirst.body.buildings[0].id);

    const flatsFirst = await browser
      .get(`/api/v1/societies/${societyId}/buildings/${managedBuildingId}/flats?limit=1`)
      .set('Cookie', cookie);
    expect(flatsFirst.status).toBe(200);
    expect(flatsFirst.body.flats).toHaveLength(1);
    expect(flatsFirst.body.nextCursor).toBeTruthy();
    const flatsSecond = await browser
      .get(
        `/api/v1/societies/${societyId}/buildings/${managedBuildingId}/flats?limit=1&cursor=${flatsFirst.body.nextCursor}`,
      )
      .set('Cookie', cookie);
    expect(flatsSecond.status).toBe(200);
    expect(flatsSecond.body.flats[0].id).not.toBe(flatsFirst.body.flats[0].id);
  });

  it('enforces the composite tenant foreign key against cross-society flat relationships', async () => {
    await expect(
      prisma.flat.create({
        data: {
          societyId,
          buildingId: otherBuildingId,
          flatNumber: 'X-1',
          floor: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('enforces the composite tenant foreign key for residents', async () => {
    await expect(
      prisma.resident.create({
        data: {
          societyId,
          flatId: otherFlatId,
          fullName: 'Cross Tenant Test',
          residentType: 'TENANT',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
