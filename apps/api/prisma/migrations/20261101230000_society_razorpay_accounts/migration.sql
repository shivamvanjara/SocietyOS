CREATE TABLE "society_razorpay_accounts" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "key_id" VARCHAR(120) NOT NULL,
    "api_secret_encrypted" TEXT NOT NULL,
    "webhook_secret_encrypted" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "society_razorpay_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "society_razorpay_accounts_key_id_check" CHECK ("key_id" ~ '^rzp_(test|live)_[A-Za-z0-9]+$')
);

CREATE UNIQUE INDEX "society_razorpay_accounts_society_id_id_key"
ON "society_razorpay_accounts"("society_id", "id");
CREATE UNIQUE INDEX "society_razorpay_accounts_one_active_per_society_key"
ON "society_razorpay_accounts"("society_id") WHERE "active" = true;
CREATE INDEX "society_razorpay_accounts_society_id_active_idx"
ON "society_razorpay_accounts"("society_id", "active");

ALTER TABLE "society_razorpay_accounts"
ADD CONSTRAINT "society_razorpay_accounts_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_orders"
ADD COLUMN "razorpay_account_id" UUID;

ALTER TABLE "payment_orders"
ADD CONSTRAINT "payment_orders_society_id_razorpay_account_id_fkey"
FOREIGN KEY ("society_id", "razorpay_account_id")
REFERENCES "society_razorpay_accounts"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "payment_orders_society_id_razorpay_account_id_idx"
ON "payment_orders"("society_id", "razorpay_account_id");
