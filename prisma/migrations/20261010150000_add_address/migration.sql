-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipientName" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "provinceCode" VARCHAR(2) NOT NULL,
    "provinceName" VARCHAR(100) NOT NULL,
    "wardCode" VARCHAR(5) NOT NULL,
    "wardName" VARCHAR(100) NOT NULL,
    "street" VARCHAR(255) NOT NULL,
    "label" VARCHAR(50),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Address_userId_idx" ON "Address"("userId");

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_provinceCode_fkey" FOREIGN KEY ("provinceCode") REFERENCES "Province"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_wardCode_fkey" FOREIGN KEY ("wardCode") REFERENCES "Ward"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: a user can have only one default address. The code keeps this true under a lock;
-- this partial unique index makes the database itself refuse a second default for the same user
-- (Prisma's schema language cannot express an index with a WHERE).
CREATE UNIQUE INDEX "Address_userId_default_key" ON "Address"("userId") WHERE "isDefault" = true;

-- Hand-written: no empty text where a value is required
ALTER TABLE "Address" ADD CONSTRAINT "Address_text_not_empty" CHECK (
  char_length(btrim("recipientName")) > 0
  AND char_length(btrim("phone")) > 0
  AND char_length(btrim("street")) > 0
  AND char_length(btrim("provinceName")) > 0
  AND char_length(btrim("wardName")) > 0
);
