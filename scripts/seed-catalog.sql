-- Seeds a small catalog: categories, products and SKUs, so the storefront and the stock tests have
-- something to work with. Safe to run again: rows that already exist are left alone.
--
-- Run it against the development database, THEN seed-stock.sql (stock needs the SKUs to exist):
--   docker exec -i ecom_postgres psql -U root -d ecom_db < scripts/seed-catalog.sql
--   docker exec -i ecom_postgres psql -U root -d ecom_db < scripts/seed-stock.sql
--
-- Ids are readable on purpose ("seed_..."), so they are easy to type in tests and curl calls.
-- Prices are in VND. "Product"."searchVector" fills itself, so full-text search works at once.
--
--   Electronics
--     Phones   : iPhone 15 (2 SKUs), Galaxy S24 (2 SKUs), AirPods Flash Sale (1 SKU, only 10 in stock)
--     Laptops  : MacBook Pro 14 (2 SKUs), Dell XPS 13 (1 SKU)
--     (a DRAFT smart watch, which customers must not see)
--   Fashion
--     T-shirts : Cotton T-shirt (3 SKUs)
--
-- On top of those hand-picked rows, the last part generates 3,000 more products (5% of them DRAFT)
-- with 2 SKUs each, spread over the leaf categories, so lists, search and the stock tests have a few
-- thousand rows to work on. Change 3000 in the last two statements for a different amount.

INSERT INTO "Category" ("id", "parentId", "name", "path", "isActive", "createdAt", "updatedAt")
VALUES
  ('seed_cat_electronics', NULL,                   'Electronics', '/seed_cat_electronics/',                        true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_cat_phones',      'seed_cat_electronics', 'Phones',      '/seed_cat_electronics/seed_cat_phones/',        true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_cat_laptops',     'seed_cat_electronics', 'Laptops',     '/seed_cat_electronics/seed_cat_laptops/',       true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_cat_fashion',     NULL,                   'Fashion',     '/seed_cat_fashion/',                            true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_cat_tshirts',     'seed_cat_fashion',     'T-shirts',    '/seed_cat_fashion/seed_cat_tshirts/',           true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Product" ("id", "categoryId", "name", "description", "thumbnail", "status", "version", "createdAt", "updatedAt")
VALUES
  ('seed_prod_iphone15',    'seed_cat_phones',      'iPhone 15',          'Apple smartphone, titanium frame, 48MP camera',      'https://example.com/img/iphone15.jpg',   'PUBLISHED', 1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_prod_galaxy_s24',  'seed_cat_phones',      'Samsung Galaxy S24', 'Samsung smartphone with a bright 120Hz display',     'https://example.com/img/galaxy-s24.jpg', 'PUBLISHED', 1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_prod_airpods',     'seed_cat_phones',      'AirPods Flash Sale', 'Wireless earbuds. Limited offer: only 10 in stock',  'https://example.com/img/airpods.jpg',    'PUBLISHED', 1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_prod_macbook',     'seed_cat_laptops',     'MacBook Pro 14',     'Apple laptop with the M3 chip for work and play',    'https://example.com/img/macbook.jpg',    'PUBLISHED', 1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_prod_dellxps',     'seed_cat_laptops',     'Dell XPS 13',        'Light Windows laptop with a 13 inch screen',         'https://example.com/img/dellxps.jpg',    'PUBLISHED', 1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_prod_tshirt',      'seed_cat_tshirts',     'Cotton T-shirt',     'Soft 100% cotton round-neck t-shirt',                'https://example.com/img/tshirt.jpg',     'PUBLISHED', 1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_prod_draft_watch', 'seed_cat_electronics', 'Smart Watch (draft)','Not on sale yet: customers must not see this one', NULL,                                     'DRAFT',     1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Sku" ("id", "productId", "price", "attributes", "skuCode", "barcode", "createdAt", "updatedAt")
VALUES
  ('seed_sku_iphone15_256',  'seed_prod_iphone15',    22990000.00, '{"storage": "256GB", "color": "Titan"}',  'IPH15-256-TIT',   '8930000000011', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_iphone15_512',  'seed_prod_iphone15',    28990000.00, '{"storage": "512GB", "color": "Titan"}',  'IPH15-512-TIT',   '8930000000012', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_galaxy_256',    'seed_prod_galaxy_s24',  21990000.00, '{"storage": "256GB", "color": "Black"}',  'S24-256-BLK',     '8930000000021', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_galaxy_512',    'seed_prod_galaxy_s24',  25990000.00, '{"storage": "512GB", "color": "Black"}',  'S24-512-BLK',     '8930000000022', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_flash',         'seed_prod_airpods',      3990000.00, '{"color": "White"}',                      'AIRPODS-FLASH',   '8930000000031', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_macbook_16',    'seed_prod_macbook',     49990000.00, '{"ram": "16GB", "ssd": "512GB"}',          'MBP14-16-512',    '8930000000041', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_macbook_32',    'seed_prod_macbook',     59990000.00, '{"ram": "32GB", "ssd": "1TB"}',            'MBP14-32-1TB',    '8930000000042', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_dellxps',       'seed_prod_dellxps',     32990000.00, '{"ram": "16GB", "ssd": "512GB"}',          'XPS13-16-512',    '8930000000051', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_tshirt_s',      'seed_prod_tshirt',        199000.00, '{"size": "S", "color": "White"}',         'TSHIRT-WHT-S',    '8930000000061', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_tshirt_m',      'seed_prod_tshirt',        199000.00, '{"size": "M", "color": "White"}',         'TSHIRT-WHT-M',    '8930000000062', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_tshirt_l',      'seed_prod_tshirt',        199000.00, '{"size": "L", "color": "White"}',         'TSHIRT-WHT-L',    '8930000000063', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_sku_draft_watch',   'seed_prod_draft_watch',  5990000.00, '{"color": "Black"}',                      'WATCH-DRAFT-BLK', '8930000000071', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;

-- Extra leaf categories to spread the generated products over.
INSERT INTO "Category" ("id", "parentId", "name", "path", "isActive", "createdAt", "updatedAt")
VALUES
  ('seed_cat_shoes', 'seed_cat_fashion', 'Shoes', '/seed_cat_fashion/seed_cat_shoes/', true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_cat_home',  NULL,               'Home',  '/seed_cat_home/',                   true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')),
  ('seed_cat_books', NULL,               'Books', '/seed_cat_books/',                  true, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;

-- 3,000 generated products: ids seed_prod_gen_00001 ... seed_prod_gen_03000.
INSERT INTO "Product" ("id", "categoryId", "name", "description", "thumbnail", "status", "version", "createdAt", "updatedAt")
SELECT 'seed_prod_gen_' || lpad(n::text, 5, '0'),
       (ARRAY['seed_cat_phones','seed_cat_laptops','seed_cat_tshirts','seed_cat_shoes','seed_cat_home','seed_cat_books'])[1 + n % 6],
       (ARRAY['Classic','Modern','Compact','Premium','Everyday','Pro','Lite','Ultra'])[1 + n % 8]
         || ' ' || (ARRAY['Phone','Laptop','T-shirt','Sneaker','Lamp','Novel'])[1 + n % 6]
         || ' #' || n,
       'Generated product number ' || n || ' for load and search tests',
       'https://example.com/img/gen-' || n || '.jpg',
       CASE WHEN n % 20 = 0 THEN 'DRAFT'::"ProductStatus" ELSE 'PUBLISHED'::"ProductStatus" END,
       1, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM generate_series(1, 3000) AS n
ON CONFLICT ("id") DO NOTHING;

-- 2 SKUs per generated product (variant A and B): seed_sku_gen_00001_a ... seed_sku_gen_03000_b.
INSERT INTO "Sku" ("id", "productId", "price", "attributes", "skuCode", "barcode", "createdAt", "updatedAt")
SELECT 'seed_sku_gen_' || lpad(n::text, 5, '0') || '_' || v,
       'seed_prod_gen_' || lpad(n::text, 5, '0'),
       (100 + (n * 7919) % 9900) * 1000 + CASE WHEN v = 'b' THEN 50000 ELSE 0 END,
       jsonb_build_object('variant', upper(v)),
       'GEN-' || lpad(n::text, 5, '0') || '-' || upper(v),
       '894' || lpad(n::text, 6, '0') || CASE WHEN v = 'a' THEN '1' ELSE '2' END,
       (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM generate_series(1, 3000) AS n, (VALUES ('a'), ('b')) AS variants(v)
ON CONFLICT ("id") DO NOTHING;
