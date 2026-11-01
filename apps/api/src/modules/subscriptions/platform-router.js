import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';

export const platformSubscriptionsRouter = express.Router();
const uuid = z.uuid();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED']).optional(),
});
const money = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  });
const planFields = {
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).nullable().optional(),
  billingInterval: z.enum(['MONTHLY', 'ANNUAL']),
  price: money,
  maxBuildings: z.number().int().min(1).max(100_000).nullable().optional(),
  maxFlats: z.number().int().min(1).max(1_000_000).nullable().optional(),
  active: z.boolean().optional(),
};
const planCreateSchema = z.object(planFields).strict();
const planUpdateSchema = z.object(planFields).partial().strict();
const createSubscriptionSchema = z
  .object({
    planId: uuid,
    status: z.enum(['TRIAL', 'ACTIVE']).default('ACTIVE'),
    endsAt: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .refine((value) => !value.endsAt || Date.parse(value.endsAt) > Date.now(), {
    path: ['endsAt'],
    message: 'End date must be in the future',
  });
const subscriptionStatusSchema = z
  .object({ status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED']) })
  .strict();
const activeStatuses = ['PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE'];
const terminalStatuses = ['CANCELED', 'EXPIRED'];

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function requireSuperAdmin(req, res, next) {
  if (req.auth.user.platformRole !== 'SUPER_ADMIN')
    return fail(res, 403, 'FORBIDDEN', 'Platform administrator access is required');
  next();
}

function moneyString(paise) {
  return `${paise / 100n}.${String(paise % 100n).padStart(2, '0')}`;
}

function serializePlan(plan) {
  return { ...plan, price: moneyString(plan.pricePaise), pricePaise: undefined };
}

function serializeSubscription(subscription) {
  return {
    ...subscription,
    price: moneyString(subscription.pricePaise),
    pricePaise: undefined,
  };
}

platformSubscriptionsRouter.use(requireAuthenticated, requireSuperAdmin);

platformSubscriptionsRouter.get('/subscription-plans', async (req, res, next) => {
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid plan query');
  try {
    const rows = await prisma.subscriptionPlan.findMany({
      where: parsed.data.search
        ? { name: { contains: parsed.data.search, mode: 'insensitive' } }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > parsed.data.limit;
    if (hasMore) rows.pop();
    return res.json({
      subscriptionPlans: rows.map(serializePlan),
      nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    next(error);
  }
});

platformSubscriptionsRouter.post('/subscription-plans', requireCsrf, async (req, res, next) => {
  const parsed = planCreateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Enter a valid subscription plan');
  try {
    const plan = await prisma.$transaction(async (tx) => {
      const created = await tx.subscriptionPlan.create({
        data: {
          name: parsed.data.name,
          description: parsed.data.description,
          billingInterval: parsed.data.billingInterval,
          pricePaise: parsed.data.price,
          maxBuildings: parsed.data.maxBuildings,
          maxFlats: parsed.data.maxFlats,
          active: parsed.data.active ?? true,
        },
      });
      await tx.platformAuditLog.create({
        data: {
          actorUserId: req.auth.user.id,
          eventType: 'SUBSCRIPTION_PLAN_CREATED',
          resourceType: 'SUBSCRIPTION_PLAN',
          resourceId: created.id,
        },
      });
      return created;
    });
    return res.status(201).json({ subscriptionPlan: serializePlan(plan) });
  } catch (error) {
    if (error?.code === 'P2002')
      return fail(
        res,
        409,
        'PLAN_ALREADY_EXISTS',
        'That plan name and billing interval already exist',
      );
    next(error);
  }
});

platformSubscriptionsRouter.patch(
  '/subscription-plans/:planId',
  requireCsrf,
  async (req, res, next) => {
    const parsedId = uuid.safeParse(req.params.planId);
    const parsed = planUpdateSchema.safeParse(req.body);
    if (!parsedId.success || !parsed.success || !Object.keys(parsed.data).length)
      return fail(res, 400, 'VALIDATION_ERROR', 'Enter valid plan changes');
    try {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.subscriptionPlan.findUnique({
          where: { id: parsedId.data },
          select: { id: true },
        });
        if (!existing) return null;
        const { price, ...fields } = parsed.data;
        const updated = await tx.subscriptionPlan.update({
          where: { id: existing.id },
          data: { ...fields, ...(price !== undefined ? { pricePaise: price } : {}) },
        });
        await tx.platformAuditLog.create({
          data: {
            actorUserId: req.auth.user.id,
            eventType: 'SUBSCRIPTION_PLAN_UPDATED',
            resourceType: 'SUBSCRIPTION_PLAN',
            resourceId: updated.id,
          },
        });
        return updated;
      });
      if (!result) return fail(res, 404, 'PLAN_NOT_FOUND', 'Subscription plan not found');
      return res.json({ subscriptionPlan: serializePlan(result) });
    } catch (error) {
      if (error?.code === 'P2002')
        return fail(
          res,
          409,
          'PLAN_ALREADY_EXISTS',
          'That plan name and billing interval already exist',
        );
      next(error);
    }
  },
);

platformSubscriptionsRouter.get('/subscriptions', async (req, res, next) => {
  const parsed = pageSchema.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid subscription query');
  try {
    const rows = await prisma.societySubscription.findMany({
      where: {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.search
          ? { society: { name: { contains: parsed.data.search, mode: 'insensitive' } } }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      include: {
        society: { select: { id: true, name: true, status: true } },
        plan: { select: { id: true, name: true, active: true } },
        createdBy: { select: { id: true, email: true } },
      },
    });
    const hasMore = rows.length > parsed.data.limit;
    if (hasMore) rows.pop();
    return res.json({
      subscriptions: rows.map(serializeSubscription),
      nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
    });
  } catch (error) {
    next(error);
  }
});

platformSubscriptionsRouter.post(
  '/societies/:societyId/subscriptions',
  requireCsrf,
  async (req, res, next) => {
    const societyId = uuid.safeParse(req.params.societyId);
    const parsed = createSubscriptionSchema.safeParse(req.body);
    if (!societyId.success || !parsed.success)
      return fail(res, 400, 'VALIDATION_ERROR', 'Enter a valid society subscription');
    try {
      const result = await prisma.$transaction(async (tx) => {
        const [society] =
          await tx.$queryRaw`SELECT id, status FROM societies WHERE id = ${societyId.data}::uuid FOR UPDATE`;
        if (!society) return { kind: 'society_missing' };
        if (society.status !== 'ACTIVE') return { kind: 'society_inactive' };
        const current = await tx.societySubscription.findFirst({
          where: { societyId: societyId.data, status: { in: activeStatuses } },
          select: { id: true },
        });
        if (current) return { kind: 'already_subscribed' };
        const plan = await tx.subscriptionPlan.findFirst({
          where: { id: parsed.data.planId, active: true },
        });
        if (!plan) return { kind: 'plan_missing' };
        const subscription = await tx.societySubscription.create({
          data: {
            societyId: societyId.data,
            planId: plan.id,
            createdById: req.auth.user.id,
            status: parsed.data.status,
            billingInterval: plan.billingInterval,
            pricePaise: plan.pricePaise,
            maxBuildings: plan.maxBuildings,
            maxFlats: plan.maxFlats,
            startsAt: new Date(),
            endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : undefined,
          },
          include: {
            society: { select: { id: true, name: true, status: true } },
            plan: { select: { id: true, name: true, active: true } },
            createdBy: { select: { id: true, email: true } },
          },
        });
        await tx.platformAuditLog.create({
          data: {
            actorUserId: req.auth.user.id,
            eventType: `SUBSCRIPTION_${parsed.data.status}`,
            resourceType: 'SOCIETY_SUBSCRIPTION',
            resourceId: subscription.id,
          },
        });
        return { kind: 'created', subscription };
      });
      if (result.kind === 'society_missing')
        return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (result.kind === 'society_inactive')
        return fail(
          res,
          409,
          'SOCIETY_INACTIVE',
          'Reactivate the society before assigning a subscription',
        );
      if (result.kind === 'already_subscribed')
        return fail(
          res,
          409,
          'SUBSCRIPTION_ALREADY_ACTIVE',
          'This society already has an active subscription',
        );
      if (result.kind === 'plan_missing')
        return fail(res, 404, 'PLAN_NOT_FOUND', 'An active subscription plan was not found');
      return res.status(201).json({ subscription: serializeSubscription(result.subscription) });
    } catch (error) {
      next(error);
    }
  },
);

platformSubscriptionsRouter.patch(
  '/subscriptions/:subscriptionId/status',
  requireCsrf,
  async (req, res, next) => {
    const subscriptionId = uuid.safeParse(req.params.subscriptionId);
    const parsed = subscriptionStatusSchema.safeParse(req.body);
    if (!subscriptionId.success || !parsed.success)
      return fail(res, 400, 'VALIDATION_ERROR', 'Choose a valid subscription status');
    try {
      const result = await prisma.$transaction(async (tx) => {
        const initial = await tx.societySubscription.findUnique({
          where: { id: subscriptionId.data },
          select: { societyId: true },
        });
        if (!initial) return { kind: 'missing' };
        await tx.$queryRaw`SELECT id FROM societies WHERE id = ${initial.societyId}::uuid FOR UPDATE`;
        const existing = await tx.societySubscription.findUnique({
          where: { id: subscriptionId.data },
          select: { id: true, societyId: true, status: true },
        });
        if (!existing) return { kind: 'missing' };
        if (existing.status === parsed.data.status) return { kind: 'unchanged' };
        const allowed = {
          PENDING: ['CANCELED'],
          TRIAL: ['ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'],
          ACTIVE: ['PAST_DUE', 'CANCELED', 'EXPIRED'],
          PAST_DUE: ['ACTIVE', 'CANCELED', 'EXPIRED'],
          CANCELED: [],
          EXPIRED: [],
        };
        if (!allowed[existing.status].includes(parsed.data.status))
          return { kind: 'invalid_transition' };
        if (activeStatuses.includes(parsed.data.status)) {
          const conflicting = await tx.societySubscription.findFirst({
            where: {
              societyId: existing.societyId,
              id: { not: existing.id },
              status: { in: activeStatuses },
            },
            select: { id: true },
          });
          if (conflicting) return { kind: 'already_subscribed' };
        }
        const terminal = terminalStatuses.includes(parsed.data.status);
        const updated = await tx.societySubscription.update({
          where: { id: existing.id },
          data: {
            status: parsed.data.status,
            ...(parsed.data.status === 'CANCELED' ? { canceledAt: new Date() } : {}),
            ...(terminal ? { endsAt: new Date() } : {}),
          },
          include: {
            society: { select: { id: true, name: true, status: true } },
            plan: { select: { id: true, name: true, active: true } },
            createdBy: { select: { id: true, email: true } },
          },
        });
        await tx.platformAuditLog.create({
          data: {
            actorUserId: req.auth.user.id,
            eventType: `SUBSCRIPTION_${parsed.data.status}`,
            resourceType: 'SOCIETY_SUBSCRIPTION',
            resourceId: updated.id,
          },
        });
        return { kind: 'updated', subscription: updated };
      });
      if (result.kind === 'missing')
        return fail(res, 404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
      if (result.kind === 'invalid_transition')
        return fail(
          res,
          409,
          'INVALID_SUBSCRIPTION_TRANSITION',
          'This subscription status cannot be changed that way',
        );
      if (result.kind === 'already_subscribed')
        return fail(
          res,
          409,
          'SUBSCRIPTION_ALREADY_ACTIVE',
          'This society already has an active subscription',
        );
      return res.json({
        subscription: result.subscription ? serializeSubscription(result.subscription) : null,
      });
    } catch (error) {
      next(error);
    }
  },
);
