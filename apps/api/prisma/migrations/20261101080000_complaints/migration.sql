CREATE TYPE "ComplaintStatus" AS ENUM ('SUBMITTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
CREATE TYPE "ComplaintPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

CREATE TABLE "complaints" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "submitted_by_id" UUID NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "description" VARCHAR(5000) NOT NULL,
    "priority" "ComplaintPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "ComplaintStatus" NOT NULL DEFAULT 'SUBMITTED',
    "resolution" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "complaint_comments" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(3000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "complaint_comments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "complaints_society_id_id_key" ON "complaints"("society_id", "id");
CREATE INDEX "complaints_society_id_status_created_at_idx" ON "complaints"("society_id", "status", "created_at");
CREATE INDEX "complaints_society_id_submitted_by_id_created_at_idx" ON "complaints"("society_id", "submitted_by_id", "created_at");
CREATE UNIQUE INDEX "complaint_comments_society_id_id_key" ON "complaint_comments"("society_id", "id");
CREATE INDEX "complaint_comments_society_id_complaint_id_created_at_idx" ON "complaint_comments"("society_id", "complaint_id", "created_at");

ALTER TABLE "complaints" ADD CONSTRAINT "complaints_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_submitted_by_id_fkey"
FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complaint_comments" ADD CONSTRAINT "complaint_comments_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complaint_comments" ADD CONSTRAINT "complaint_comments_society_id_complaint_id_fkey"
FOREIGN KEY ("society_id", "complaint_id") REFERENCES "complaints"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complaint_comments" ADD CONSTRAINT "complaint_comments_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
