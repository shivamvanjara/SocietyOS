import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { prisma } = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    societyMembership: { findFirst: vi.fn() },
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

const token = 'notices-test-session-token';
const userId = '2cc2cafe-6c8f-4a8c-a835-66f31f6c6580';
const societyId = '7ca4a72b-35a8-4b44-a1cc-0efba34a7214';
const cookie = `societyos_session=${token}`;
const csrfToken = createCsrfToken(token);

describe('society notices API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      id: 'fca6c0ab-5df7-4401-bf46-57a73c2f6671',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: userId, email: 'committee@example.test', platformRole: 'USER', status: 'ACTIVE' },
    });
  });

  it('allows committee members to publish notices to their society', async () => {
    const published = {
      id: 'ce413c49-265d-4668-ab36-4b3ef6ac1f70',
      title: 'Water interruption',
      body: 'Water will be unavailable from 2 PM.',
      category: 'Maintenance',
      publishedAt: new Date(),
      expiresAt: null,
    };
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'member-id', role: 'COMMITTEE_MEMBER' }),
      },
      notice: { create: vi.fn().mockResolvedValue(published) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/notices`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ title: published.title, body: published.body, category: published.category });

    expect(response.status).toBe(201);
    expect(response.body.notice.title).toBe('Water interruption');
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        societyId,
        actorUserId: userId,
        eventType: 'NOTICE_PUBLISHED',
      }),
    });
  });

  it('prevents a resident member from publishing notices', async () => {
    const transaction = {
      societyMembership: {
        findFirst: vi.fn().mockResolvedValue({ id: 'member-id', role: 'RESIDENT' }),
      },
      notice: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation((operation) => operation(transaction));
    const response = await request(app)
      .post(`/api/v1/societies/${societyId}/notices`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrfToken)
      .send({ title: 'Water interruption', body: 'Water unavailable.', category: 'Maintenance' });
    expect(response.status).toBe(403);
    expect(transaction.notice.create).not.toHaveBeenCalled();
  });
});
