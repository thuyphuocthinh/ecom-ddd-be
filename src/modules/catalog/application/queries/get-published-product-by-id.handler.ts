import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetPublishedProductByIdQuery } from './get-published-product-by-id.query.js';
import {
  Product,
  ProductStatus,
  CatalogDomainException,
} from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@QueryHandler(GetPublishedProductByIdQuery)
export class GetPublishedProductByIdHandler implements IQueryHandler<GetPublishedProductByIdQuery> {
  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(query: GetPublishedProductByIdQuery): Promise<Product> {
    const product = await this.productRepo.findById(query.id);

    // The status is checked on what was just read (cache or database), so a
    // product that was hidden a moment ago is never served from a stale entry.
    // A hidden product gets the same error as a missing one: nothing tells the
    // caller that it exists.
    if (!product || product.status !== ProductStatus.PUBLISHED) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${query.id} not found`,
      );
    }
    return product;
  }
}
