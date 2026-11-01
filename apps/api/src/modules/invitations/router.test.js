import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma, sendSocietyInvitationEmail } = vi.hoisted(() => ({
  sendSocietyInvitationEmail: vi.fn().mockResolvedValue({}),
  prisma: {
    $transaction: vi.fn(),
    societyMembership: { findFirst: vi.fn(), findMany: vi.fn() },
    session: { findUnique: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock('../../config/database.js', () => ({ prisma }));
vi.mock('../auth/email.js', () => ({
  sendSocietyInvitationEmail,
  sendEmailVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
const [{ app }, { createCsrfToken }] = await Promise.all([
  import('../../app.js'),
  import('../auth/security.js'),
]);

const token = 'invitations-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

describe('society invitations API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'admin@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
  });

  it('returns the one-time invite code while persisting only its hash', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'admin-membership', role: 'SOCIETY_ADMIN' }),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      society: { findUnique: vi.fn().mockResolvedValue({ name: 'Cedar Court' }) },
      societyInvitation: {
        create: vi.fn().mockResolvedValue({
          id: 'invite-id',
          email: 'resident@example.test',
          role: 'RESIDENT',
          expiresAt: new Date(),
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/invitations`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ email: 'resident@example.test', role: 'RESIDENT' });

    expect(response.status).toBe(201);
    expect(response.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.body.emailSent).toBe(true);
    expect(sendSocietyInvitationEmail).toHaveBeenCalledWith(
      'resident@example.test',
      `http://localhost:5173/#invite=${response.body.code}`,
      expect.objectContaining({ societyName: 'Cedar Court', role: 'RESIDENT' }),
    );
    expect(transaction.societyInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          societyId,
          email: 'resident@example.test',
          role: 'RESIDENT',
          tokenHash: createHash('sha256').update(response.body.code).digest('hex'),
        }),
      }),
    );
    expect(JSON.stringify(transaction.societyInvitation.create.mock.calls)).not.toContain(
      response.body.code,
    );
  });

  it('accepts a single-use code only for the authenticated invitee email', async () => {
    const code = 'B'.repeat(43);
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'resident@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
    const transaction = {
      societyInvitation: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'invite-id',
          societyId,
          role: 'RESIDENT',
          email: 'resident@example.test',
          society: { name: 'Cedar Court' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      societyMembership: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'membership-id', societyId, role: 'RESIDENT' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post('/api/v1/invitations/accept')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ code });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      societyName: 'Cedar Court',
      membership: { societyId, role: 'RESIDENT' },
    });
    expect(transaction.societyInvitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: 'resident@example.test',
          tokenHash: createHash('sha256').update(code).digest('hex'),
        }),
      }),
    );
  });
});
