import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { healthResponseSchema } from '@societyos/shared';
import { prisma } from './config/database.js';
import { env } from './config/env.js';
import { authRouter } from './modules/auth/router.js';
import { societiesRouter } from './modules/societies/router.js';
import { buildingsRouter } from './modules/buildings/router.js';
import { residentsRouter } from './modules/residents/router.js';
import { billingRouter } from './modules/billing/router.js';
import { expensesRouter } from './modules/expenses/router.js';
import { noticesRouter } from './modules/notices/router.js';
import { complaintsRouter } from './modules/complaints/router.js';
import { facilitiesRouter } from './modules/facilities/router.js';
import { visitorsRouter } from './modules/visitors/router.js';
import { invitationsRouter } from './modules/invitations/router.js';
import { paymentsRouter } from './modules/payments/router.js';
import { platformAdminRouter } from './modules/platform-admin/router.js';
import { platformSubscriptionsRouter } from './modules/subscriptions/platform-router.js';
import { societySubscriptionsRouter } from './modules/subscriptions/router.js';
import { razorpayWebhook } from './modules/payments/webhook.js';
import { razorpaySubscriptionWebhook } from './modules/subscriptions/webhook.js';

export const app = express();
const DATABASE_NOT_READY_CODES = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1003',
  'P1010',
  'P1017',
  'P2021',
  'P2022',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

export function isDatabaseNotReady(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.cause) {
    if (DATABASE_NOT_READY_CODES.has(current.code)) return true;
  }
  return false;
}

app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.post(
  '/api/v1/payments/webhooks/razorpay',
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
  express.raw({ type: 'application/json', limit: '100kb' }),
  razorpayWebhook,
);
app.post(
  '/api/v1/subscriptions/webhooks/razorpay',
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
  express.raw({ type: 'application/json', limit: '100kb' }),
  razorpaySubscriptionWebhook,
);
app.use(express.json({ limit: '100kb' }));
app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/platform-admin', platformAdminRouter);
app.use('/api/v1/platform-admin', platformSubscriptionsRouter);
app.use('/api/v1/societies/:societyId/subscription', societySubscriptionsRouter);
app.use('/api/v1/societies', societiesRouter);
app.use('/api/v1/societies/:societyId/buildings', buildingsRouter);
app.use('/api/v1/societies/:societyId/residents', residentsRouter);
app.use('/api/v1/societies/:societyId/billing', billingRouter);
app.use('/api/v1/societies/:societyId/expenses', expensesRouter);
app.use('/api/v1/societies/:societyId/notices', noticesRouter);
app.use('/api/v1/societies/:societyId/complaints', complaintsRouter);
app.use('/api/v1/societies/:societyId/facilities', facilitiesRouter);
app.use('/api/v1/societies/:societyId/visitors', visitorsRouter);
app.use('/api/v1/invitations', invitationsRouter);
app.use('/api/v1/societies/:societyId/payments', paymentsRouter);
app.use('/api/v1/societies/:societyId/invitations', invitationsRouter);

app.get('/api/v1/health', (_request, response) => {
  const payload = healthResponseSchema.parse({
    status: 'ok',
    service: 'societyos-api',
    timestamp: new Date().toISOString(),
  });
  response.status(200).json(payload);
});

app.get('/api/v1/health/ready', async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.status(200).json({ status: 'ready', database: 'ok' });
  } catch {
    response.status(503).json({ status: 'not_ready' });
  }
});

app.use((_request, response) => {
  response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
});

app.use((error, _request, response, _next) => {
  if (error?.status === 413) {
    return response.status(413).json({
      error: { code: 'FILE_TOO_LARGE', message: 'Documents must be 5 MB or smaller' },
    });
  }
  if (isDatabaseNotReady(error)) {
    return response.status(503).json({
      error: {
        code: 'DATABASE_NOT_READY',
        message:
          'SocietyOS cannot reach its database. Start PostgreSQL and apply pending migrations.',
      },
    });
  }
  console.error('Unhandled request error');
  response
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
});
