CREATE TABLE "notices" (
    "id" UUID NOT NULL,
    "society_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "body" VARCHAR(10000) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notice_reads" (
    "society_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notice_reads_pkey" PRIMARY KEY ("society_id", "notice_id", "user_id")
);

CREATE UNIQUE INDEX "notices_society_id_id_key" ON "notices"("society_id", "id");
CREATE INDEX "notices_society_id_published_at_idx" ON "notices"("society_id", "published_at");
CREATE INDEX "notice_reads_user_id_read_at_idx" ON "notice_reads"("user_id", "read_at");

ALTER TABLE "notices" ADD CONSTRAINT "notices_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notices" ADD CONSTRAINT "notices_author_id_fkey"
FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_society_id_fkey"
FOREIGN KEY ("society_id") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_society_id_notice_id_fkey"
FOREIGN KEY ("society_id", "notice_id") REFERENCES "notices"("society_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
