ALTER TABLE "visitor_passes"
ADD COLUMN "expected_duration_minutes" INTEGER NOT NULL DEFAULT 240;

ALTER TABLE "visitor_passes"
ADD CONSTRAINT "visitor_passes_expected_duration_check"
CHECK ("expected_duration_minutes" BETWEEN 15 AND 1440);
