CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "category" VARCHAR(80) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "vendor" VARCHAR(160),
    "amount_paise" BIGINT NOT NULL CHECK ("amount_paise" > 0),
    "spent_at" DATE NOT NULL,
    "reference" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expenses_society_id_id_key" ON "expenses"("society_id", "id");
CREATE INDEX "expenses_society_id_spent_at_idx" ON "expenses"("society_id", "spent_at");

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
