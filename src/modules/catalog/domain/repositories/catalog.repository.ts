import { Product } from '../entities/product.entity.js';
import { Category } from '../entities/category.entity.js';
import { PaginatedResult, PagedResult } from '@/core/index.js';
import { ProductStatus } from '../entities/product.entity.js';
import type {
  CategoryProductCount,
  ProductSearchFilters,
  SearchProductsByCursorParams,
  SearchProductsByPageParams,
} from '../product-search.js';

export interface FindProductsParams {
  limit: number;
  cursor?: string;
  // Path of the chosen category (e.g. `/10/`): matches the products of that
  // category and of every category below it.
  categoryPath?: string;
  search?: string;
  status?: ProductStatus;
  minPrice?: number;
  maxPrice?: number;
}

/**
 * What another module (the cart) needs to know about a SKU, read in one query without loading
 * whole products. `published` is true only while the product of the SKU is on sale.
 */
export interface SkuLookupItem {
  skuId: string;
  productId: string;
  productName: string;
  thumbnail: string | null;
  attributes: Record<string, string>;
  price: number;
  published: boolean;
}

export interface IProductRepository {
  findById(id: string): Promise<Product | null>;
  findByIdOrSlug(identifier: string): Promise<Product | null>;
  findSitemapData(): Promise<Array<{ slug: string; updatedAt: Date }>>;
  save(product: Product): Promise<void>;

  /**
   * Many SKUs in ONE query, straight from the database (never from the product cache, so a price
   * that just changed is seen at once). SKUs that do not exist are simply not in the result.
   */
  findSkusByIds(skuIds: string[]): Promise<SkuLookupItem[]>;

  // For Keyset pagination
  findList(params: FindProductsParams): Promise<PaginatedResult<Product>>;

  /**
   * The PUBLISHED products that fit the filters, newest first, read after the product with the
   * given `cursor` id. One query, no `OFFSET`. Throws `CAT-017` when `cursor` is not a product.
   */
  searchByCursor(
    params: SearchProductsByCursorParams,
  ): Promise<PaginatedResult<Product>>;

  /**
   * The PUBLISHED products that fit the filters, in the order asked for, as a numbered page. The
   * total is counted only up to `COUNT_CEILING`.
   */
  searchByPage(
    params: SearchProductsByPageParams,
  ): Promise<PagedResult<Product>>;

  /**
   * Which of these SKUs are in stock (`onHand > 0`), read now from the database and never from a
   * cache, so a label that says "out of stock" is never older than the stock.
   */
  findInStockSkuIds(skuIds: string[]): Promise<Set<string>>;

  /**
   * The categories directly under `parentId` (the roots when null) with the number of PUBLISHED
   * products in each, counting every category below it, inside the filters (the category filter
   * itself is not one of them). Categories with no product are in the result with 0.
   */
  countByChildCategory(
    parentId: string | null,
    filters: Omit<ProductSearchFilters, 'categoryPath'>,
  ): Promise<CategoryProductCount[]>;
}

export interface ICategoryRepository {
  findById(id: string): Promise<Category | null>;
  findByIdOrSlug(identifier: string): Promise<Category | null>;
  findSitemapData(): Promise<Array<{ slug: string; updatedAt: Date }>>;
  save(category: Category): Promise<void>;
  findByParentId(parentId: string | null): Promise<Category[]>;

  // Bulk update category paths when moving a category
  updatePathAndChildren(category: Category, oldPath: string): Promise<void>;

  // Check if category has any products (useful before deletion)
  hasProducts(id: string): Promise<boolean>;

  // Check if category has any direct child categories (useful before deletion)
  hasChildren(id: string): Promise<boolean>;

  // Delete a category
  delete(id: string): Promise<void>;
}
