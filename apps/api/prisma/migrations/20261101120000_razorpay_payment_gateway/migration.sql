CREATE TYPE "PaymentOrderStatus" AS ENUM ('CREATED', 'PAID', 'FAILED');
ALTER TYPE "PaymentMethod" ADD VALUE 'RAZORPAY';
ALTER TABLE "payments" ADD COLUMN "provider_payment_id" VARCHAR(100);
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_order_id" VARCHAR(100) NOT NULL,
    "provider_payment_id" VARCHAR(100),
    "amount_paise" BIGINT NOT NULL,
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'CREATED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_orders_amount_paise_check" CHECK ("amount_paise" > 0),
    CONSTRAINT "payment_orders_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_orders_society_invoice_fkey" FOREIGN KEY ("society_id", "invoice_id") REFERENCES "invoices"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "payment_webhook_events" (
    "provider_event_id" VARCHAR(120) NOT NULL,
    "society_id" UUID,
    "event_type" VARCHAR(80) NOT NULL,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("provider_event_id"),
    CONSTRAINT "payment_webhook_events_society_id_fkey" FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "payment_orders_provider_order_id_key" ON "payment_orders"("provider_order_id");
CREATE UNIQUE INDEX "payment_orders_provider_payment_id_key" ON "payment_orders"("provider_payment_id");
CREATE INDEX "payment_orders_society_id_invoice_id_status_idx" ON "payment_orders"("society_id", "invoice_id", "status");
CREATE INDEX "payment_orders_society_id_user_id_created_at_idx" ON "payment_orders"("society_id", "user_id", "created_at");
CREATE INDEX "payment_webhook_events_society_id_created_at_idx" ON "payment_webhook_events"("society_id", "created_at");
