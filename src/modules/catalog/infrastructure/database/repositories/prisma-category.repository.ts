import { Injectable, Logger } from '@nestjs/common';
import { ICategoryRepository, Category } from '../../../domain/index.js';
import { PrismaService, RedisService } from '@/core/index.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';

const CATEGORY_CACHE_TTL_SECONDS = 300;
const categoryCacheKey = (id: string) => `catalog:category:${id}`;

@Injectable()
export class PrismaCategoryRepository implements ICategoryRepository {
  private readonly logger = new Logger(PrismaCategoryRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findById(id: string): Promise<Category | null> {
    const cached = await this.redis.getOrSetNullableDetail(
      categoryCacheKey(id),
      CATEGORY_CACHE_TTL_SECONDS,
      async () => {
        this.logger.debug(`Finding category by ID: ${id}`);
        return this.prisma.category.findUnique({ where: { id } });
      },
    );
    return cached ? CatalogMapper.toCategoryDomain(cached) : null;
  }

  async findByParentId(parentId: string | null): Promise<Category[]> {
    this.logger.debug(`Finding categories by parent ID: ${parentId}`);
    const categories = await this.prisma.category.findMany({
      where: { parentId },
      orderBy: { name: 'asc' }, // Sắp xếp theo tên cho dễ nhìn
    });
    return categories.map((cat) => CatalogMapper.toCategoryDomain(cat));
  }

  async save(category: Category): Promise<void> {
    this.logger.debug(`Saving category: ${category.id}`);
    const data = CatalogMapper.toCategoryPersistence(category);
    await this.prisma.category.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    await this.redis.invalidateDetail(categoryCacheKey(category.id));
  }

  async updatePathAndChildren(
    category: Category,
    oldPath: string,
  ): Promise<void> {
    this.logger.debug(
      `Updating path and children for category: ${category.id}`,
    );
    const data = CatalogMapper.toCategoryPersistence(category);
    const newPath = category.path;

    // Use transaction to ensure data integrity during tree move
    const affectedIds = await this.prisma.$transaction(async (tx) => {
      // 1. Update the category itself
      await tx.category.update({
        where: { id: data.id },
        data: {
          parentId: data.parentId,
          path: data.path,
        },
      });

      // 2. Find every descendant this move will touch, so their cache
      // entries can be invalidated too — the bulk path update below is a
      // raw query and doesn't return which rows it affected.
      const descendants = await tx.category.findMany({
        where: { path: { startsWith: oldPath } },
        select: { id: true },
      });

      // 3. Bulk update all descendants
      // We use raw query because Prisma doesn't support REPLACE function natively
      // Example: REPLACE('/old/path/', '/new/path/')
      await tx.$executeRaw`
        UPDATE "Category"
        SET "path" = REPLACE("path", ${oldPath}, ${newPath})
        WHERE "path" LIKE ${oldPath + '%'};
      `;

      return [data.id, ...descendants.map((d) => d.id)];
    });

    await Promise.all(
      affectedIds.map((id) =>
        this.redis.invalidateDetail(categoryCacheKey(id)),
      ),
    );
  }

  async hasProducts(id: string): Promise<boolean> {
    this.logger.debug(`Checking if category has products: ${id}`);
    const count = await this.prisma.product.count({
      where: { categoryId: id },
    });
    return count > 0;
  }

  async hasChildren(id: string): Promise<boolean> {
    this.logger.debug(`Checking if category has children: ${id}`);
    const count = await this.prisma.category.count({
      where: { parentId: id },
    });
    return count > 0;
  }

  async delete(id: string): Promise<void> {
    this.logger.debug(`Deleting category: ${id}`);
    await this.prisma.category.delete({
      where: { id },
    });
    await this.redis.invalidateDetail(categoryCacheKey(id));
  }
}
