import {
  Category as PrismaCategory,
  Product as PrismaProduct,
  Sku as PrismaSku,
  ProductStatus as PrismaProductStatus,
  Prisma,
} from '@prisma/client';
import {
  Category,
  Product,
  ProductStatus,
  Sku,
} from '../../../domain/index.js';

type MutableEntity<T> = {
  -readonly [P in keyof T]: T[P];
};
/**
 * Data Mapper (Theo chuẩn Clean Architecture / DDD)
 *
 * Đóng vai trò là "Thông dịch viên" giữa Database (Prisma) và Lõi nghiệp vụ (Domain Entities).
 * - Chiều Đọc (Từ DB lên): Bơm (Hydrate) dữ liệu thô từ Prisma thành các class Domain Entity (chứa logic).
 * - Chiều Ghi (Từ Code xuống DB): Gọt bỏ các hàm logic của Entity, lấy data thuần túy để Prisma lưu xuống DB.
 *
 * Mục đích: Giúp tầng Domain hoàn toàn độc lập, không bị phụ thuộc hay ô nhiễm bởi bất kỳ ORM nào (Prisma, TypeORM...).
 */
export class CatalogMapper {
  static toCategoryDomain(prismaCategory: PrismaCategory): Category {
    const category = new Category(
      {
        parentId: prismaCategory.parentId,
        name: prismaCategory.name,
        path: prismaCategory.path,
        isActive: prismaCategory.isActive,
      },
      prismaCategory.id,
    );

    // Hydrate read-only fields safely
    const mutableCategory = category as MutableEntity<Category>;
    mutableCategory.createdAt = prismaCategory.createdAt;
    mutableCategory.updatedAt = prismaCategory.updatedAt;

    return category;
  }

  static toCategoryPersistence(
    category: Category,
  ): Omit<PrismaCategory, 'createdAt' | 'updatedAt'> {
    return {
      id: category.id,
      parentId: category.parentId,
      name: category.name,
      path: category.path,
      isActive: category.getProps().isActive,
    };
  }

  static toProductDomain(
    prismaProduct: PrismaProduct & { skus?: PrismaSku[] },
  ): Product {
    const statusMap: Record<PrismaProductStatus, ProductStatus> = {
      DRAFT: ProductStatus.DRAFT,
      PUBLISHED: ProductStatus.PUBLISHED,
      ARCHIVED: ProductStatus.ARCHIVED,
    };

    const skus = prismaProduct.skus
      ? prismaProduct.skus.map((s: PrismaSku) => this.toSkuDomain(s))
      : [];

    const product = new Product(
      {
        categoryId: prismaProduct.categoryId,
        name: prismaProduct.name,
        description: prismaProduct.description,
        thumbnail: prismaProduct.thumbnail,
        status: statusMap[prismaProduct.status],
        skus,
      },
      prismaProduct.id,
    );

    const mutableProduct = product as MutableEntity<Product>;
    mutableProduct.createdAt = prismaProduct.createdAt;
    mutableProduct.updatedAt = prismaProduct.updatedAt;

    return product;
  }

  static toProductPersistence(
    product: Product,
  ): Omit<PrismaProduct, 'createdAt' | 'updatedAt'> {
    const statusMap: Record<ProductStatus, PrismaProductStatus> = {
      [ProductStatus.DRAFT]: 'DRAFT',
      [ProductStatus.PUBLISHED]: 'PUBLISHED',
      [ProductStatus.ARCHIVED]: 'ARCHIVED',
    };

    return {
      id: product.id,
      categoryId: product.categoryId,
      name: product.name,
      description: product.getProps().description || null,
      thumbnail: product.getProps().thumbnail || null,
      status: statusMap[product.status],
    };
  }

  static toSkuDomain(prismaSku: PrismaSku): Sku {
    const sku = new Sku(
      {
        productId: prismaSku.productId,
        price: Number(prismaSku.price), // Convert Decimal object to Number
        attributes: prismaSku.attributes as Record<string, string>,
        skuCode: prismaSku.skuCode,
        barcode: prismaSku.barcode,
      },
      prismaSku.id,
    );

    const mutableSku = sku as MutableEntity<Sku>;
    mutableSku.createdAt = prismaSku.createdAt;
    mutableSku.updatedAt = prismaSku.updatedAt;

    return sku;
  }

  static toSkuPersistence(
    sku: Sku,
  ): Omit<PrismaSku, 'createdAt' | 'updatedAt'> {
    return {
      id: sku.id,
      productId: sku.productId,
      price: new Prisma.Decimal(sku.price), // Strictly typed Decimal
      attributes: sku.attributes as Prisma.JsonObject, // Strictly typed Json
      skuCode: sku.skuCode,
      barcode: sku.barcode || null,
    };
  }
}
