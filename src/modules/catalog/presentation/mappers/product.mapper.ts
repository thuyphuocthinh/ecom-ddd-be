import { Product, Sku } from '../../domain/index.js';
import {
  ProductResponseDto,
  SkuResponseDto,
} from '../dtos/product-response.dto.js';

export class ProductMapper {
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
          price: skuProps.price,
          attributes: skuProps.attributes,
        } as SkuResponseDto;
      }),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
