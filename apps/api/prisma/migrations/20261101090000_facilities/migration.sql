CREATE TYPE "FacilityBookingStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "facilities" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT TRUE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "facilities_capacity_check" CHECK ("capacity" > 0)
);

CREATE TABLE "facility_bookings" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "FacilityBookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "purpose" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "facility_bookings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "facility_bookings_time_check" CHECK ("starts_at" < "ends_at")
);

CREATE UNIQUE INDEX "facilities_society_id_id_key" ON "facilities"("society_id", "id");
CREATE UNIQUE INDEX "facilities_society_id_name_key" ON "facilities"("society_id", "name");
CREATE INDEX "facilities_society_id_active_idx" ON "facilities"("society_id", "active");
CREATE UNIQUE INDEX "facility_bookings_society_id_id_key" ON "facility_bookings"("society_id", "id");
CREATE INDEX "facility_bookings_society_id_facility_id_starts_at_ends_at_idx" ON "facility_bookings"("society_id", "facility_id", "starts_at", "ends_at");
CREATE INDEX "facility_bookings_society_id_requester_id_starts_at_idx" ON "facility_bookings"("society_id", "requester_id", "starts_at");

ALTER TABLE "facilities" ADD CONSTRAINT "facilities_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "facility_bookings" ADD CONSTRAINT "facility_bookings_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "facility_bookings" ADD CONSTRAINT "facility_bookings_society_id_facility_id_fkey"
FOREIGN KEY ("society_id", "facility_id") REFERENCES "facilities"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "facility_bookings" ADD CONSTRAINT "facility_bookings_requester_id_fkey"
FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
