import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GetProductsHandler } from './get-products.handler.js';
import { GetProductsQuery } from './get-products.query.js';
import { Category, Product, ProductStatus } from '../../domain/index.js';

describe('GetProductsHandler', () => {
  let handler: GetProductsHandler;
  let productRepo: any;
  let categoryRepo: any;

  beforeEach(() => {
    productRepo = {
      findList: vi.fn(),
    };
    categoryRepo = {
      findById: vi.fn(),
    };
    handler = new GetProductsHandler(productRepo, categoryRepo);
  });

  it('should look up the category and filter by its path, so sub-categories are included', async () => {
    const product1 = Product.create(
      { categoryId: 'cat_1', name: 'MacBook' },
      'prod_1',
    );
    const product2 = Product.create(
      { categoryId: 'cat_2', name: 'iPhone' },
      'prod_2',
    );
    categoryRepo.findById.mockResolvedValueOnce(
      Category.create('Electronics', null, 'cat_1'),
    );
    productRepo.findList.mockResolvedValueOnce({
      data: [product1, product2],
      meta: { hasMore: false, nextCursor: null },
    });

    const query = new GetProductsQuery(10, 'cursor_id', 'cat_1');
    const result = await handler.execute(query);

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('prod_1');
    expect(categoryRepo.findById).toHaveBeenCalledWith('cat_1');
    expect(productRepo.findList).toHaveBeenCalledWith({
      limit: 10,
      cursor: 'cursor_id',
      categoryPath: '/cat_1/',
      search: undefined,
      status: undefined,
      minPrice: undefined,
      maxPrice: undefined,
    });
  });

  it('should return an empty page without querying products when the category does not exist', async () => {
    categoryRepo.findById.mockResolvedValueOnce(null);

    const result = await handler.execute(
      new GetProductsQuery(10, undefined, 'missing'),
    );

    expect(result).toEqual({
      data: [],
      meta: { hasMore: false, nextCursor: null },
    });
    expect(productRepo.findList).not.toHaveBeenCalled();
  });

  it('should not look up any category when no categoryId is given', async () => {
    productRepo.findList.mockResolvedValueOnce({
      data: [],
      meta: { hasMore: false, nextCursor: null },
    });

    await handler.execute(new GetProductsQuery(20));

    expect(categoryRepo.findById).not.toHaveBeenCalled();
    expect(productRepo.findList).toHaveBeenCalledWith({
      limit: 20,
      cursor: undefined,
      categoryPath: undefined,
      search: undefined,
      status: undefined,
      minPrice: undefined,
      maxPrice: undefined,
    });
  });

  it('should pass the status and the other filters through unchanged', async () => {
    productRepo.findList.mockResolvedValueOnce({
      data: [],
      meta: { hasMore: false, nextCursor: null },
    });

    await handler.execute(
      new GetProductsQuery(
        5,
        undefined,
        undefined,
        'apple',
        ProductStatus.PUBLISHED,
        100,
        900,
      ),
    );

    expect(productRepo.findList).toHaveBeenCalledWith({
      limit: 5,
      cursor: undefined,
      categoryPath: undefined,
      search: 'apple',
      status: ProductStatus.PUBLISHED,
      minPrice: 100,
      maxPrice: 900,
    });
  });
});
