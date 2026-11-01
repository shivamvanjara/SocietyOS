CREATE TABLE "society_invitations" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" "SocietyRole" NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "society_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "society_invitations_token_hash_key" ON "society_invitations"("token_hash");
CREATE UNIQUE INDEX "society_invitations_society_id_id_key" ON "society_invitations"("society_id", "id");
CREATE INDEX "society_invitations_society_id_email_accepted_at_idx" ON "society_invitations"("society_id", "email", "accepted_at");
CREATE INDEX "society_invitations_society_id_expires_at_idx" ON "society_invitations"("society_id", "expires_at");

ALTER TABLE "society_invitations" ADD CONSTRAINT "society_invitations_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "society_invitations" ADD CONSTRAINT "society_invitations_invited_by_id_fkey"
FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
