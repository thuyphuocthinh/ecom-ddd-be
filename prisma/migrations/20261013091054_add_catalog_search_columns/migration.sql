-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "minPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Sku" ADD COLUMN     "compareAtPrice" DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "Product_status_createdAt_id_idx" ON "Product"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Product_status_minPrice_id_idx" ON "Product"("status", "minPrice", "id");

-- Hand-written: Prisma cannot express a CHECK. The price before a discount is empty, or greater
-- than the selling price.
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_compareAtPrice_check"
  CHECK ("compareAtPrice" IS NULL OR "compareAtPrice" > "price");

-- Hand-written: the lowest price among the SKUs of the products that already exist. From now on
-- the repository keeps it up to date each time a product is saved.
UPDATE "Product" p
SET "minPrice" = (SELECT min(s."price") FROM "Sku" s WHERE s."productId" = p."id");
