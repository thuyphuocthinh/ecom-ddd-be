import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IProductRepository, Product } from '../../../domain/index.js';
import { PrismaService, PaginatedResult } from '@/core/index.js';
import { FindProductsParams } from '../../../domain/repositories/catalog.repository.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  private readonly logger = new Logger(PrismaProductRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Product | null> {
    this.logger.debug(`Finding product by ID: ${id}`);
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { skus: true }, // Luôn load kèm SKU để tạo thành 1 Aggregate Root hoàn chỉnh
    });

    if (!product) return null;
    return CatalogMapper.toProductDomain(product);
  }

  async save(product: Product): Promise<void> {
    this.logger.debug(`Saving product: ${product.id}`);
    const productData = CatalogMapper.toProductPersistence(product);
    const skusData = product
      .getProps()
      .skus.map((sku) => CatalogMapper.toSkuPersistence(sku));

    await this.prisma.$transaction(async (tx) => {
      // 1. Upsert Product
      await tx.product.upsert({
        where: { id: productData.id },
        create: productData,
        update: productData,
      });

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
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
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
