CREATE TYPE "DeliveryHandoverStatus" AS ENUM (
  'NOT_RECORDED',
  'HANDED_AT_GATE',
  'TAKEN_DOORSTEP',
  'REFUSED'
);

ALTER TABLE "visitor_passes"
ADD COLUMN "delivery_handover_status" "DeliveryHandoverStatus" NOT NULL DEFAULT 'NOT_RECORDED',
ADD COLUMN "delivery_handover_at" TIMESTAMPTZ(6),
ADD COLUMN "delivery_handover_by_id" UUID;

ALTER TABLE "visitor_passes"
ADD CONSTRAINT "visitor_passes_delivery_handover_by_id_fkey"
FOREIGN KEY ("delivery_handover_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
