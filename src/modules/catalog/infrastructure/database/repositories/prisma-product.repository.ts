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
  CatalogErrorCodes,
  RedisService,
  CACHE,
  TTL,
} from '@/core/index.js';
import { FindProductsParams } from '../../../domain/repositories/catalog.repository.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';

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
        await tx.sku.deleteMany({
          where: { id: { in: skusToDelete } },
        });
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
  }

  async findList(
    params: FindProductsParams,
  ): Promise<PaginatedResult<Product>> {
    const { limit, cursor, categoryId, search, status, minPrice, maxPrice } =
      params;
    this.logger.debug(
      `Finding product list (limit: ${limit}, cursor: ${cursor}, search: ${search}, categoryId: ${categoryId})`,
    );
    const take = limit + 1; // Limit + 1 trick

    const where: Prisma.ProductWhereInput = {};

    if (categoryId) {
      where.categoryId = categoryId;
    }

    if (search) {
      // Full-text match against the generated `searchVector` column + GIN
      // index (prisma/sql/add_product_search_vector.sql) instead of
      // `contains`/ILIKE, which can't use an index and doesn't scale past
      // a small catalog. Prisma can't express this column, so the set of
      // matching ids is fetched via raw SQL and intersected with the rest
      // of the normal Prisma-driven filters/pagination below.
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

    const hasMore = products.length > limit;
    if (hasMore) {
      products.pop(); // Remove the extra item
    }

    const nextCursor =
      hasMore && products.length > 0 ? products[products.length - 1].id : null;

    return {
      data: products.map((p) => CatalogMapper.toProductDomain(p)),
      meta: {
        hasMore,
        nextCursor,
      },
    };
  }
}
