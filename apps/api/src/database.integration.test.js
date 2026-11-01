import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma as apiPrisma } from './config/database.js';
import { app } from './app.js';

const databaseTests = describe.skipIf(process.env.RUN_DATABASE_TESTS !== 'true');
let prisma;

databaseTests('PostgreSQL connectivity', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
      }),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await apiPrisma.$disconnect();
  });

  it('runs a query against the configured PostgreSQL database', async () => {
    const result = await prisma.$queryRaw`SELECT 1::int AS connected`;
    expect(result).toEqual([{ connected: 1 }]);

    const readiness = await request(app).get('/api/v1/health/ready');
    expect(readiness.status).toBe(200);
    expect(readiness.body).toEqual({ status: 'ready', database: 'ok' });
  });
});
