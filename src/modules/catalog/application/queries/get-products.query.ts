import { ProductStatus } from '../../domain/index.js';
import { IQuery } from '@nestjs/cqrs';

export class GetProductsQuery implements IQuery {
  constructor(
    public readonly limit: number = 20,
    public readonly cursor?: string,
    public readonly categoryId?: string,
    public readonly search?: string,
    public readonly status?: ProductStatus,
    public readonly minPrice?: number,
    public readonly maxPrice?: number,
  ) {}
}
