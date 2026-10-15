import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  IProductRepository,
  Product,
  CatalogDomainException,
} from '../../../domain/index.js';
import {
  PrismaService,
  PaginatedResult,
  PagedResult,
  toCursorPage,
  toPage,
  CatalogErrorCodes,
  RedisService,
  CACHE,
  TTL,
} from '@/core/index.js';
import {
  FindProductsParams,
  SkuLookupItem,
} from '../../../domain/repositories/catalog.repository.js';
import {
  COUNT_CEILING,
  MAX_RESULT_WINDOW,
  type CategoryProductCount,
  type ProductSearchFilters,
  type ProductSort,
  type SearchProductsByCursorParams,
  type SearchProductsByPageParams,
} from '../../../domain/product-search.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';

// Times in the database are UTC wall time without a time zone; a moment given as text with its
// zone is turned into that wall time to be compared with them.
const asUtcWallTime = (moment: Date) =>
  Prisma.sql`(${moment.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * Every sort is a FIXED piece of SQL chosen here by name: nothing a client sent is ever pasted
 * into the query, only passed as a parameter. Ties are broken by id, so a page never repeats or
 * skips a product.
 */
const orderBy = (sort: ProductSort, search?: string): Prisma.Sql => {
  switch (sort) {
    case 'price_asc':
      return Prisma.sql`p."minPrice" ASC NULLS LAST, p."id" ASC`;
    case 'price_desc':
      return Prisma.sql`p."minPrice" DESC NULLS LAST, p."id" DESC`;
    case 'relevance':
      return Prisma.sql`ts_rank(p."searchVector", plainto_tsquery('simple', ${search})) DESC, p."id" DESC`;
    default:
      return Prisma.sql`p."createdAt" DESC, p."id" DESC`;
  }
};

/**
 * The conditions of a public search, all joined with AND, on a product called `p`. Only PUBLISHED
 * products are ever here, whatever the filters say.
 */
function searchConditions(filters: ProductSearchFilters): Prisma.Sql[] {
  const { categoryPath, search, minPrice, maxPrice, inStock, onSale } = filters;
  const conditions: Prisma.Sql[] = [Prisma.sql`p."status" = 'PUBLISHED'`];
  if (categoryPath) {
    // Every category path ends with `/`, so `/10/` matches `/10/20/` but not `/100/`
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Category" c WHERE c."id" = p."categoryId" AND starts_with(c."path", ${categoryPath}))`,
    );
  }
  if (search) {
    conditions.push(
      Prisma.sql`p."searchVector" @@ plainto_tsquery('simple', ${search})`,
    );
  }
  if (minPrice !== undefined || maxPrice !== undefined) {
    const range = [
      ...(minPrice !== undefined
        ? [Prisma.sql`s."price" >= ${minPrice}::numeric`]
        : []),
      ...(maxPrice !== undefined
        ? [Prisma.sql`s."price" <= ${maxPrice}::numeric`]
        : []),
    ];
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Sku" s WHERE s."productId" = p."id" AND ${Prisma.join(range, ' AND ')})`,
    );
  }
  if (inStock) {
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Sku" s JOIN "SkuStock" t ON t."skuId" = s."id" WHERE s."productId" = p."id" AND t."onHand" > 0)`,
    );
  }
  if (onSale) {
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Sku" s WHERE s."productId" = p."id" AND s."compareAtPrice" IS NOT NULL)`,
    );
  }
  return conditions;
}

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  private readonly logger = new Logger(PrismaProductRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findById(id: string): Promise<Product | null> {
    const cached = await this.redis.getOrSetNullableDetail(
      CACHE.CATALOG.KEYS.PRODUCT_DETAIL(id),
      TTL.SHORT,
      async () => {
        this.logger.debug(`Finding product by ID: ${id}`);
        // Luôn load kèm SKU để tạo thành 1 Aggregate Root hoàn chỉnh
        return this.prisma.product.findUnique({
          where: { id },
          include: { skus: true },
        });
      },
    );

    // The cache stores the raw Prisma row (JSON-safe), never the domain
    // entity itself, so every read — cache hit or miss — maps it fresh.
    return cached ? CatalogMapper.toProductDomain(cached) : null;
  }

  async findByIdOrSlug(identifier: string): Promise<Product | null> {
    const cached = await this.redis.getOrSetNullableDetail(
      CACHE.CATALOG.KEYS.PRODUCT_DETAIL(identifier),
      TTL.SHORT,
      async () => {
        this.logger.debug(`Finding product by ID or Slug: ${identifier}`);
        const byId = await this.prisma.product.findUnique({
          where: { id: identifier },
          include: { skus: true },
        });
        if (byId) return byId;

        return this.prisma.product.findUnique({
          where: { slug: identifier },
          include: { skus: true },
        });
      },
    );

    return cached ? CatalogMapper.toProductDomain(cached) : null;
  }

  async findSitemapData(): Promise<Array<{ slug: string; updatedAt: Date }>> {
    const products = await this.prisma.product.findMany({
      where: {
        status: 'PUBLISHED',
        slug: { not: null },
      },
      select: {
        slug: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    });

    return products.map((p) => ({
      slug: p.slug!,
      updatedAt: p.updatedAt,
    }));
  }

  async save(product: Product): Promise<void> {
    this.logger.debug(`Saving product: ${product.id}`);
    const productData = CatalogMapper.toProductPersistence(product);
    const { id, version, ...updateFields } = productData;
    const skusData = product
      .getProps()
      .skus.map((sku) => CatalogMapper.toSkuPersistence(sku));

    await this.prisma.$transaction(async (tx) => {
      // 1. Optimistic-concurrency update: only succeeds if the row is still
      // at the version this aggregate was loaded from.
      const updateResult = await tx.product.updateMany({
        where: { id, version },
        data: { ...updateFields, version: { increment: 1 } },
      });

      if (updateResult.count === 0) {
        const existing = await tx.product.findUnique({
          where: { id },
          select: { id: true },
        });

        if (existing) {
          // Row exists but the version didn't match: another request
          // already saved a newer version between our read and this write.
          throw new CatalogDomainException(
            CatalogErrorCodes.CONCURRENCY_CONFLICT,
          );
        }

        // Row doesn't exist yet — this is the first save for this aggregate.
        await tx.product.create({ data: productData });
      }

      // 2. Fetch existing SKUs to tell creates from updates
      const existingSkus = await tx.sku.findMany({
        where: { productId: product.id },
        select: { id: true },
      });
      const existingSkuIds = existingSkus.map((s) => s.id);

      const skusToCreate = skusData.filter(
        (s) => !existingSkuIds.includes(s.id),
      );
      const skusToUpdate = skusData.filter((s) =>
        existingSkuIds.includes(s.id),
      );

      // 3. Apply SKU diffs.
      // Deletions use the aggregate's explicit removedSkuIds instead of
      // "existing in DB but absent from this in-memory snapshot" — otherwise
      // a SKU added by a concurrent request after this product was loaded
      // would look identical to a removed one and get deleted here too.
      const skusToDelete = product.removedSkuIds.filter((id) =>
        existingSkuIds.includes(id),
      );
      if (skusToDelete.length > 0) {
        try {
          await tx.sku.deleteMany({
            where: { id: { in: skusToDelete } },
          });
        } catch (error) {
          // Inventory's reservations point at the SKU with ON DELETE RESTRICT, so a SKU that was
          // ever held for an order cannot be deleted. The database decides (there is no gap
          // between a check and the delete), and catalog does not need to know inventory.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2003'
          ) {
            throw new CatalogDomainException(
              CatalogErrorCodes.SKU_HAS_RESERVATIONS,
            );
          }
          throw error;
        }
      }

      if (skusToCreate.length > 0) {
        await tx.sku.createMany({
          data: skusToCreate as Prisma.SkuCreateManyInput[],
        });
      }

      for (const sku of skusToUpdate) {
        await tx.sku.update({
          where: { id: sku.id },
          data: sku as Prisma.SkuUpdateInput,
        });
      }

      // Lưu Outbox Pattern Event nếu có (VD: ProductCreatedEvent)
      // Sẽ implement Outbox entity sau.
    });

    await this.redis.invalidateDetail(
      CACHE.CATALOG.KEYS.PRODUCT_DETAIL(product.id),
    );
    if (product.slug) {
      await this.redis.invalidateDetail(
        CACHE.CATALOG.KEYS.PRODUCT_DETAIL(product.slug),
      );
    }
  }

  async findSkusByIds(skuIds: string[]): Promise<SkuLookupItem[]> {
    if (skuIds.length === 0) return [];
    const rows = await this.prisma.sku.findMany({
      where: { id: { in: skuIds } },
      select: {
        id: true,
        productId: true,
        price: true,
        attributes: true,
        product: { select: { name: true, thumbnail: true, status: true } },
      },
    });
    return rows.map((row) => ({
      skuId: row.id,
      productId: row.productId,
      productName: row.product.name,
      thumbnail: row.product.thumbnail,
      attributes: row.attributes as Record<string, string>,
      price: Number(row.price),
      published: row.product.status === 'PUBLISHED',
    }));
  }

  async findList(
    params: FindProductsParams,
  ): Promise<PaginatedResult<Product>> {
    const { limit, cursor, categoryPath, search, status, minPrice, maxPrice } =
      params;
    this.logger.debug(
      `Finding product list (limit: ${limit}, cursor: ${cursor}, search: ${search}, categoryPath: ${categoryPath})`,
    );
    const take = limit + 1; // Limit + 1 trick

    const where: Prisma.ProductWhereInput = {};

    if (categoryPath) {
      // Every category path ends with `/`, so `/10/` matches `/10/20/` but not
      // `/100/`: the product's category is the chosen one or lies below it.
      // `startsWith` becomes `LIKE 'path%'` without escaping `_` or `%`; that is
      // safe because category ids are server-made Snowflake numbers, so a path
      // only ever holds digits and `/`.
      where.category = { path: { startsWith: categoryPath } };
    }

    if (search) {
      // Full-text match against the generated `searchVector` column + GIN
      // index (created by the baseline migration, see prisma/migrations)
      // instead of `contains`/ILIKE, which can't use an index and doesn't
      // scale past a small catalog. Prisma only knows this column as
      // Unsupported (it can't query it), so the set of matching ids is
      // fetched via raw SQL and intersected with the rest of the normal
      // Prisma-driven filters/pagination below.
      const matches = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Product"
        WHERE "searchVector" @@ plainto_tsquery('simple', ${search});
      `;
      where.id = { in: matches.map((m) => m.id) };
    }

    if (status) {
      where.status = status;
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.skus = {
        some: {
          price: {
            ...(minPrice !== undefined && { gte: minPrice }),
            ...(maxPrice !== undefined && { lte: maxPrice }),
          },
        },
      };
    }

    const products = await this.prisma.product.findMany({
      take,
      skip: cursor ? 1 : 0, // Bỏ qua phần tử cursor hiện tại
      cursor: cursor ? { id: cursor } : undefined,
      where,
      include: { skus: true },
      orderBy: { id: 'asc' }, // Keyset pagination luôn cần order by index
    });

    const page = toCursorPage(products, limit, (p) => p.id);
    return {
      data: page.data.map((p) => CatalogMapper.toProductDomain(p)),
      meta: page.meta,
    };
  }

  async searchByCursor(
    params: SearchProductsByCursorParams,
  ): Promise<PaginatedResult<Product>> {
    const { limit, cursor } = params;
    const conditions = searchConditions(params);

    if (cursor !== undefined) {
      // The list is newest first, so the next page is everything older than the cursor's product
      const anchor = await this.prisma.product.findUnique({
        where: { id: cursor },
        select: { id: true, createdAt: true },
      });
      if (!anchor) {
        throw new CatalogDomainException(
          CatalogErrorCodes.INVALID_SEARCH_REQUEST,
          'cursor is not a product',
        );
      }
      conditions.push(
        Prisma.sql`(p."createdAt", p."id") < (${asUtcWallTime(anchor.createdAt)}, ${anchor.id})`,
      );
    }

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p."id" FROM "Product" p
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${orderBy('newest')}
      LIMIT ${limit + 1}`;
    const page = toCursorPage(rows, limit, (row) => row.id);
    return {
      data: await this.loadInOrder(page.data.map((row) => row.id)),
      meta: page.meta,
    };
  }

  async searchByPage(
    params: SearchProductsByPageParams,
  ): Promise<PagedResult<Product>> {
    const { limit, page, sort, search } = params;
    if (page * limit > MAX_RESULT_WINDOW) {
      // The caller checks this too; the repository does not rely on it, because this bound is
      // what keeps the cost of OFFSET small
      throw new CatalogDomainException(
        CatalogErrorCodes.INVALID_SEARCH_REQUEST,
        'page is beyond the results that can be read',
      );
    }
    const where = Prisma.join(searchConditions(params), ' AND ');

    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "Product" p
        WHERE ${where}
        ORDER BY ${orderBy(sort, search)}
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      // Counted up to one row past the window and no further, however many products match
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM (
          SELECT 1 FROM "Product" p WHERE ${where} LIMIT ${COUNT_CEILING}
        ) t`,
    ]);
    const n = counted[0]?.n ?? 0;
    return toPage(await this.loadInOrder(rows.map((row) => row.id)), {
      page,
      limit,
      total: Math.min(n, MAX_RESULT_WINDOW),
      totalCapped: n > MAX_RESULT_WINDOW,
    });
  }

  async findInStockSkuIds(skuIds: string[]): Promise<Set<string>> {
    if (skuIds.length === 0) return new Set();
    const rows = await this.prisma.skuStock.findMany({
      where: { skuId: { in: skuIds }, onHand: { gt: 0 } },
      select: { skuId: true },
    });
    return new Set(rows.map((row) => row.skuId));
  }

  async countByChildCategory(
    parentId: string | null,
    filters: Omit<ProductSearchFilters, 'categoryPath'>,
  ): Promise<CategoryProductCount[]> {
    const on = Prisma.join(searchConditions(filters), ' AND ');
    // Each child category, joined to itself and every category below it (by path), joined to
    // their products inside the filters: one grouped query for all the counts
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; count: number }[]
    >`
      SELECT c."id", c."name", count(p."id")::int AS "count"
      FROM "Category" c
      LEFT JOIN "Category" d ON starts_with(d."path", c."path")
      LEFT JOIN "Product" p ON p."categoryId" = d."id" AND ${on}
      WHERE c."parentId" IS NOT DISTINCT FROM ${parentId}::text
      GROUP BY c."id", c."name"
      ORDER BY c."name" ASC, c."id" ASC`;
    return rows.map((row) => ({
      categoryId: row.id,
      name: row.name,
      count: row.count,
    }));
  }

  /** The products with these ids, with their SKUs, in the order the ids are given. */
  private async loadInOrder(ids: string[]): Promise<Product[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      include: { skus: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((row) => CatalogMapper.toProductDomain(row));
  }
}
