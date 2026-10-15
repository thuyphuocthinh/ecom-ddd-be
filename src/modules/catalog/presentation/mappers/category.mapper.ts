import { Category } from '../../domain/index.js';
import { CategoryResponseDto } from '../dtos/category-response.dto.js';

export class CategoryMapper {
  static toResponse(entity: Category): CategoryResponseDto {
    const props = entity.getProps();
    return {
      id: entity.id,
      name: props.name,
      slug: entity.slug,
      parentId: props.parentId,
      path: props.path,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
