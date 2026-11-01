CREATE TYPE "GuardIncidentCategory" AS ENUM (
  'SUSPICIOUS_ACTIVITY',
  'UNAUTHORIZED_ENTRY',
  'LOST_ITEM',
  'EMERGENCY',
  'OTHER'
);

CREATE TYPE "GuardIncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "GuardIncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "guard_incidents" (
  "id" UUID NOT NULL,
  "society_id" UUID NOT NULL,
  "reported_by_id" UUID NOT NULL,
  "resolved_by_id" UUID,
  "category" "GuardIncidentCategory" NOT NULL,
  "severity" "GuardIncidentSeverity" NOT NULL DEFAULT 'MEDIUM',
  "status" "GuardIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "description" VARCHAR(2000) NOT NULL,
  "location" VARCHAR(160),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "guard_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guard_incidents_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guard_incidents_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guard_incidents_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "guard_incidents_society_id_id_key" ON "guard_incidents"("society_id", "id");
CREATE INDEX "guard_incidents_society_id_status_created_at_idx" ON "guard_incidents"("society_id", "status", "created_at");

CREATE TABLE "guard_shift_handovers" (
  "id" UUID NOT NULL,
  "society_id" UUID NOT NULL,
  "guard_id" UUID NOT NULL,
  "active_visitors_count" INTEGER NOT NULL,
  "pending_approvals_count" INTEGER NOT NULL,
  "open_incidents_count" INTEGER NOT NULL,
  "notes" VARCHAR(2000) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guard_shift_handovers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guard_shift_handovers_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "guard_shift_handovers_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "guard_shift_handovers_society_id_id_key" ON "guard_shift_handovers"("society_id", "id");
CREATE INDEX "guard_shift_handovers_society_id_created_at_idx" ON "guard_shift_handovers"("society_id", "created_at");
