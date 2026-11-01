import { describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-characters';
const { app, isDatabaseNotReady } = await import('./app.js');

describe('database availability errors', () => {
  it('recognizes Prisma and nested PostgreSQL connection errors', () => {
    expect(isDatabaseNotReady({ code: 'P1001' })).toBe(true);
    expect(isDatabaseNotReady({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
    expect(isDatabaseNotReady({ code: 'P2002' })).toBe(false);
  });
});

describe('health endpoint', () => {
  it('returns a minimal service health response', async () => {
    const response = await request(app).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'societyos-api' });
  });

  it('uses a consistent not found response', async () => {
    const response = await request(app).get('/api/v1/unknown');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
  });
});
