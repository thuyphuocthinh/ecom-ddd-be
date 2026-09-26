import { ProductStatus } from '../../domain/index.js';

export class GetProductsQuery {
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
