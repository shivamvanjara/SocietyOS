CREATE TABLE "recurring_visitor_authorizations" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "flat_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "visitor_name" VARCHAR(160) NOT NULL,
    "visitor_phone" VARCHAR(16) NOT NULL,
    "visitor_type" "VisitorType" NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "weekdays" INTEGER[] NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT TRUE,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "recurring_visitor_authorizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "recurring_visitor_authorizations_society_date_check"
        CHECK ("valid_from" <= "valid_until"),
    CONSTRAINT "recurring_visitor_authorizations_weekdays_check"
        CHECK (cardinality("weekdays") BETWEEN 1 AND 7 AND "weekdays" <@ ARRAY[0,1,2,3,4,5,6]),
    CONSTRAINT "recurring_visitor_authorizations_window_check"
        CHECK ("start_minute" >= 0 AND "start_minute" < "end_minute" AND "end_minute" <= 1440),
    CONSTRAINT "recurring_visitor_authorizations_type_check"
        CHECK ("visitor_type" IN ('DOMESTIC_WORKER', 'SERVICE_PERSONNEL')),
    CONSTRAINT "recurring_visitor_authorizations_society_id_fkey"
        FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recurring_visitor_authorizations_society_id_flat_id_fkey"
        FOREIGN KEY ("society_id", "flat_id") REFERENCES "flats"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "recurring_visitor_authorizations_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "recurring_visitor_authorizations_society_id_id_key"
    ON "recurring_visitor_authorizations"("society_id", "id");
CREATE INDEX "recurring_visitor_authorizations_society_flat_active_until_idx"
    ON "recurring_visitor_authorizations"("society_id", "flat_id", "active", "valid_until");
CREATE INDEX "recurring_visitor_authorizations_society_phone_active_idx"
    ON "recurring_visitor_authorizations"("society_id", "visitor_phone", "active");
