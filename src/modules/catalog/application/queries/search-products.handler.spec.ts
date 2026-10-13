import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SearchProductsHandler } from './search-products.handler.js';
import {
  SearchProductsQuery,
  type SearchProductsOptions,
} from './search-products.query.js';
import { GetProductFacetsHandler } from './get-product-facets.handler.js';
import { GetProductFacetsQuery } from './get-product-facets.query.js';
import { Product, Sku, Price, SkuAttributes } from '../../domain/index.js';

const product = () => {
  const made = Product.create({ categoryId: 'c', name: 'P' }, 'p1');
  made.addSku(
    {
      price: Price.create(10),
      attributes: SkuAttributes.create({ a: '1' }),
      skuCode: 'x',
    },
    'sku-1',
  );
  return made;
};
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error: any) {
    return error.code as string;
  }
  throw new Error('should have been refused');
};

describe('SearchProductsHandler', () => {
  let productRepo: any;
  let categoryRepo: any;
  let handler: SearchProductsHandler;
  const run = (options: Partial<SearchProductsOptions> = {}) =>
    handler.execute(
      new SearchProductsQuery({ limit: 20, sort: 'newest', ...options }),
    );

  beforeEach(() => {
    productRepo = {
      searchByPage: vi.fn().mockResolvedValue({
        data: [product()],
        meta: {
          page: 1,
          limit: 20,
          hasMore: false,
          total: 1,
          totalCapped: false,
        },
      }),
      searchByCursor: vi.fn().mockResolvedValue({
        data: [product()],
        meta: { hasMore: false, nextCursor: null },
      }),
      findInStockSkuIds: vi.fn().mockResolvedValue(new Set(['sku-1'])),
    };
    categoryRepo = { findById: vi.fn() };
    handler = new SearchProductsHandler(productRepo, categoryRepo);
  });

  describe('options that cannot go together are refused with CAT-017, before anything is read', () => {
    it.each([
      ['page and cursor', { page: 1, cursor: 'p0' }],
      [
        'a cursor with a sort other than newest',
        { cursor: 'p0', sort: 'price_asc' as const },
      ],
      [
        'a cursor with relevance',
        { cursor: 'p0', sort: 'relevance' as const, search: 'x' },
      ],
      ['relevance without a search', { page: 1, sort: 'relevance' as const }],
      [
        'relevance with a blank search',
        { page: 1, sort: 'relevance' as const, search: '   ' },
      ],
      ['a sort that does not exist', { sort: 'cheapest' as never }],
      [
        'a page that reaches past the first 1000 results',
        { page: 21, limit: 50 },
      ],
      ['a page far past them', { page: 1001, limit: 1 }],
    ])('%s', async (_label, options) => {
      expect(await refusal(run(options))).toBe('CAT-017');
      expect(productRepo.searchByPage).not.toHaveBeenCalled();
      expect(productRepo.searchByCursor).not.toHaveBeenCalled();
    });

    it('but the last page inside the window is fine', async () => {
      await run({ page: 20, limit: 50 });
      await run({ page: 1000, limit: 1 });

      expect(productRepo.searchByPage).toHaveBeenCalledTimes(2);
    });
  });

  describe('reading by page or by cursor', () => {
    it('by page when a page is given, with every filter passed on', async () => {
      categoryRepo.findById.mockResolvedValue({ path: '/10/' });

      await run({
        page: 2,
        limit: 10,
        sort: 'price_desc',
        categoryId: '10',
        search: '  phone  ',
        minPrice: 5,
        maxPrice: 50,
        inStock: true,
        onSale: true,
      });

      expect(productRepo.searchByPage).toHaveBeenCalledWith({
        limit: 10,
        page: 2,
        sort: 'price_desc',
        categoryPath: '/10/',
        search: 'phone',
        minPrice: 5,
        maxPrice: 50,
        inStock: true,
        onSale: true,
      });
      expect(productRepo.searchByCursor).not.toHaveBeenCalled();
    });

    it('by cursor when no page is given (the first page has no cursor either)', async () => {
      await run({ limit: 5, cursor: 'p9' });
      await run({ limit: 5 });

      expect(productRepo.searchByCursor).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ limit: 5, cursor: 'p9' }),
      );
      expect(productRepo.searchByCursor).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ limit: 5, cursor: undefined }),
      );
      expect(productRepo.searchByPage).not.toHaveBeenCalled();
    });

    it('has no status to pass: the repository is only asked for what is on sale', async () => {
      await run({ page: 1 });

      expect(
        Object.keys(productRepo.searchByPage.mock.calls[0][0]),
      ).not.toContain('status');
    });
  });

  describe('a category that does not exist', () => {
    it('gives an empty page, in the shape of the way it is read, without reading products', async () => {
      categoryRepo.findById.mockResolvedValue(null);

      const byPage = await run({ categoryId: 'nope', page: 3, limit: 10 });
      const byCursor = await run({ categoryId: 'nope' });

      expect(byPage.data).toEqual([]);
      expect(byPage.meta).toEqual({
        page: 3,
        limit: 10,
        hasMore: false,
        total: 0,
        totalCapped: false,
      });
      expect(byCursor.meta).toEqual({ hasMore: false, nextCursor: null });
      expect(productRepo.searchByPage).not.toHaveBeenCalled();
      expect(productRepo.searchByCursor).not.toHaveBeenCalled();
    });
  });

  describe('which SKUs are in stock', () => {
    it('asks once, for the SKUs of the products of the page, and passes the answer on', async () => {
      const result = await run({ page: 1 });

      expect(productRepo.findInStockSkuIds).toHaveBeenCalledTimes(1);
      expect(productRepo.findInStockSkuIds).toHaveBeenCalledWith(['sku-1']);
      expect(result.inStockSkuIds).toEqual(new Set(['sku-1']));
      expect(result.data).toHaveLength(1);
    });

    it('asks about nothing when the page is empty', async () => {
      productRepo.searchByPage.mockResolvedValue({
        data: [],
        meta: {
          page: 9,
          limit: 20,
          hasMore: false,
          total: 1,
          totalCapped: false,
        },
      });
      productRepo.findInStockSkuIds.mockResolvedValue(new Set());

      const result = await run({ page: 9 });

      expect(productRepo.findInStockSkuIds).toHaveBeenCalledWith([]);
      expect(result.inStockSkuIds.size).toBe(0);
    });
  });

  it('passes the meta of the repository through as it is', async () => {
    const result = await run({ page: 1 });

    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      hasMore: false,
      total: 1,
      totalCapped: false,
    });
    expect((await run({})).meta).toEqual({ hasMore: false, nextCursor: null });
  });

  it('an unused Sku import keeps the domain barrel honest', () => {
    expect(Sku).toBeDefined();
  });
});

describe('GetProductFacetsHandler', () => {
  it('asks for the counts under the parent with the filters, and a blank search is no search', async () => {
    const productRepo: any = {
      countByChildCategory: vi
        .fn()
        .mockResolvedValue([{ categoryId: 'E', name: 'E', count: 4 }]),
    };
    const handler = new GetProductFacetsHandler(productRepo);

    const result = await handler.execute(
      new GetProductFacetsQuery('root-1', {
        search: '   ',
        minPrice: 1,
        inStock: true,
      }),
    );

    expect(productRepo.countByChildCategory).toHaveBeenCalledWith('root-1', {
      search: undefined,
      minPrice: 1,
      inStock: true,
    });
    expect(result).toEqual([{ categoryId: 'E', name: 'E', count: 4 }]);
  });

  it('no parent means the root categories', async () => {
    const productRepo: any = {
      countByChildCategory: vi.fn().mockResolvedValue([]),
    };

    await new GetProductFacetsHandler(productRepo).execute(
      new GetProductFacetsQuery(null),
    );

    expect(productRepo.countByChildCategory).toHaveBeenCalledWith(null, {
      search: undefined,
    });
  });
});
