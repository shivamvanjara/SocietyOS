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
const adminEmail = `expense-admin-${id}@example.test`;
const accountantEmail = `expense-accountant-${id}@example.test`;
const adminToken = `expense-admin-token-${id}`;
const accountantToken = `expense-accountant-token-${id}`;
let society;
let admin;
let accountant;
let expenseId;
let attachmentId;
let complaintId;
let complaintAttachmentId;

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

integration('expense approval and bill documents with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    [admin, accountant] = await Promise.all([
      prisma.user.create({ data: { email: adminEmail, passwordHash: 'integration-test-hash' } }),
      prisma.user.create({
        data: { email: accountantEmail, passwordHash: 'integration-test-hash' },
      }),
    ]);
    society = await prisma.society.create({
      data: { name: 'Expense Integration Society', slug: `expense-${id}` },
    });
    await prisma.societyMembership.createMany({
      data: [
        { societyId: society.id, userId: admin.id, role: 'SOCIETY_ADMIN' },
        { societyId: society.id, userId: accountant.id, role: 'ACCOUNTANT' },
      ],
    });
    await prisma.session.createMany({
      data: [
        {
          userId: admin.id,
          tokenHash: hashSessionToken(adminToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          userId: accountant.id,
          tokenHash: hashSessionToken(accountantToken),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });
  });

  afterAll(async () => {
    if (society) {
      await prisma.complaintAttachment.deleteMany({ where: { societyId: society.id } });
      await prisma.complaint.deleteMany({ where: { societyId: society.id } });
      await prisma.expenseAttachment.deleteMany({ where: { societyId: society.id } });
      await prisma.expense.deleteMany({ where: { societyId: society.id } });
      await prisma.auditLog.deleteMany({ where: { societyId: society.id } });
      await prisma.societyMembership.deleteMany({ where: { societyId: society.id } });
      await prisma.society.deleteMany({ where: { id: society.id } });
    }
    if (admin || accountant) {
      await prisma.session.deleteMany({
        where: { userId: { in: [admin?.id, accountant?.id].filter(Boolean) } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [admin?.id, accountant?.id].filter(Boolean) } },
      });
    }
    await prisma.$disconnect();
    await appPrisma.$disconnect();
  });

  it('submits, documents, reviews, and reports an expense end to end', async () => {
    const accountantCookie = `${SESSION_COOKIE}=${accountantToken}`;
    const adminCookie = `${SESSION_COOKIE}=${adminToken}`;
    const accountantCsrf = createCsrfToken(accountantToken);
    const adminCsrf = createCsrfToken(adminToken);
    const root = `/api/v1/societies/${society.id}/expenses`;

    const created = await request(app)
      .post(root)
      .set('Cookie', accountantCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', accountantCsrf)
      .send({
        category: 'Repairs',
        description: 'Lift control panel repair',
        amount: '1234.50',
        spentAt: '2026-10-29',
        vendor: 'Lift Services',
      });
    expect(created.status).toBe(201);
    expect(created.body.expense.status).toBe('SUBMITTED');
    expenseId = created.body.expense.id;

    const document = Buffer.from('%PDF-1.7\nInvoice 1234.50\n%%EOF');
    const uploaded = await request(app)
      .post(`${root}/${expenseId}/attachments`)
      .set('Cookie', accountantCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', accountantCsrf)
      .set('X-File-Name', 'lift-invoice.pdf')
      .set('Content-Type', 'application/pdf')
      .send(document);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.attachment).toMatchObject({
      originalName: 'lift-invoice.pdf',
      mimeType: 'application/pdf',
      byteSize: document.length,
    });
    attachmentId = uploaded.body.attachment.id;
    const storedFile = await prisma.expenseAttachment.findUnique({ where: { id: attachmentId } });
    expect(Buffer.from(storedFile.bytes)).toEqual(document);

    const downloaded = await request(app)
      .get(`${root}/${expenseId}/attachments/${attachmentId}`)
      .set('Cookie', accountantCookie)
      .buffer(true)
      .parse(binaryParser);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-disposition']).toContain('lift-invoice.pdf');
    expect(Buffer.from(downloaded.body)).toEqual(document);

    const approvedBySubmitter = await request(app)
      .post(`${root}/${expenseId}/approve`)
      .set('Cookie', accountantCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', accountantCsrf)
      .send({});
    expect(approvedBySubmitter.status).toBe(404);

    const approved = await request(app)
      .post(`${root}/${expenseId}/approve`)
      .set('Cookie', adminCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', adminCsrf)
      .send({});
    expect(approved.status).toBe(200);
    expect(await prisma.expense.findUnique({ where: { id: expenseId } })).toMatchObject({
      status: 'APPROVED',
      reviewedById: admin.id,
      createdById: accountant.id,
    });

    const listed = await request(app).get(root).set('Cookie', adminCookie);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1234.5);
    expect(listed.body.expenses[0].attachments).toEqual([
      expect.objectContaining({ id: attachmentId, originalName: 'lift-invoice.pdf' }),
    ]);

    const complaintRoot = `/api/v1/societies/${society.id}/complaints`;
    const submittedComplaint = await request(app)
      .post(complaintRoot)
      .set('Cookie', accountantCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', accountantCsrf)
      .send({
        category: 'Maintenance',
        title: 'Water leak in the basement',
        description: 'Water is pooling beside the pump room.',
        priority: 'HIGH',
      });
    expect(submittedComplaint.status).toBe(201);
    complaintId = submittedComplaint.body.complaint.id;

    const photo = Buffer.from([0xff, 0xd8, 0xff, 0x10, 0x20, 0x30]);
    const uploadedPhoto = await request(app)
      .post(`${complaintRoot}/${complaintId}/attachments`)
      .set('Cookie', accountantCookie)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', accountantCsrf)
      .set('X-File-Name', 'basement-leak.jpg')
      .set('Content-Type', 'image/jpeg')
      .send(photo);
    expect(uploadedPhoto.status).toBe(201);
    complaintAttachmentId = uploadedPhoto.body.attachment.id;
    const storedPhoto = await prisma.complaintAttachment.findUnique({
      where: { id: complaintAttachmentId },
    });
    expect(Buffer.from(storedPhoto.bytes)).toEqual(photo);

    const complaintList = await request(app).get(complaintRoot).set('Cookie', accountantCookie);
    expect(complaintList.status).toBe(200);
    expect(complaintList.body.complaints[0].attachments).toEqual([
      expect.objectContaining({ id: complaintAttachmentId, originalName: 'basement-leak.jpg' }),
    ]);
    const downloadedPhoto = await request(app)
      .get(`${complaintRoot}/${complaintId}/attachments/${complaintAttachmentId}`)
      .set('Cookie', adminCookie)
      .buffer(true)
      .parse(binaryParser);
    expect(downloadedPhoto.status).toBe(200);
    expect(downloadedPhoto.headers['content-disposition']).toContain('basement-leak.jpg');
    expect(Buffer.from(downloadedPhoto.body)).toEqual(photo);
  });
});
