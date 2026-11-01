CREATE TYPE "VisitorPassStatus" AS ENUM ('EXPECTED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'EXPIRED');

CREATE TABLE "visitor_passes" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "flat_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "visitor_name" VARCHAR(160) NOT NULL,
    "visitor_phone" VARCHAR(16),
    "purpose" VARCHAR(200) NOT NULL,
    "expected_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "VisitorPassStatus" NOT NULL DEFAULT 'EXPECTED',
    "checked_in_at" TIMESTAMPTZ(6),
    "checked_in_by_id" UUID,
    "checked_out_at" TIMESTAMPTZ(6),
    "checked_out_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "visitor_passes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "visitor_passes_expiry_check" CHECK ("expected_at" < "expires_at")
);

CREATE UNIQUE INDEX "visitor_passes_token_hash_key" ON "visitor_passes"("token_hash");
CREATE UNIQUE INDEX "visitor_passes_society_id_id_key" ON "visitor_passes"("society_id", "id");
CREATE INDEX "visitor_passes_society_id_status_expected_at_idx" ON "visitor_passes"("society_id", "status", "expected_at");
CREATE INDEX "visitor_passes_society_id_flat_id_created_at_idx" ON "visitor_passes"("society_id", "flat_id", "created_at");

ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_society_id_flat_id_fkey"
FOREIGN KEY ("society_id", "flat_id") REFERENCES "flats"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_checked_in_by_id_fkey"
FOREIGN KEY ("checked_in_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_checked_out_by_id_fkey"
FOREIGN KEY ("checked_out_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
