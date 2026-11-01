import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    societyMembership: { findFirst: vi.fn() },
    complaint: { findMany: vi.fn(), findFirst: vi.fn() },
    complaintAttachment: { findFirst: vi.fn() },
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

const token = 'complaints-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const complaintId = 'ce413c49-265d-4668-ab36-4b3ef6ac1f70';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

describe('society complaints API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'resident@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
  });

  it('limits a resident complaint feed to that member’s own records', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'member-id', role: 'RESIDENT' });
    prisma.complaint.findMany.mockResolvedValue([]);
    const response = await request(app)
      .get(`/api/v1/societies/${societyId}/complaints`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(prisma.complaint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { societyId, submittedById: userId },
      }),
    );
  });

  it('rejects status jumps that skip the complaint workflow', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'committee-id', role: 'COMMITTEE_MEMBER' }),
      },
      complaint: {
        findFirst: vi.fn().mockResolvedValue({ id: complaintId, status: 'SUBMITTED' }),
        updateMany: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .patch(`/api/v1/societies/${societyId}/complaints/${complaintId}`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ status: 'RESOLVED', resolution: 'Repaired' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(transaction.complaint.updateMany).not.toHaveBeenCalled();
  });

  it('stores a signature-checked complaint photo within its society', async () => {
    const attachment = {
      id: '1cc8a1d3-1df9-4b12-a37e-00aa734a80ee',
      originalName: 'leak.jpg',
      mimeType: 'image/jpeg',
      byteSize: 5,
      createdAt: new Date('2026-10-31T00:00:00.000Z'),
    };
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'member-id', role: 'RESIDENT' }),
      },
      $queryRaw: vi.fn(),
      complaint: { findFirst: vi.fn().mockResolvedValue({ id: complaintId }) },
      complaintAttachment: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue(attachment),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/complaints/${complaintId}/attachments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .set('X-File-Name', 'leak.jpg')
      .set('Content-Type', 'image/jpeg')
      .send(bytes);

    expect(response.status).toBe(201);
    expect(response.body.attachment).toMatchObject({
      originalName: 'leak.jpg',
      mimeType: 'image/jpeg',
    });
    expect(transaction.complaintAttachment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ societyId, complaintId, uploadedById: userId, bytes }),
      select: expect.any(Object),
    });
  });

  it('rejects complaint image data that does not match its declared type', async () => {
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/complaints/${complaintId}/attachments`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .set('X-File-Name', 'fake.jpg')
      .set('Content-Type', 'image/jpeg')
      .send(Buffer.from('<script>bad</script>'));

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe('FILE_CONTENT_MISMATCH');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not reveal another resident’s complaint attachments', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue({ id: 'member-id', role: 'RESIDENT' });
    prisma.complaint.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .get(
        `/api/v1/societies/${societyId}/complaints/${complaintId}/attachments/1cc8a1d3-1df9-4b12-a37e-00aa734a80ee`,
      )
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
    expect(prisma.complaintAttachment.findFirst).not.toHaveBeenCalled();
  });
});
