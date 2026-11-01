import express from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { requireAuthenticated, requireCsrf } from '../auth/router.js';
import {
  createRazorpayPlan,
  createRazorpaySubscription,
  cancelRazorpaySubscription,
  razorpaySubscriptionsConfigured,
} from '../payments/razorpay.js';

export const societySubscriptionsRouter = express.Router({ mergeParams: true });
const uuid = z.uuid();
const checkoutSchema = z.object({ planId: uuid }).strict();
const activeStatuses = ['PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE'];

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function moneyString(paise) {
  return `${paise / 100n}.${String(paise % 100n).padStart(2, '0')}`;
}

function serializeSubscription(subscription) {
  if (!subscription) return null;
  return {
    ...subscription,
    price: moneyString(subscription.pricePaise),
    pricePaise: undefined,
    charges: subscription.charges?.map((charge) => ({
      ...charge,
      amount: moneyString(charge.amountPaise),
      amountPaise: undefined,
    })),
  };
}

async function societyAdmin(db, societyId, userId) {
  return db.societyMembership.findFirst({
    where: {
      societyId,
      userId,
      active: true,
      role: 'SOCIETY_ADMIN',
      society: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
}

societySubscriptionsRouter.use(requireAuthenticated);

societySubscriptionsRouter.get('/', async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  if (!societyId.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid society');
  try {
    if (!(await societyAdmin(prisma, societyId.data, req.auth.user.id)))
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const [plans, subscription] = await Promise.all([
      prisma.subscriptionPlan.findMany({
        where: { active: true },
        select: {
          id: true,
          name: true,
          description: true,
          billingInterval: true,
          pricePaise: true,
          maxBuildings: true,
          maxFlats: true,
        },
        orderBy: [{ pricePaise: 'asc' }, { name: 'asc' }],
      }),
      prisma.societySubscription.findFirst({
        where: { societyId: societyId.data },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          plan: { select: { id: true, name: true } },
          charges: { orderBy: { createdAt: 'desc' }, take: 20 },
        },
      }),
    ]);
    return res.json({
      plans: plans.map((plan) => ({
        ...plan,
        price: moneyString(plan.pricePaise),
        pricePaise: undefined,
      })),
      subscription: serializeSubscription(subscription),
      razorpayConfigured: razorpaySubscriptionsConfigured(),
    });
  } catch (error) {
    return next(error);
  }
});

societySubscriptionsRouter.post('/checkout', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const parsed = checkoutSchema.safeParse(req.body);
  if (!societyId.success || !parsed.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Choose a valid subscription plan');
  if (!razorpaySubscriptionsConfigured())
    return fail(
      res,
      503,
      'PAYMENTS_NOT_CONFIGURED',
      'Subscription payments and their webhook are not configured',
    );

  try {
    if (!(await societyAdmin(prisma, societyId.data, req.auth.user.id)))
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');

    const prepared = await prisma.$transaction(async (tx) => {
      const [society] =
        await tx.$queryRaw`SELECT id, status FROM societies WHERE id = ${societyId.data}::uuid FOR UPDATE`;
      if (!society) return { kind: 'missing' };
      if (society.status !== 'ACTIVE') return { kind: 'inactive' };
      const current = await tx.societySubscription.findFirst({
        where: { societyId: societyId.data, status: { in: activeStatuses } },
        include: { plan: true },
      });
      if (current?.status === 'PENDING' && current.planId !== parsed.data.planId)
        return { kind: 'pending_other_plan' };
      if (current?.providerSubscriptionId && current.checkoutUrl)
        return { kind: 'existing_checkout', subscription: current };
      if (current?.status === 'PENDING') return { kind: 'checkout_in_progress' };
      if (current && current.status !== 'PENDING') return { kind: 'already_active' };
      const plan = await tx.subscriptionPlan.findFirst({
        where: { id: parsed.data.planId, active: true },
      });
      if (!plan) return { kind: 'plan_missing' };
      if (plan.pricePaise < 100n) return { kind: 'price_too_low' };
      const subscription = current
        ? current
        : await tx.societySubscription.create({
            data: {
              societyId: societyId.data,
              planId: plan.id,
              createdById: req.auth.user.id,
              status: 'PENDING',
              billingInterval: plan.billingInterval,
              pricePaise: plan.pricePaise,
              maxBuildings: plan.maxBuildings,
              maxFlats: plan.maxFlats,
              startsAt: new Date(),
            },
          });
      return { kind: 'prepared', subscription, plan };
    });

    if (prepared.kind === 'missing')
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (prepared.kind === 'inactive')
      return fail(res, 409, 'SOCIETY_INACTIVE', 'Reactivate the society before subscribing');
    if (prepared.kind === 'already_active')
      return fail(
        res,
        409,
        'SUBSCRIPTION_ALREADY_ACTIVE',
        'This society already has an active subscription',
      );
    if (prepared.kind === 'pending_other_plan')
      return fail(
        res,
        409,
        'CHECKOUT_ALREADY_PENDING',
        'Finish or cancel the current plan checkout first',
      );
    if (prepared.kind === 'checkout_in_progress')
      return fail(
        res,
        409,
        'CHECKOUT_PREPARING',
        'The current secure checkout is still being prepared. Refresh this page in a moment.',
      );
    if (prepared.kind === 'plan_missing')
      return fail(res, 404, 'PLAN_NOT_FOUND', 'An active subscription plan was not found');
    if (prepared.kind === 'price_too_low')
      return fail(
        res,
        422,
        'PLAN_PRICE_UNSUPPORTED',
        'Online subscriptions must cost at least ₹1.00',
      );
    if (prepared.kind === 'existing_checkout')
      return res.json({
        subscription: serializeSubscription(prepared.subscription),
        checkoutUrl: prepared.subscription.checkoutUrl,
      });

    const { subscription, plan } = prepared;
    let providerPlanId = plan.razorpayPlanId;
    if (
      !providerPlanId ||
      plan.providerPricePaise !== plan.pricePaise ||
      plan.providerInterval !== plan.billingInterval
    ) {
      const providerPlan = await createRazorpayPlan({
        name: plan.name,
        description: plan.description,
        billingInterval: plan.billingInterval,
        amountPaise: Number(plan.pricePaise),
      });
      if (!providerPlan?.id) throw new Error('Payment provider did not return a plan id');
      providerPlanId = providerPlan.id;
      await prisma.subscriptionPlan.update({
        where: { id: plan.id },
        data: {
          razorpayPlanId: providerPlanId,
          providerPricePaise: plan.pricePaise,
          providerInterval: plan.billingInterval,
        },
      });
    }
    const providerSubscription = await createRazorpaySubscription({
      planId: providerPlanId,
      societySubscriptionId: subscription.id,
      societyId: societyId.data,
      billingInterval: plan.billingInterval,
    });
    if (!providerSubscription?.id || !providerSubscription?.short_url)
      throw new Error('Payment provider did not return a checkout link');
    const updated = await prisma.societySubscription.update({
      where: { id: subscription.id },
      data: {
        providerSubscriptionId: providerSubscription.id,
        providerPlanId,
        checkoutUrl: providerSubscription.short_url,
      },
      include: { plan: { select: { id: true, name: true } }, charges: true },
    });
    return res.status(201).json({
      subscription: serializeSubscription(updated),
      checkoutUrl: providerSubscription.short_url,
    });
  } catch (error) {
    if (error?.code === 'P2002')
      return fail(
        res,
        409,
        'SUBSCRIPTION_ALREADY_ACTIVE',
        'A subscription checkout is already in progress',
      );
    return next(error);
  }
});

societySubscriptionsRouter.post('/:subscriptionId/cancel', requireCsrf, async (req, res, next) => {
  const societyId = uuid.safeParse(req.params.societyId);
  const subscriptionId = uuid.safeParse(req.params.subscriptionId);
  if (!societyId.success || !subscriptionId.success)
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid subscription');
  try {
    if (!(await societyAdmin(prisma, societyId.data, req.auth.user.id)))
      return fail(res, 404, 'SOCIETY_NOT_FOUND', 'Society not found');
    const subscription = await prisma.societySubscription.findFirst({
      where: { id: subscriptionId.data, societyId: societyId.data },
    });
    if (!subscription) return fail(res, 404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
    if (!['PENDING', 'TRIAL', 'ACTIVE', 'PAST_DUE'].includes(subscription.status))
      return fail(res, 409, 'SUBSCRIPTION_NOT_ACTIVE', 'This subscription is already ended');

    const cancelAtCycleEnd = subscription.status !== 'PENDING';
    let providerResult = null;
    if (subscription.providerSubscriptionId) {
      if (!razorpaySubscriptionsConfigured())
        return fail(
          res,
          503,
          'PAYMENTS_NOT_CONFIGURED',
          'Subscription payments are not configured',
        );
      providerResult = await cancelRazorpaySubscription(
        subscription.providerSubscriptionId,
        cancelAtCycleEnd,
      );
    }
    const updated = await prisma.societySubscription.update({
      where: { id: subscription.id },
      data: cancelAtCycleEnd
        ? {
            cancelAtCycleEnd: true,
            ...(Number.isInteger(providerResult?.current_end) && providerResult.current_end > 0
              ? { endsAt: new Date(providerResult.current_end * 1000) }
              : {}),
          }
        : { status: 'CANCELED', canceledAt: new Date(), endsAt: new Date() },
      include: { plan: { select: { id: true, name: true } }, charges: true },
    });
    return res.json({ subscription: serializeSubscription(updated) });
  } catch (error) {
    return next(error);
  }
});
