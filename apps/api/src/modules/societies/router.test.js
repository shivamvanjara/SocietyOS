import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    society: { update: vi.fn() },
    societyMembership: { findMany: vi.fn(), findFirst: vi.fn() },
    session: { findUnique: vi.fn(), deleteMany: vi.fn() },
    emailVerificationToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../../config/database.js', () => ({ prisma }));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
const [{ app }, { createCsrfToken }] = await Promise.all([
  import('../../app.js'),
  import('../auth/security.js'),
]);

const token = 'society-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const cookie = `societyos_session=${token}`;
const origin = 'http://localhost:5173';
const csrfToken = createCsrfToken(token);

describe('society management API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'admin@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
  });

  it('only lists societies through the signed-in user’s active memberships', async () => {
    prisma.societyMembership.findMany.mockResolvedValue([]);
    const response = await request(app).get('/api/v1/societies').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ societies: [] });
    expect(prisma.societyMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId, active: true, society: { status: 'ACTIVE' } },
      }),
    );
  });

  it('registers an account and society, then sends a one-time email verification link', async () => {
    const transaction = {
      user: {
        create: vi.fn().mockResolvedValue({
          id: userId,
          email: 'new-admin@example.test',
          platformRole: 'USER',
        }),
      },
      society: { create: vi.fn().mockResolvedValue({ id: societyId, name: 'Cedar Court' }) },
      societyMembership: { create: vi.fn().mockResolvedValue({}) },
      emailVerificationToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app).post('/api/v1/auth/register').set('Origin', origin).send({
      email: 'new-admin@example.test',
      password: 'secure-password-123',
      societyName: 'Cedar Court',
    });

    expect(response.status).toBe(201);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body.requiresEmailVerification).toBe(true);
    expect(response.body.previewUrl).toContain('/verify-email?token=');
    expect(transaction.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          email: 'new-admin@example.test',
          passwordHash: expect.stringContaining('$argon2id$'),
          emailVerifiedAt: null,
        },
      }),
    );
    expect(transaction.societyMembership.create).toHaveBeenCalledWith({
      data: { userId, societyId, role: 'SOCIETY_ADMIN' },
    });
    expect(transaction.emailVerificationToken.create).toHaveBeenCalledOnce();
  });

  it('registers invited members directly into the invited society without creating an empty society', async () => {
    const invitationCode = 'A'.repeat(43);
    const transaction = {
      societyInvitation: {
        findFirst: vi.fn().mockResolvedValue({
          id: '8aa6b8b9-d724-40ec-a990-89d11bdd1065',
          societyId,
          role: 'RESIDENT',
          society: { name: 'Cedar Court' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        create: vi
          .fn()
          .mockResolvedValue({ id: userId, email: 'resident@example.test', platformRole: 'USER' }),
      },
      societyMembership: { create: vi.fn().mockResolvedValue({ id: 'membership-id' }) },
      emailVerificationToken: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      society: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app).post('/api/v1/auth/register').set('Origin', origin).send({
      email: 'resident@example.test',
      password: 'secure-password-123',
      inviteCode: invitationCode,
    });

    expect(response.status).toBe(201);
    expect(response.body.requiresEmailVerification).toBe(true);
    expect(response.body.previewUrl).toContain('/verify-email?token=');
    expect(transaction.societyInvitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tokenHash: createHash('sha256').update(invitationCode).digest('hex'),
          email: 'resident@example.test',
        }),
      }),
    );
    expect(transaction.society.create).not.toHaveBeenCalled();
  });

  it('rejects registration passwords shorter than 12 characters', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .set('Origin', origin)
      .send({ email: 'new-admin@example.test', password: 'too-short', societyName: 'Cedar Court' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns a clear service-unavailable response when PostgreSQL cannot be reached', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P1001' });
    const response = await request(app).post('/api/v1/auth/register').set('Origin', origin).send({
      email: 'new-admin@example.test',
      password: 'secure-password-123',
      societyName: 'Cedar Court',
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DATABASE_NOT_READY');
    expect(response.body.error.message).toContain('Start PostgreSQL');
  });

  it('requires CSRF verification before creating a society', async () => {
    const response = await request(app)
      .post('/api/v1/societies')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ name: 'Lakeview Homes' });

    expect(response.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates the society and its administrator membership in one transaction', async () => {
    const transaction = {
      society: {
        create: vi
          .fn()
          .mockResolvedValue({ id: societyId, name: 'Lakeview Homes', slug: 'lakeview-homes' }),
      },
      societyMembership: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));

    const response = await request(app)
      .post('/api/v1/societies')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Lakeview Homes', city: 'Pune', addressLine1: '', postalCode: '' });

    expect(response.status).toBe(201);
    expect(transaction.society.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: 'Lakeview Homes',
          city: 'Pune',
          addressLine1: null,
          postalCode: null,
          slug: 'lakeview-homes',
        },
      }),
    );
    expect(transaction.societyMembership.create).toHaveBeenCalledWith({
      data: { societyId, userId, role: 'SOCIETY_ADMIN' },
    });
    expect(response.body.role).toBe('SOCIETY_ADMIN');
  });

  it('does not reveal a society outside the signed-in user’s membership', async () => {
    prisma.societyMembership.findFirst.mockResolvedValue(null);
    const response = await request(app).get(`/api/v1/societies/${societyId}`).set('Cookie', cookie);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SOCIETY_NOT_FOUND');
    expect(prisma.societyMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { societyId, userId, active: true, society: { status: 'ACTIVE' } },
      }),
    );
  });

  it('blocks profile changes by non-administrator members', async () => {
    prisma.$transaction.mockImplementation((operation) =>
      operation({
        societyMembership: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ role: 'ACCOUNTANT', society: { status: 'ACTIVE' } }),
        },
        society: { update: vi.fn() },
      }),
    );
    const response = await request(app)
      .patch(`/api/v1/societies/${societyId}`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ city: 'Mumbai' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects malformed PIN codes at the API boundary', async () => {
    const response = await request(app)
      .post('/api/v1/societies')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Lakeview Homes', postalCode: '12AB' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
