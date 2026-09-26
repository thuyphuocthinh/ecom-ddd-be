-- Adds a generated tsvector column + GIN index for full-text search on
-- Product.name/description. Hand-written (not `prisma migrate dev`
-- generated) because Prisma's schema DSL can't express a generated column —
-- see the note above the Product model in schema.prisma. Applied through
-- the normal migration flow (`prisma migrate deploy` / `migrate dev`) like
-- any other migration.

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("description", ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS "Product_searchVector_idx"
  ON "Product" USING GIN ("searchVector");
