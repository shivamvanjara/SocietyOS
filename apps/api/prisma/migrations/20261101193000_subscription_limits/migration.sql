ALTER TABLE "subscription_plans"
    ADD COLUMN "max_buildings" INTEGER,
    ADD COLUMN "max_flats" INTEGER;

ALTER TABLE "subscription_plans"
    ADD CONSTRAINT "subscription_plans_max_buildings_check"
        CHECK ("max_buildings" IS NULL OR "max_buildings" > 0),
    ADD CONSTRAINT "subscription_plans_max_flats_check"
        CHECK ("max_flats" IS NULL OR "max_flats" > 0);

ALTER TABLE "society_subscriptions"
    ADD COLUMN "max_buildings" INTEGER,
    ADD COLUMN "max_flats" INTEGER;

ALTER TABLE "society_subscriptions"
    ADD CONSTRAINT "society_subscriptions_max_buildings_check"
        CHECK ("max_buildings" IS NULL OR "max_buildings" > 0),
    ADD CONSTRAINT "society_subscriptions_max_flats_check"
        CHECK ("max_flats" IS NULL OR "max_flats" > 0);
