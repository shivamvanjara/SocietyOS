ALTER TYPE "VisitorPassStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "VisitorPassStatus" ADD VALUE 'REJECTED';

CREATE TYPE "VisitorType" AS ENUM ('DELIVERY', 'GUEST', 'SERVICE_PERSONNEL');

ALTER TABLE "visitor_passes"
ADD COLUMN "visitor_type" "VisitorType" NOT NULL DEFAULT 'GUEST';

CREATE INDEX "visitor_passes_society_checked_in_at_idx"
ON "visitor_passes"("society_id", "checked_in_at");

CREATE INDEX "visitor_passes_society_created_at_idx"
ON "visitor_passes"("society_id", "created_at");
