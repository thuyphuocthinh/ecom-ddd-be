import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetCategoriesQuery } from './get-categories.query.js';
import { Category } from '../../domain/index.js';
import type { ICategoryRepository } from '../../domain/index.js';

@QueryHandler(GetCategoriesQuery)
export class GetCategoriesHandler implements IQueryHandler<GetCategoriesQuery> {
  constructor(
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(query: GetCategoriesQuery): Promise<Category[]> {
    if (query.parentId) {
      return this.categoryRepo.findByParentId(query.parentId);
    }

    // Nếu không truyền parentId, ta có thể lấy danh sách các category gốc (parentId = null)
    // hoặc lấy tất cả tùy nghiệp vụ.
    // Giả sử lấy các danh mục gốc:
    return this.categoryRepo.findByParentId(null);
  }
}
