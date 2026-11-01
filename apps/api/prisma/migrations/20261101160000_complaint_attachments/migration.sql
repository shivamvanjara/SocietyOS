CREATE TABLE "complaint_attachments" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "complaint_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "original_name" VARCHAR(160) NOT NULL,
    "mime_type" VARCHAR(80) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "complaint_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "complaint_attachments_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 5242880),
    CONSTRAINT "complaint_attachments_mime_type_check" CHECK ("mime_type" IN ('image/png', 'image/jpeg', 'image/webp'))
);

CREATE UNIQUE INDEX "complaint_attachments_society_id_id_key" ON "complaint_attachments"("society_id", "id");
CREATE INDEX "complaint_attachments_society_id_complaint_id_created_at_idx" ON "complaint_attachments"("society_id", "complaint_id", "created_at");
ALTER TABLE "complaint_attachments" ADD CONSTRAINT "complaint_attachments_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complaint_attachments" ADD CONSTRAINT "complaint_attachments_society_id_complaint_id_fkey" FOREIGN KEY ("society_id", "complaint_id") REFERENCES "complaints"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complaint_attachments" ADD CONSTRAINT "complaint_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
