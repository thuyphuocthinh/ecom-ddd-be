import { IQuery } from '@nestjs/cqrs';
import type { ProductSearchFilters } from '../../domain/index.js';

/**
 * How many PUBLISHED products each category directly under `parentId` (the roots when null)
 * holds, every category below it counted in, inside the filters.
 */
export class GetProductFacetsQuery implements IQuery {
  constructor(
    public readonly parentId: string | null,
    public readonly filters: Omit<ProductSearchFilters, 'categoryPath'> = {},
  ) {}
}
