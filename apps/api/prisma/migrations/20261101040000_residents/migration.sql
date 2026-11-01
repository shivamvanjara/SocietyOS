CREATE TYPE "ResidentType" AS ENUM ('OWNER', 'TENANT');
CREATE TYPE "ResidentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

ALTER TABLE "flats"
ADD CONSTRAINT "flats_society_id_id_key" UNIQUE ("society_id", "id");

CREATE TABLE "residents" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "flat_id" UUID NOT NULL,
    "full_name" VARCHAR(160) NOT NULL,
    "email" VARCHAR(320),
    "phone" VARCHAR(16),
    "resident_type" "ResidentType" NOT NULL,
    "status" "ResidentStatus" NOT NULL DEFAULT 'ACTIVE',
    "emergency_contact_name" VARCHAR(160),
    "emergency_contact_phone" VARCHAR(16),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "residents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "residents_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "residents_society_flat_fkey" FOREIGN KEY ("society_id", "flat_id") REFERENCES "flats"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "resource_type" VARCHAR(80) NOT NULL,
    "resource_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "residents_society_id_flat_id_status_idx" ON "residents"("society_id", "flat_id", "status");
CREATE INDEX "residents_society_id_full_name_idx" ON "residents"("society_id", "full_name");
CREATE INDEX "audit_logs_society_id_created_at_idx" ON "audit_logs"("society_id", "created_at");
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");
