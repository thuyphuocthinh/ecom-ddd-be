import { IQuery } from '@nestjs/cqrs';
import type { ProductSort } from '../../domain/index.js';

export interface SearchProductsOptions {
  limit: number;
  /** Read by position: 1, 2, 3... Not together with `cursor`. */
  page?: number;
  /** Read after this product ("load more"). Only for `sort = newest`. */
  cursor?: string;
  sort: ProductSort;
  /** The products of this category and of every category below it. */
  categoryId?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  onSale?: boolean;
}

/**
 * The public product list: PUBLISHED products only, narrowed by the options, in the order asked
 * for, read by `cursor` or by `page`. The status is not an option: the customer cannot ask for
 * anything but what is on sale.
 */
export class SearchProductsQuery implements IQuery {
  constructor(public readonly options: SearchProductsOptions) {}
}
