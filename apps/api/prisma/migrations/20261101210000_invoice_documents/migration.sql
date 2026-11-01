CREATE TABLE "invoice_attachments" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "original_name" VARCHAR(160) NOT NULL,
    "mime_type" VARCHAR(80) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_attachments_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 5242880),
    CONSTRAINT "invoice_attachments_mime_type_check" CHECK ("mime_type" IN ('application/pdf', 'image/png', 'image/jpeg')),
    CONSTRAINT "invoice_attachments_society_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_attachments_society_invoice_fkey" FOREIGN KEY ("society_id", "invoice_id") REFERENCES "invoices"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "invoice_attachments_society_id_id_key" ON "invoice_attachments"("society_id", "id");
CREATE INDEX "invoice_attachments_society_id_invoice_id_created_at_idx" ON "invoice_attachments"("society_id", "invoice_id", "created_at");
