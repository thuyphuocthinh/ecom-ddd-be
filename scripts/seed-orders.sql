-- Seeds 20 orders for ONE user, in every status, so the order screens (list, filters, counts, detail,
-- timeline, payments) have something to show. Safe to run again: orders that already exist are left alone.
--
-- Needs, in this order (the first lines of http/orders.http say how):
--   seed-administrative-units.sql, seed-catalog.sql, seed-stock.sql, and a user with at least one address.
--
-- Run it against the development database (the user id is the one of the account you log in with):
--   docker exec -i ecom_postgres psql -U root -d ecom_db -v user_id=2c728292-009d-4776-8682-2ffaa49e5e6e < scripts/seed-orders.sql
-- Without -v it uses the id written below.
--
-- What it writes, for each order that is new:
--   * the order and its lines (price, name and address are copied as they are now, like a real order)
--   * the payments of the ONLINE orders (INITIATED, SUCCEEDED, FAILED, EXPIRED, REFUNDED)
--   * the stock the order holds: RESERVED for open orders, CONFIRMED (and the warehouse number goes
--     down) for paid or shipped ones, RELEASED or RETURNED for cancelled and expired ones
--
-- Redis keeps its own number of what can be sold. After seeding, make it forget the numbers so it
-- rebuilds them from the tables above (onHand minus what is RESERVED):
--   docker exec ecom_redis sh -c "redis-cli --scan --pattern 'ecom:v1:inventory:v1:available:*' | xargs -r redis-cli DEL"
--
-- The two ONLINE orders that wait for payment (1 and 2) are only 3 and 6 minutes old, so their 15-minute
-- payment window is nearly over: pay or cancel them in the app before the background sweep expires them.
--
-- To start over (delete the seeded orders and what hangs on them; order lines go with the order):
--   DELETE FROM "Payment" WHERE "idempotencyKey" LIKE 'seed-pay-%';
--   DELETE FROM "Reservation" WHERE "orderId" IN (SELECT "id" FROM "Order" WHERE "idempotencyKey" LIKE 'seed-order-%');
--   DELETE FROM "Order" WHERE "idempotencyKey" LIKE 'seed-order-%';
-- The stock that paid orders took out does not come back by itself. Put the numbers back too:
--   UPDATE "SkuStock" SET "onHand" = CASE WHEN "skuId" = 'seed_sku_flash' THEN 10 ELSE 100 END;
--   (then the Redis command above)

\if :{?user_id}
\else
  \set user_id '2c728292-009d-4776-8682-2ffaa49e5e6e'
\endif

BEGIN;

-- Stop early, with a clear message, when something this script depends on is missing
CREATE TEMP TABLE _seed_user ON COMMIT DROP AS SELECT "id" FROM "User" WHERE "id" = :'user_id';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _seed_user) THEN
    RAISE EXCEPTION 'No user with that id. Pass the id of your account: -v user_id=<id>';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Sku" WHERE "id" = 'seed_sku_flash') THEN
    RAISE EXCEPTION 'The catalog is not seeded. Run scripts/seed-catalog.sql and scripts/seed-stock.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Address" WHERE "userId" IN (SELECT "id" FROM _seed_user)) THEN
    RAISE EXCEPTION 'That user has no address. Add one first (http/addresses.http)';
  END IF;
END $$;

-- The orders to make. age = how long ago it was placed. pay = the state of its payment (ONLINE only).
-- items = [[sku id, quantity], ...]. n = 1 is the newest, 20 the oldest.
CREATE TEMP TABLE _spec (n int, status text, method text, age interval, pay text, items jsonb) ON COMMIT DROP;
INSERT INTO _spec VALUES
  ( 1, 'PENDING',            'ONLINE', interval '3 minutes',  NULL,        '[["seed_sku_tshirt_m",2],["seed_sku_flash",1]]'),
  ( 2, 'PENDING',            'ONLINE', interval '6 minutes',  NULL,        '[["seed_sku_iphone15_256",1]]'),
  ( 3, 'PAYMENT_PROCESSING', 'ONLINE', interval '9 minutes',  'INITIATED', '[["seed_sku_dellxps",1]]'),
  ( 4, 'CONFIRMED',          'COD',    interval '2 hours',    NULL,        '[["seed_sku_tshirt_s",3]]'),
  ( 5, 'CONFIRMED',          'ONLINE', interval '5 hours',    'SUCCEEDED', '[["seed_sku_galaxy_256",1]]'),
  ( 6, 'CONFIRMED',          'ONLINE', interval '1 day',      'SUCCEEDED', '[["seed_sku_macbook_16",1],["seed_sku_tshirt_l",1]]'),
  ( 7, 'SHIPPING',           'ONLINE', interval '2 days',     'SUCCEEDED', '[["seed_sku_iphone15_512",1]]'),
  ( 8, 'SHIPPING',           'COD',    interval '3 days',     NULL,        '[["seed_sku_dellxps",1],["seed_sku_tshirt_m",2]]'),
  ( 9, 'CANCELLED',          'ONLINE', interval '4 days',     NULL,        '[["seed_sku_tshirt_l",2]]'),
  (10, 'EXPIRED',            'ONLINE', interval '5 days',     NULL,        '[["seed_sku_tshirt_s",2]]'),
  (11, 'DELIVERED',          'ONLINE', interval '6 days',     'SUCCEEDED', '[["seed_sku_galaxy_512",1]]'),
  (12, 'CANCELLED',          'ONLINE', interval '8 days',     'REFUNDED',  '[["seed_sku_galaxy_256",1]]'),
  (13, 'DELIVERED',          'COD',    interval '9 days',     NULL,        '[["seed_sku_tshirt_s",1],["seed_sku_tshirt_m",1],["seed_sku_tshirt_l",1]]'),
  (14, 'CANCELLED',          'COD',    interval '11 days',    NULL,        '[["seed_sku_dellxps",1]]'),
  (15, 'DELIVERED',          'ONLINE', interval '12 days',    'SUCCEEDED', '[["seed_sku_macbook_32",1]]'),
  (16, 'EXPIRED',            'ONLINE', interval '14 days',    'EXPIRED',   '[["seed_sku_flash",1]]'),
  (17, 'DELIVERED',          'COD',    interval '15 days',    NULL,        '[["seed_sku_flash",1]]'),
  (18, 'DELIVERED',          'ONLINE', interval '20 days',    'SUCCEEDED', '[["seed_sku_iphone15_256",2]]'),
  (19, 'DELIVERED',          'COD',    interval '28 days',    NULL,        '[["seed_sku_tshirt_m",4]]'),
  (20, 'DELIVERED',          'ONLINE', interval '35 days',    'SUCCEEDED', '[["seed_sku_iphone15_256",1],["seed_sku_tshirt_s",2],["seed_sku_tshirt_m",1],["seed_sku_tshirt_l",1],["seed_sku_galaxy_256",1]]');

-- Only the orders that do not exist yet, with their id, lines and timeline worked out
CREATE TEMP TABLE _todo ON COMMIT DROP AS
SELECT
  md5('seed_order_' || :'user_id' || '_' || s.n)::uuid::text AS id,
  s.*,
  (now() AT TIME ZONE 'UTC') - s.age AS created_at,
  -- ONLINE orders have 15 minutes to be paid; a COD order never waits
  (now() AT TIME ZONE 'UTC') - s.age + interval '15 minutes' AS expires_at,
  -- the moments in the life of the order, by the database clock, in the same order as the real flow
  CASE WHEN s.status IN ('CONFIRMED','SHIPPING','DELIVERED')
         OR (s.status = 'CANCELLED' AND (s.method = 'COD' OR s.pay = 'REFUNDED'))
       THEN (now() AT TIME ZONE 'UTC') - s.age + CASE WHEN s.method = 'COD' THEN interval '1 second' ELSE interval '8 minutes' END
  END AS confirmed_at
FROM _spec s
WHERE NOT EXISTS (
  SELECT 1 FROM "Order" o
  WHERE o."userId" = :'user_id' AND o."idempotencyKey" = 'seed-order-' || lpad(s.n::text, 2, '0')
);

-- The address to copy into each order: the user's addresses in turn, default one first
CREATE TEMP TABLE _addr ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY "isDefault" DESC, "id") AS rn, a.*
FROM "Address" a WHERE a."userId" = :'user_id';

-- Lines: the price, name, picture and attributes of the SKU as they are now
CREATE TEMP TABLE _lines ON COMMIT DROP AS
SELECT t.id AS order_id, t.n, row_number() OVER (PARTITION BY t.n ORDER BY l.ord) AS line_no,
       l.sku_id, l.qty, s."price", p."name", p."thumbnail", s."attributes"
FROM _todo t
CROSS JOIN LATERAL (
  SELECT (e.value ->> 0) AS sku_id, (e.value ->> 1)::int AS qty, e.ord
  FROM jsonb_array_elements(t.items) WITH ORDINALITY AS e(value, ord)
) l
JOIN "Sku" s ON s."id" = l.sku_id
JOIN "Product" p ON p."id" = s."productId";

CREATE TEMP TABLE _totals ON COMMIT DROP AS
SELECT order_id, sum("price" * qty) AS total FROM _lines GROUP BY order_id;

INSERT INTO "Order" ("id", "userId", "idempotencyKey", "paymentMethod", "status", "version", "stockReturnPending", "total",
                     "shippingAddress", "expiresAt", "confirmedAt", "shippedAt", "deliveredAt", "cancelledAt", "expiredAt",
                     "createdAt", "updatedAt")
SELECT
  t.id,
  :'user_id',
  'seed-order-' || lpad(t.n::text, 2, '0'),
  t.method::"PaymentMethod",
  t.status::"OrderStatus",
  CASE t.status WHEN 'PENDING' THEN 1 WHEN 'PAYMENT_PROCESSING' THEN 2 WHEN 'CONFIRMED' THEN 3
                WHEN 'SHIPPING' THEN 4 WHEN 'DELIVERED' THEN 5 ELSE 3 END,
  false,
  tt.total,
  jsonb_build_object('recipientName', a."recipientName", 'phone', a."phone", 'provinceCode', a."provinceCode",
                     'provinceName', a."provinceName", 'wardCode', a."wardCode", 'wardName', a."wardName",
                     'street', a."street", 'label', a."label"),
  t.expires_at,
  t.confirmed_at,
  CASE WHEN t.status IN ('SHIPPING','DELIVERED') THEN t.confirmed_at + interval '1 day' END,
  CASE WHEN t.status = 'DELIVERED' THEN t.confirmed_at + interval '3 days' END,
  CASE WHEN t.status = 'CANCELLED' THEN COALESCE(t.confirmed_at, t.created_at) + interval '3 hours' END,
  CASE WHEN t.status = 'EXPIRED' THEN t.expires_at END,
  t.created_at,
  -- last change: the newest moment of its timeline
  GREATEST(
    t.created_at,
    t.confirmed_at,
    CASE WHEN t.status IN ('SHIPPING','DELIVERED') THEN t.confirmed_at + interval '1 day' END,
    CASE WHEN t.status = 'DELIVERED' THEN t.confirmed_at + interval '3 days' END,
    CASE WHEN t.status = 'CANCELLED' THEN COALESCE(t.confirmed_at, t.created_at) + interval '3 hours' END,
    CASE WHEN t.status = 'EXPIRED' THEN t.expires_at END,
    -- a payment that is still being processed has been for a few minutes
    CASE WHEN t.status = 'PAYMENT_PROCESSING' THEN t.created_at + interval '1 minute' END
  )
FROM _todo t
JOIN _totals tt ON tt.order_id = t.id
JOIN _addr a ON a.rn = 1 + (t.n % (SELECT count(*) FROM _addr));

INSERT INTO "OrderItem" ("id", "orderId", "skuId", "productName", "thumbnail", "attributes", "unitPrice", "quantity", "lineTotal")
SELECT md5('seed_item_' || l.order_id || '_' || l.line_no)::uuid::text, l.order_id, l.sku_id, l."name", l."thumbnail",
       l."attributes", l."price", l.qty, l."price" * l.qty
FROM _lines l;

-- Payments of the ONLINE orders. Order 5 had a failed try before the one that worked.
INSERT INTO "Payment" ("id", "orderId", "idempotencyKey", "provider", "providerRef", "status", "amount", "paidAmount",
                       "payUrl", "expiresAt", "version", "createdAt", "updatedAt")
SELECT md5('seed_pay_' || t.id || '_' || x.try)::uuid::text,
       t.id,
       'seed-pay-' || lpad(t.n::text, 2, '0') || '-' || x.try,
       'fake',
       'seed_ch_' || lpad(t.n::text, 2, '0') || '_' || x.try,
       x.status::"PaymentStatus",
       tt.total,
       CASE WHEN x.status IN ('SUCCEEDED','REFUNDED') THEN tt.total END,
       CASE WHEN x.status = 'INITIATED' THEN '/dev/fake-gateway/charges/seed_ch_' || lpad(t.n::text, 2, '0') || '_' || x.try END,
       t.created_at + interval '30 seconds' + interval '15 minutes',
       CASE WHEN x.status = 'INITIATED' THEN 1 ELSE 2 END,
       t.created_at + interval '30 seconds' + x.try * interval '1 minute',
       t.created_at + interval '30 seconds' + x.try * interval '1 minute' + interval '3 minutes'
FROM _todo t
JOIN _totals tt ON tt.order_id = t.id
CROSS JOIN LATERAL (
  SELECT 1 AS try, 'FAILED' AS status WHERE t.n = 5
  UNION ALL
  SELECT CASE WHEN t.n = 5 THEN 2 ELSE 1 END, t.pay WHERE t.pay IS NOT NULL
) x
WHERE t.method = 'ONLINE';

-- What each order does to the stock
INSERT INTO "Reservation" ("id", "orderId", "skuId", "qty", "status", "expiresAt", "createdAt", "updatedAt")
SELECT md5('seed_hold_' || l.order_id || '_' || l.sku_id)::uuid::text,
       l.order_id, l.sku_id, l.qty,
       (CASE
          WHEN t.status IN ('PENDING','PAYMENT_PROCESSING') THEN 'RESERVED'
          WHEN t.status IN ('CONFIRMED','SHIPPING','DELIVERED') THEN 'CONFIRMED'
          WHEN t.status = 'CANCELLED' AND (t.method = 'COD' OR t.pay = 'REFUNDED') THEN 'RETURNED'
          ELSE 'RELEASED'
        END)::"ReservationStatus",
       t.expires_at, t.created_at, t.created_at
FROM _lines l JOIN _todo t ON t.id = l.order_id;

-- Paid, confirmed and shipped orders took their goods out of the warehouse
UPDATE "SkuStock" st
SET "onHand" = GREATEST(st."onHand" - q.qty, 0), "updatedAt" = (now() AT TIME ZONE 'UTC')
FROM (
  SELECT l.sku_id, sum(l.qty) AS qty
  FROM _lines l JOIN _todo t ON t.id = l.order_id
  WHERE t.status IN ('CONFIRMED','SHIPPING','DELIVERED')
  GROUP BY l.sku_id
) q
WHERE st."skuId" = q.sku_id;

-- The name and picture of the lines follow the products (also repairs orders seeded before the products
-- had Vietnamese names and pictures)
UPDATE "OrderItem" oi
SET "thumbnail" = p."thumbnail", "productName" = p."name"
FROM "Sku" s JOIN "Product" p ON p."id" = s."productId"
WHERE s."id" = oi."skuId"
  AND oi."orderId" IN (SELECT "id" FROM "Order" WHERE "userId" = :'user_id' AND "idempotencyKey" LIKE 'seed-order-%')
  AND (oi."thumbnail" IS DISTINCT FROM p."thumbnail" OR oi."productName" IS DISTINCT FROM p."name");

COMMIT;

-- What the user has now
SELECT "status", "paymentMethod", count(*) AS orders, sum("total") AS total
FROM "Order" WHERE "userId" = :'user_id'
GROUP BY "status", "paymentMethod" ORDER BY "status", "paymentMethod";
