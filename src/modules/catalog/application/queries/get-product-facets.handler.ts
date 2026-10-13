import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import type {
  CategoryProductCount,
  IProductRepository,
} from '../../domain/index.js';
import { GetProductFacetsQuery } from './get-product-facets.query.js';

@QueryHandler(GetProductFacetsQuery)
export class GetProductFacetsHandler implements IQueryHandler<
  GetProductFacetsQuery,
  CategoryProductCount[]
> {
  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  execute({
    parentId,
    filters,
  }: GetProductFacetsQuery): Promise<CategoryProductCount[]> {
    // A parent that does not exist has no children: an empty list, as for an unknown category in
    // the product list
    return this.productRepo.countByChildCategory(parentId, {
      ...filters,
      search: filters.search?.trim() || undefined,
    });
  }
}
