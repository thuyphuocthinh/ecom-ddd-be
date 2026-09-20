import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GetProductsHandler } from './get-products.handler.js';
import { GetProductsQuery } from './get-products.query.js';
import { Product } from '../../domain/index.js';

describe('GetProductsHandler', () => {
  let handler: GetProductsHandler;
  let productRepo: any;

  beforeEach(() => {
    productRepo = {
      findList: vi.fn(),
    };
    handler = new GetProductsHandler(productRepo);
  });

  it('should get products list based on query parameters', async () => {
    const product1 = Product.create(
      { categoryId: 'cat_1', name: 'MacBook' },
      'prod_1',
    );
    const product2 = Product.create(
      { categoryId: 'cat_1', name: 'iPhone' },
      'prod_2',
    );

    productRepo.findList.mockResolvedValueOnce({
      data: [product1, product2],
      meta: { hasMore: false, nextCursor: null },
    });

    const query = new GetProductsQuery(10, 'cursor_id', 'cat_1');
    const result = await handler.execute(query);

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('prod_1');
    expect(productRepo.findList).toHaveBeenCalledWith('cursor_id', 10, 'cat_1');
  });

  it('should handle optional query parameters correctly', async () => {
    productRepo.findList.mockResolvedValueOnce({
      data: [],
      meta: { hasMore: false, nextCursor: null },
    });

    const query = new GetProductsQuery(20);
    await handler.execute(query);

    expect(productRepo.findList).toHaveBeenCalledWith(undefined, 20, undefined);
  });
});
