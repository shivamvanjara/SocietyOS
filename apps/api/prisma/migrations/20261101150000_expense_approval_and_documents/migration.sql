CREATE TYPE "ExpenseStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

ALTER TABLE "expenses"
ADD COLUMN "status" "ExpenseStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "created_by_id" UUID,
ADD COLUMN "reviewed_by_id" UUID,
ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
ADD COLUMN "rejection_reason" VARCHAR(500);

ALTER TABLE "expenses"
ADD CONSTRAINT "expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "expenses_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "expenses_society_id_status_spent_at_idx" ON "expenses"("society_id", "status", "spent_at");

CREATE TABLE "expense_attachments" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "original_name" VARCHAR(160) NOT NULL,
    "mime_type" VARCHAR(80) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expense_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expense_attachments_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 5242880),
    CONSTRAINT "expense_attachments_mime_type_check" CHECK ("mime_type" IN ('application/pdf', 'image/png', 'image/jpeg'))
);

CREATE UNIQUE INDEX "expense_attachments_society_id_id_key" ON "expense_attachments"("society_id", "id");
CREATE INDEX "expense_attachments_society_id_expense_id_created_at_idx" ON "expense_attachments"("society_id", "expense_id", "created_at");
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_society_id_expense_id_fkey" FOREIGN KEY ("society_id", "expense_id") REFERENCES "expenses"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_attachments" ADD CONSTRAINT "expense_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
