import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import {
  CatalogErrorCodes,
  toPage,
  type PageMeta,
  type PaginatedMeta,
} from '@/core/index.js';
import {
  CatalogDomainException,
  MAX_RESULT_WINDOW,
  PRODUCT_SORTS,
  type ICategoryRepository,
  type IProductRepository,
  type Product,
  type ProductSearchFilters,
} from '../../domain/index.js';
import { SearchProductsQuery } from './search-products.query.js';

/** One page of the public list, and which of its SKUs are in stock. */
export interface ProductSearchResult {
  data: Product[];
  /** `hasMore` and `nextCursor` when read by cursor; the position and the total when read by page. */
  meta: PaginatedMeta | PageMeta;
  /** The SKUs of `data` that are in stock now (read from the database, never from a cache). */
  inStockSkuIds: Set<string>;
}

const refuse = (reason: string): never => {
  throw new CatalogDomainException(
    CatalogErrorCodes.INVALID_SEARCH_REQUEST,
    reason,
  );
};

@QueryHandler(SearchProductsQuery)
export class SearchProductsHandler implements IQueryHandler<
  SearchProductsQuery,
  ProductSearchResult
> {
  constructor(
    @Inject('IProductRepository')
    private readonly productRepo: IProductRepository,
    @Inject('ICategoryRepository')
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async execute({
    options,
  }: SearchProductsQuery): Promise<ProductSearchResult> {
    const { limit, page, cursor, sort } = options;
    const search = options.search?.trim() || undefined;

    // The options that cannot go together are refused here, whoever the caller is
    if (!PRODUCT_SORTS.includes(sort)) refuse('Unknown sort');
    if (page !== undefined && cursor !== undefined) {
      refuse('Use either page or cursor, not both');
    }
    if (cursor !== undefined && sort !== 'newest') {
      refuse('cursor can only be used with sort=newest; use page');
    }
    if (sort === 'relevance' && !search) {
      refuse('sort=relevance needs a search');
    }
    if (page !== undefined && page * limit > MAX_RESULT_WINDOW) {
      refuse(`Only the first ${MAX_RESULT_WINDOW} results can be read`);
    }

    // A category filter covers the whole branch below the category, so its path is looked up first
    let categoryPath: string | undefined;
    if (options.categoryId) {
      const category = await this.categoryRepo.findById(options.categoryId);
      if (!category) {
        return {
          data: [],
          meta:
            page !== undefined
              ? toPage([], { page, limit, total: 0, totalCapped: false }).meta
              : { hasMore: false, nextCursor: null },
          inStockSkuIds: new Set(),
        };
      }
      categoryPath = category.path;
    }

    const filters: ProductSearchFilters = {
      categoryPath,
      search,
      minPrice: options.minPrice,
      maxPrice: options.maxPrice,
      inStock: options.inStock,
      onSale: options.onSale,
    };
    const found =
      page !== undefined
        ? await this.productRepo.searchByPage({ ...filters, limit, page, sort })
        : await this.productRepo.searchByCursor({ ...filters, limit, cursor });

    const inStockSkuIds = await this.productRepo.findInStockSkuIds(
      found.data.flatMap((product) => product.skus.map((sku) => sku.id)),
    );
    return { data: found.data, meta: found.meta, inStockSkuIds };
  }
}
