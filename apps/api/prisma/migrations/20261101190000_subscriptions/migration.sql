CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "billing_interval" "BillingInterval" NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_plans_price_paise_check" CHECK ("price_paise" >= 0)
);

CREATE UNIQUE INDEX "subscription_plans_name_billing_interval_key" ON "subscription_plans"("name", "billing_interval");
CREATE INDEX "subscription_plans_active_billing_interval_idx" ON "subscription_plans"("active", "billing_interval");

CREATE TABLE "society_subscriptions" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "billing_interval" "BillingInterval" NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "canceled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "society_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "society_subscriptions_price_paise_check" CHECK ("price_paise" >= 0),
    CONSTRAINT "society_subscriptions_period_check" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);

CREATE INDEX "society_subscriptions_society_id_created_at_idx" ON "society_subscriptions"("society_id", "created_at");
CREATE INDEX "society_subscriptions_status_ends_at_idx" ON "society_subscriptions"("status", "ends_at");

ALTER TABLE "society_subscriptions" ADD CONSTRAINT "society_subscriptions_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "society_subscriptions" ADD CONSTRAINT "society_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "society_subscriptions" ADD CONSTRAINT "society_subscriptions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
