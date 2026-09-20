import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { GetProductsQuery } from './get-products.query.js';
import { Product } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';

import { PaginatedResult } from '@/core/index.js';

@QueryHandler(GetProductsQuery)
export class GetProductsHandler implements IQueryHandler<GetProductsQuery> {
  private readonly logger = new Logger(GetProductsHandler.name);

  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(query: GetProductsQuery): Promise<PaginatedResult<Product>> {
    this.logger.log(
      `Executing GetProductsQuery (limit: ${query.limit}, cursor: ${query.cursor})`,
    );
    return this.productRepo.findList(
      query.cursor,
      query.limit,
      query.categoryId,
    );
  }
}
