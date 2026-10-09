import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { GetProductsQuery } from './get-products.query.js';
import { Product } from '../../domain/index.js';
import type {
  ICategoryRepository,
  IProductRepository,
} from '../../domain/index.js';

import { PaginatedResult } from '@/core/index.js';

@QueryHandler(GetProductsQuery)
export class GetProductsHandler implements IQueryHandler<GetProductsQuery> {
  private readonly logger = new Logger(GetProductsHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(query: GetProductsQuery): Promise<PaginatedResult<Product>> {
    this.logger.log(
      `Executing GetProductsQuery (limit: ${query.limit}, cursor: ${query.cursor})`,
    );

    // A category filter covers the whole branch below that category, so the
    // chosen category's path is looked up first (cached by the repository).
    let categoryPath: string | undefined;
    if (query.categoryId) {
      const category = await this.categoryRepo.findById(query.categoryId);
      if (!category) {
        return { data: [], meta: { hasMore: false, nextCursor: null } };
      }
      categoryPath = category.path;
    }

    return this.productRepo.findList({
      limit: query.limit,
      cursor: query.cursor,
      categoryPath,
      search: query.search,
      status: query.status,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
    });
  }
}
