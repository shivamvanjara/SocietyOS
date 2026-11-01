CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'PARTIAL', 'PAID', 'VOID');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER');

CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "flat_id" UUID NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "amount_paise" BIGINT NOT NULL CHECK ("amount_paise" > 0),
    "due_date" DATE NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_paise" BIGINT NOT NULL CHECK ("amount_paise" > 0),
    "method" "PaymentMethod" NOT NULL,
    "reference" VARCHAR(100),
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoices_society_id_id_key" ON "invoices"("society_id", "id");
CREATE UNIQUE INDEX "invoices_society_id_flat_id_period_description_key" ON "invoices"("society_id", "flat_id", "period", "description");
CREATE INDEX "invoices_society_id_status_due_date_idx" ON "invoices"("society_id", "status", "due_date");
CREATE INDEX "invoices_society_id_flat_id_period_idx" ON "invoices"("society_id", "flat_id", "period");
CREATE UNIQUE INDEX "payments_society_id_id_key" ON "payments"("society_id", "id");
CREATE INDEX "payments_society_id_received_at_idx" ON "payments"("society_id", "received_at");

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_society_id_flat_id_fkey"
FOREIGN KEY ("society_id", "flat_id") REFERENCES "flats"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_society_id_invoice_id_fkey"
FOREIGN KEY ("society_id", "invoice_id") REFERENCES "invoices"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
