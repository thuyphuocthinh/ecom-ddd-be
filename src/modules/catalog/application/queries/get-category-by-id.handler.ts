import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { GetCategoryByIdQuery } from './get-category-by-id.query.js';
import { Category, CatalogDomainException } from '../../domain/index.js';
import type { ICategoryRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@QueryHandler(GetCategoryByIdQuery)
export class GetCategoryByIdHandler implements IQueryHandler<GetCategoryByIdQuery> {
  private readonly logger = new Logger(GetCategoryByIdHandler.name);

  constructor(
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute(query: GetCategoryByIdQuery): Promise<Category> {
    this.logger.debug(
      `Executing GetCategoryByIdQuery for category: ${query.id}`,
    );

    const category = await this.categoryRepo.findById(query.id);
    if (!category) {
      throw new CatalogDomainException(
        CatalogErrorCodes.CATEGORY_NOT_FOUND,
        `Category with ID ${query.id} not found`,
      );
    }

    return category;
  }
}
