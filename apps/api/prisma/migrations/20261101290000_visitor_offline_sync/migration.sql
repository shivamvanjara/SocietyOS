ALTER TABLE "visitor_passes"
ADD COLUMN "client_request_id" UUID;

CREATE UNIQUE INDEX "visitor_passes_society_id_client_request_id_key"
ON "visitor_passes"("society_id", "client_request_id");
