/** The orders the public product list can be sorted in. */
export const PRODUCT_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'relevance',
] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/**
 * How far into a list a page number may reach: `page * limit` must not pass this. Nobody reads
 * past the first thousand results, and it is what bounds the cost of reading a page by position.
 */
export const MAX_RESULT_WINDOW = 1000;

/** The count of a search stops one row past the window, so it never counts a huge set in full. */
export const COUNT_CEILING = MAX_RESULT_WINDOW + 1;

/** What narrows a search of the public product list. Every part is optional; all that are given must hold. */
export interface ProductSearchFilters {
  /** Path of the chosen category (e.g. `/10/`): the products of that category and every one below it. */
  categoryPath?: string;
  /** Full-text search over name and description. */
  search?: string;
  /** Some SKU of the product costs at least this. */
  minPrice?: number;
  /** Some SKU of the product costs at most this. */
  maxPrice?: number;
  /** Some SKU of the product is in stock (`onHand > 0`; units held for orders are not taken off). */
  inStock?: boolean;
  /** Some SKU of the product has a price before a discount. */
  onSale?: boolean;
}

export interface SearchProductsByCursorParams extends ProductSearchFilters {
  limit: number;
  /** The id of the last product of the previous page; the list is always newest first. */
  cursor?: string;
}

export interface SearchProductsByPageParams extends ProductSearchFilters {
  limit: number;
  /** 1, 2, 3... */
  page: number;
  sort: ProductSort;
}

/** The categories directly under a category (or the roots), each with the products it holds. */
export interface CategoryProductCount {
  categoryId: string;
  name: string;
  /** Published products in the category and in every category below it, inside the filters. */
  count: number;
}
