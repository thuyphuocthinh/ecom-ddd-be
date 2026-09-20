import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetProductByIdQuery } from './get-product-by-id.query.js';
import { Product, CatalogDomainException } from '../../domain/index.js';
import type { IProductRepository } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

@QueryHandler(GetProductByIdQuery)
export class GetProductByIdHandler implements IQueryHandler<GetProductByIdQuery> {
  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
  ) {}

  async execute(query: GetProductByIdQuery): Promise<Product> {
    const product = await this.productRepo.findById(query.id);
    if (!product) {
      throw new CatalogDomainException(
        CatalogErrorCodes.PRODUCT_NOT_FOUND,
        `Product with ID ${query.id} not found`,
      );
    }
    return product;
  }
}
