ALTER TABLE "users"
ADD COLUMN "mfa_secret_encrypted" VARCHAR(256),
ADD COLUMN "mfa_enabled_at" TIMESTAMPTZ(6),
ADD COLUMN "mfa_last_used_step" BIGINT,
ADD COLUMN "mfa_pending_secret_encrypted" VARCHAR(256),
ADD COLUMN "mfa_pending_expires_at" TIMESTAMPTZ(6);

ALTER TABLE "users"
ADD CONSTRAINT "users_mfa_secret_state_check"
CHECK (("mfa_secret_encrypted" IS NULL) = ("mfa_enabled_at" IS NULL)),
ADD CONSTRAINT "users_mfa_pending_state_check"
CHECK (("mfa_pending_secret_encrypted" IS NULL) = ("mfa_pending_expires_at" IS NULL));

CREATE TABLE "mfa_login_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mfa_login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_login_challenges_token_hash_key" ON "mfa_login_challenges"("token_hash");
CREATE INDEX "mfa_login_challenges_user_id_expires_at_idx" ON "mfa_login_challenges"("user_id", "expires_at");
ALTER TABLE "mfa_login_challenges" ADD CONSTRAINT "mfa_login_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
