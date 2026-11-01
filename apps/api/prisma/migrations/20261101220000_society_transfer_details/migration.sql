ALTER TABLE "societies"
  ADD COLUMN "bank_account_name" VARCHAR(160),
  ADD COLUMN "bank_account_number" VARCHAR(34),
  ADD COLUMN "bank_name" VARCHAR(120),
  ADD COLUMN "bank_ifsc_code" VARCHAR(11),
  ADD COLUMN "upi_id" VARCHAR(100),
  ADD COLUMN "transfer_instructions" VARCHAR(500);

ALTER TABLE "societies"
  ADD CONSTRAINT "societies_bank_account_number_format_check"
    CHECK ("bank_account_number" IS NULL OR "bank_account_number" ~ '^[0-9]{6,34}$'),
  ADD CONSTRAINT "societies_bank_ifsc_code_format_check"
    CHECK ("bank_ifsc_code" IS NULL OR "bank_ifsc_code" ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  ADD CONSTRAINT "societies_bank_details_complete_check"
    CHECK (
      ("bank_account_name" IS NULL AND "bank_account_number" IS NULL AND "bank_name" IS NULL AND "bank_ifsc_code" IS NULL)
      OR
      ("bank_account_name" IS NOT NULL AND "bank_account_number" IS NOT NULL AND "bank_name" IS NOT NULL AND "bank_ifsc_code" IS NOT NULL)
    );
