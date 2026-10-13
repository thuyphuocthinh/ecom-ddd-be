import { Product, Sku } from '../../domain/index.js';
import {
  ProductResponseDto,
  SkuResponseDto,
} from '../dtos/product-response.dto.js';

export class ProductMapper {
  /** A product as the admin sees it: no stock flags (they belong to the storefront). */
  static toResponse(entity: Product): ProductResponseDto {
    const props = entity.getProps();

    return {
      id: entity.id,
      categoryId: props.categoryId,
      name: props.name,
      description: props.description,
      thumbnail: props.thumbnail,
      status: props.status,
      skus: props.skus.map((sku: Sku) => {
        const skuProps = sku.getProps();
        return {
          id: sku.id,
          skuCode: skuProps.skuCode,
          price: skuProps.price.amount,
          compareAtPrice: sku.compareAtPrice?.amount ?? null,
          discountPercent: sku.discountPercent,
          attributes: skuProps.attributes.toPlainObject(),
        } as SkuResponseDto;
      }),
      minPrice: entity.minPrice,
      onSale: entity.onSale,
      discountPercent: entity.discountPercent,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  /**
   * A product as the storefront sees it: the same, with whether each SKU is in stock, and whether
   * the product is (when any SKU is).
   */
  static toPublicResponse(
    entity: Product,
    inStockSkuIds: ReadonlySet<string>,
  ): ProductResponseDto {
    const response = ProductMapper.toResponse(entity);
    const skus = response.skus.map((sku) => ({
      ...sku,
      inStock: inStockSkuIds.has(sku.id),
    }));
    return {
      ...response,
      skus,
      inStock: skus.some((sku) => sku.inStock),
    };
  }
}
