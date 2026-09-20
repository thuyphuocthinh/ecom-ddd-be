import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IProductRepository, Product } from '../../../domain/index.js';
import { PrismaService, PaginatedResult } from '@/core/index.js';
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

    // Dùng Transaction để lưu cả SPU (Product) và các SKU cùng lúc
    await this.prisma.$transaction(async (tx) => {
      // 1. Upsert Product
      await tx.product.upsert({
        where: { id: productData.id },
        create: productData,
        update: productData,
      });

      // 2. Đồng bộ SKUs (Xóa SKU cũ không còn trong danh sách và upsert SKU mới)
      // Để an toàn, xóa tất cả SKU cũ của product này rồi insert lại
      // (Trong thực tế có thể dùng logic update từng cái để tối ưu hơn)
      await tx.sku.deleteMany({
        where: { productId: product.id },
      });

      if (skusData.length > 0) {
        await tx.sku.createMany({
          data: skusData as Prisma.SkuCreateManyInput[],
        });
      }

      // Lưu Outbox Pattern Event nếu có (VD: ProductCreatedEvent)
      // Sẽ implement Outbox entity sau.
    });
  }

  async findList(
    cursor?: string,
    limit: number = 20,
    categoryId?: string,
  ): Promise<PaginatedResult<Product>> {
    this.logger.debug(
      `Finding product list (limit: ${limit}, cursor: ${cursor}, categoryId: ${categoryId})`,
    );
    const take = limit + 1; // Limit + 1 trick

    const products = await this.prisma.product.findMany({
      take,
      skip: cursor ? 1 : 0, // Bỏ qua phần tử cursor hiện tại
      cursor: cursor ? { id: cursor } : undefined,
      where: categoryId ? { categoryId } : undefined,
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
