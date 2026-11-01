ALTER TABLE "visitor_passes"
ADD COLUMN "parking_location" VARCHAR(80),
ADD COLUMN "parking_alert" BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN "group_size" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "visitor_passes"
ADD CONSTRAINT "visitor_passes_group_size_check" CHECK ("group_size" >= 1 AND "group_size" <= 50);
