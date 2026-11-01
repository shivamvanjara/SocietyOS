CREATE TYPE "FlatOccupancyStatus" AS ENUM ('VACANT', 'OCCUPIED');

CREATE TABLE "buildings" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "buildings_society_id_id_key" UNIQUE ("society_id", "id"),
    CONSTRAINT "buildings_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "flats" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "building_id" UUID NOT NULL,
    "flat_number" VARCHAR(20) NOT NULL,
    "floor" INTEGER NOT NULL,
    "flat_type" VARCHAR(40),
    "occupancy_status" "FlatOccupancyStatus" NOT NULL DEFAULT 'VACANT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "flats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "flats_floor_range_check" CHECK ("floor" BETWEEN -5 AND 200),
    CONSTRAINT "flats_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "flats_society_building_fkey" FOREIGN KEY ("society_id", "building_id") REFERENCES "buildings"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "buildings_society_id_name_key" ON "buildings"("society_id", "name");
CREATE UNIQUE INDEX "flats_society_id_building_id_flat_number_key" ON "flats"("society_id", "building_id", "flat_number");
CREATE INDEX "flats_society_id_building_id_occupancy_status_idx" ON "flats"("society_id", "building_id", "occupancy_status");
