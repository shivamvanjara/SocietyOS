CREATE TYPE "SocietyStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "societies"
ADD COLUMN "address_line_1" VARCHAR(200),
ADD COLUMN "address_line_2" VARCHAR(200),
ADD COLUMN "city" VARCHAR(100),
ADD COLUMN "state" VARCHAR(100),
ADD COLUMN "postal_code" VARCHAR(10),
ADD COLUMN "registration_code" VARCHAR(80),
ADD COLUMN "status" "SocietyStatus" NOT NULL DEFAULT 'ACTIVE';
