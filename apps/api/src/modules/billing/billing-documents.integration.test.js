import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { prisma as apiPrisma } from '../../config/database.js';
import { app } from '../../app.js';
import { createCsrfToken, hashSessionToken } from '../auth/security.js';
import { decryptRazorpaySecret } from '../payments/secrets.js';

const integration = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 }),
});
const id = randomUUID();
const accountantToken = `billing-document-accountant-${id}`;
const residentToken = `billing-document-resident-${id}`;
const unrelatedToken = `billing-document-unrelated-${id}`;
let accountant;
let admin;
let resident;
let unrelated;
let society;
let flat;
let invoice;
let attachmentId;

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

integration('invoice document upload and resident access with PostgreSQL', () => {
  beforeAll(async () => {
    await prisma.$connect();
    accountant = await prisma.user.create({
      data: {
        email: `bill-doc-accountant-${id}@example.test`,
        passwordHash: 'integration-test-hash',
      },
    });
    admin = await prisma.user.create({
      data: { email: `bill-doc-admin-${id}@example.test`, passwordHash: 'integration-test-hash' },
    });
    resident = await prisma.user.create({
      data: {
        email: `bill-doc-resident-${id}@example.test`,
        passwordHash: 'integration-test-hash',
      },
    });
    unrelated = await prisma.user.create({
      data: {
        email: `bill-doc-unrelated-${id}@example.test`,
        passwordHash: 'integration-test-hash',
      },
    });
    society = await prisma.society.create({
      data: { name: 'Invoice Document Integration Society', slug: `bill-doc-${id.slice(0, 16)}` },
    });
    await prisma.societyMembership.createMany({
      data: [
        { societyId: society.id, userId: admin.id, role: 'SOCIETY_ADMIN' },
        { societyId: society.id, userId: accountant.id, role: 'ACCOUNTANT' },
        { societyId: society.id, userId: resident.id, role: 'RESIDENT' },
        { societyId: society.id, userId: unrelated.id, role: 'RESIDENT' },
      ],
    });
    await prisma.session.createMany({
      data: [
        [admin.id, `billing-document-admin-${id}`],
        [accountant.id, accountantToken],
        [resident.id, residentToken],
        [unrelated.id, unrelatedToken],
      ].map(([userId, token]) => ({
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })),
    });
    const building = await prisma.building.create({
      data: { societyId: society.id, name: 'Document Block' },
    });
    flat = await prisma.flat.create({
      data: {
        societyId: society.id,
        buildingId: building.id,
        flatNumber: 'D-101',
        floor: 1,
      },
    });
    await prisma.resident.create({
      data: {
        societyId: society.id,
        flatId: flat.id,
        fullName: 'Bill Document Resident',
        email: resident.email,
        residentType: 'OWNER',
      },
    });
    invoice = await prisma.invoice.create({
      data: {
        societyId: society.id,
        flatId: flat.id,
        description: 'November maintenance',
        period: '2026-11',
        amountPaise: 450000n,
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    if (society) {
      await prisma.paymentOrder.deleteMany({ where: { societyId: society.id } });
      await prisma.societyRazorpayAccount.deleteMany({ where: { societyId: society.id } });
      if (invoice) {
        await prisma.invoiceAttachment.deleteMany({ where: { invoiceId: invoice.id } });
        await prisma.payment.deleteMany({ where: { invoiceId: invoice.id } });
        await prisma.auditLog.deleteMany({
          where: { societyId: society.id, resourceId: invoice.id },
        });
        await prisma.invoice.delete({ where: { id: invoice.id } });
      }
      await prisma.resident.deleteMany({ where: { societyId: society.id } });
      await prisma.flat.deleteMany({ where: { societyId: society.id } });
      await prisma.building.deleteMany({ where: { societyId: society.id } });
      await prisma.auditLog.deleteMany({ where: { societyId: society.id } });
      await prisma.societyMembership.deleteMany({ where: { societyId: society.id } });
      await prisma.society.delete({ where: { id: society.id } });
    }
    const userIds = [admin?.id, accountant?.id, resident?.id, unrelated?.id].filter(Boolean);
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    await apiPrisma.$disconnect();
  });

  it('stores the accountant upload and shares it only with residents linked to that flat', async () => {
    const adminToken = `billing-document-admin-${id}`;
    const savedInstructions = await request(app)
      .put(`/api/v1/societies/${society.id}/billing/payment-instructions`)
      .set('Cookie', `societyos_session=${adminToken}`)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', createCsrfToken(adminToken))
      .send({
        bankAccountName: 'Invoice Document Integration Society',
        bankAccountNumber: '001234567890',
        bankName: 'Example Bank',
        bankIfscCode: 'EXAM0001234',
        upiId: 'documents@example',
        instructions: 'Include your flat number in the transfer reference.',
      });
    expect(savedInstructions.status, JSON.stringify(savedInstructions.body)).toBe(200);

    const visibleInstructions = await request(app)
      .get(`/api/v1/societies/${society.id}/billing/payment-instructions`)
      .set('Cookie', `societyos_session=${residentToken}`);
    expect(visibleInstructions.status).toBe(200);
    expect(visibleInstructions.body.paymentInstructions).toMatchObject({
      bankAccountNumber: '001234567890',
      bankIfscCode: 'EXAM0001234',
      upiId: 'documents@example',
    });

    const firstKey = `rzp_test_${id.replaceAll('-', '')}`;
    const firstSecret = `merchant-secret-${id}`;
    const firstWebhookSecret = `webhook-secret-${id}`;
    const configuredAccount = await request(app)
      .put(`/api/v1/societies/${society.id}/billing/razorpay-account`)
      .set('Cookie', `societyos_session=${adminToken}`)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', createCsrfToken(adminToken))
      .send({
        enabled: true,
        keyId: firstKey,
        keySecret: firstSecret,
        webhookSecret: firstWebhookSecret,
      });
    expect(configuredAccount.status, JSON.stringify(configuredAccount.body)).toBe(200);
    expect(JSON.stringify(configuredAccount.body)).not.toContain(firstSecret);
    expect(JSON.stringify(configuredAccount.body)).not.toContain(firstWebhookSecret);
    const firstAccount = await prisma.societyRazorpayAccount.findFirst({
      where: { societyId: society.id, active: true },
    });
    expect(decryptRazorpaySecret(firstAccount.apiSecretEncrypted)).toBe(firstSecret);
    expect(decryptRazorpaySecret(firstAccount.webhookSecretEncrypted)).toBe(firstWebhookSecret);

    const providerOrderId = `order_${id.replaceAll('-', '')}`;
    const paymentOrder = await prisma.paymentOrder.create({
      data: {
        societyId: society.id,
        razorpayAccountId: firstAccount.id,
        invoiceId: invoice.id,
        userId: resident.id,
        providerOrderId,
        amountPaise: 450000n,
      },
    });
    const secondKey = `rzp_test_rotated${id.replaceAll('-', '')}`;
    const rotatedAccount = await request(app)
      .put(`/api/v1/societies/${society.id}/billing/razorpay-account`)
      .set('Cookie', `societyos_session=${adminToken}`)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', createCsrfToken(adminToken))
      .send({
        enabled: true,
        keyId: secondKey,
        keySecret: `rotated-merchant-${id}`,
        webhookSecret: `rotated-webhook-${id}`,
      });
    expect(rotatedAccount.status).toBe(200);
    const savedOrder = await prisma.paymentOrder.findUnique({ where: { id: paymentOrder.id } });
    expect(savedOrder.razorpayAccountId).toBe(firstAccount.id);
    expect(
      await prisma.societyRazorpayAccount.findFirst({
        where: { societyId: society.id, active: true },
        select: { id: true, keyId: true },
      }),
    ).toMatchObject({ keyId: secondKey });

    const paymentStatus = await request(app)
      .get(`/api/v1/societies/${society.id}/payments/status`)
      .set('Cookie', `societyos_session=${residentToken}`);
    expect(paymentStatus.status).toBe(200);
    expect(paymentStatus.body.onlinePaymentsEnabled).toBe(true);

    const disabled = await request(app)
      .put(`/api/v1/societies/${society.id}/billing/razorpay-account`)
      .set('Cookie', `societyos_session=${adminToken}`)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', createCsrfToken(adminToken))
      .send({ enabled: false });
    expect(disabled.status).toBe(200);
    const disabledPaymentStatus = await request(app)
      .get(`/api/v1/societies/${society.id}/payments/status`)
      .set('Cookie', `societyos_session=${residentToken}`);
    expect(disabledPaymentStatus.body.onlinePaymentsEnabled).toBe(false);

    const bytes = Buffer.from('%PDF-1.7\nNovember maintenance bill\n%%EOF');
    const uploaded = await request(app)
      .post(`/api/v1/societies/${society.id}/billing/${invoice.id}/attachments`)
      .set('Cookie', `societyos_session=${accountantToken}`)
      .set('Origin', env.WEB_ORIGIN)
      .set('X-CSRF-Token', createCsrfToken(accountantToken))
      .set('X-File-Name', 'November-maintenance-bill.pdf')
      .set('Content-Type', 'application/pdf')
      .send(bytes);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body.attachment).toMatchObject({
      originalName: 'November-maintenance-bill.pdf',
      mimeType: 'application/pdf',
      byteSize: bytes.length,
    });
    attachmentId = uploaded.body.attachment.id;
    const stored = await prisma.invoiceAttachment.findUnique({ where: { id: attachmentId } });
    expect(Buffer.from(stored.bytes)).toEqual(bytes);

    const mine = await request(app)
      .get(`/api/v1/societies/${society.id}/billing/mine`)
      .set('Cookie', `societyos_session=${residentToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.invoices[0].attachments).toEqual([
      expect.objectContaining({ id: attachmentId, originalName: 'November-maintenance-bill.pdf' }),
    ]);

    const downloaded = await request(app)
      .get(`/api/v1/societies/${society.id}/billing/${invoice.id}/attachments/${attachmentId}`)
      .set('Cookie', `societyos_session=${residentToken}`)
      .buffer(true)
      .parse(binaryParser);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(downloaded.body)).toEqual(bytes);

    const unrelatedDownload = await request(app)
      .get(`/api/v1/societies/${society.id}/billing/${invoice.id}/attachments/${attachmentId}`)
      .set('Cookie', `societyos_session=${unrelatedToken}`);
    expect(unrelatedDownload.status).toBe(404);
    expect(unrelatedDownload.body.error.code).toBe('DOCUMENT_NOT_FOUND');

    const payment = await prisma.payment.create({
      data: {
        societyId: society.id,
        invoiceId: invoice.id,
        amountPaise: 125000n,
        method: 'BANK_TRANSFER',
        reference: 'UTR-DOCS-2026',
        receivedAt: new Date('2026-11-01T10:30:00.000Z'),
      },
    });
    const receipt = await request(app)
      .get(`/api/v1/societies/${society.id}/billing/payments/${payment.id}/receipt`)
      .set('Cookie', `societyos_session=${residentToken}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.receipt).toMatchObject({
      societyName: 'Invoice Document Integration Society',
      home: 'Document Block · D-101',
      charge: 'November maintenance',
      period: '2026-11',
      amountPaise: '125000',
      method: 'BANK_TRANSFER',
      reference: 'UTR-DOCS-2026',
    });
    expect(receipt.body.receipt.receiptNumber).toMatch(/^SO-[A-F0-9-]{36}$/);

    const unrelatedReceipt = await request(app)
      .get(`/api/v1/societies/${society.id}/billing/payments/${payment.id}/receipt`)
      .set('Cookie', `societyos_session=${unrelatedToken}`);
    expect(unrelatedReceipt.status).toBe(404);
  });
});
