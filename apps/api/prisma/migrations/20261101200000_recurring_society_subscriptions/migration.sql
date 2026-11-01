ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING';

ALTER TABLE "subscription_plans"
  ADD COLUMN "razorpay_plan_id" VARCHAR(100),
  ADD COLUMN "provider_price_paise" BIGINT,
  ADD COLUMN "provider_interval" "BillingInterval";

CREATE UNIQUE INDEX "subscription_plans_razorpay_plan_id_key"
  ON "subscription_plans"("razorpay_plan_id");

ALTER TABLE "society_subscriptions"
  ADD COLUMN "provider_subscription_id" VARCHAR(100),
  ADD COLUMN "provider_plan_id" VARCHAR(100),
  ADD COLUMN "checkout_url" VARCHAR(1000),
  ADD COLUMN "cancel_at_cycle_end" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "society_subscriptions_provider_subscription_id_key"
  ON "society_subscriptions"("provider_subscription_id");

CREATE TABLE "society_subscription_charges" (
  "id" UUID NOT NULL,
  "society_subscription_id" UUID NOT NULL,
  "provider_payment_id" VARCHAR(100) NOT NULL,
  "provider_event_id" VARCHAR(120) NOT NULL,
  "amount_paise" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
  "status" VARCHAR(20) NOT NULL,
  "paid_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "society_subscription_charges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "society_subscription_charges_amount_paise_check" CHECK ("amount_paise" > 0),
  CONSTRAINT "society_subscription_charges_status_check" CHECK ("status" IN ('CAPTURED')),
  CONSTRAINT "society_subscription_charges_subscription_fkey"
    FOREIGN KEY ("society_subscription_id") REFERENCES "society_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "society_subscription_charges_provider_payment_id_key"
  ON "society_subscription_charges"("provider_payment_id");
CREATE INDEX "society_subscription_charges_subscription_created_idx"
  ON "society_subscription_charges"("society_subscription_id", "created_at");

CREATE TABLE "society_subscription_webhook_events" (
  "provider_event_id" VARCHAR(120) NOT NULL,
  "society_subscription_id" UUID,
  "event_type" VARCHAR(80) NOT NULL,
  "processed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "society_subscription_webhook_events_pkey" PRIMARY KEY ("provider_event_id"),
  CONSTRAINT "society_subscription_webhook_events_subscription_fkey"
    FOREIGN KEY ("society_subscription_id") REFERENCES "society_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "society_subscription_webhook_events_subscription_created_idx"
  ON "society_subscription_webhook_events"("society_subscription_id", "created_at");
