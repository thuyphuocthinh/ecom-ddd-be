-- Puts stock in the warehouse so SKUs can be sold. Run seed-catalog.sql first (the SKUs must exist).
-- Safe to run again: SKUs that already have a stock row are left alone.
--
-- Run it against the development database:
--   docker exec -i ecom_postgres psql -U root -d ecom_db < scripts/seed-stock.sql
--
--   * the flash-sale SKU (seed_sku_flash) gets only 10 units: the item that many buyers fight over
--   * every other SKU gets 100 units; change the number below to seed another amount
--
-- Only for SKUs that were never sold or looked at: Redis keeps its own number of what can be sold,
-- built from this table the first time a SKU is needed. To change the stock of a SKU that already has
-- a number in Redis, edit "SkuStock" and then make Redis forget that SKU so it is rebuilt:
--   docker exec ecom_redis redis-cli DEL ecom:v1:inventory:v1:available:<skuId>
INSERT INTO "SkuStock" ("skuId", "onHand", "createdAt", "updatedAt")
SELECT "id",
       CASE WHEN "id" = 'seed_sku_flash' THEN 10 ELSE 100 END,
       (now() AT TIME ZONE 'UTC'),
       (now() AT TIME ZONE 'UTC')
FROM "Sku"
ON CONFLICT ("skuId") DO NOTHING;
