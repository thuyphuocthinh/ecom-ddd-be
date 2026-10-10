-- CreateEnum
CREATE TYPE "ProvinceType" AS ENUM ('CITY', 'PROVINCE');

-- CreateEnum
CREATE TYPE "WardType" AS ENUM ('WARD', 'COMMUNE', 'SPECIAL_ZONE');

-- CreateTable
CREATE TABLE "Province" (
    "code" VARCHAR(2) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "ProvinceType" NOT NULL,

    CONSTRAINT "Province_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Ward" (
    "code" VARCHAR(5) NOT NULL,
    "provinceCode" VARCHAR(2) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "WardType" NOT NULL,

    CONSTRAINT "Ward_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "Ward_provinceCode_idx" ON "Ward"("provinceCode");

-- AddForeignKey
ALTER TABLE "Ward" ADD CONSTRAINT "Ward_provinceCode_fkey" FOREIGN KEY ("provinceCode") REFERENCES "Province"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written (Prisma's schema language cannot express CHECK constraints): the database itself refuses a
-- code that is not the expected number of digits (province 2, ward 5) and an empty name.
ALTER TABLE "Province" ADD CONSTRAINT "Province_code_format" CHECK ("code" ~ '^[0-9]{2}$');
ALTER TABLE "Province" ADD CONSTRAINT "Province_name_not_empty" CHECK (char_length(btrim("name")) > 0);

ALTER TABLE "Ward" ADD CONSTRAINT "Ward_code_format" CHECK ("code" ~ '^[0-9]{5}$');
ALTER TABLE "Ward" ADD CONSTRAINT "Ward_name_not_empty" CHECK (char_length(btrim("name")) > 0);
