import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GetProductByIdHandler } from './get-product-by-id.handler.js';
import { GetProductByIdQuery } from './get-product-by-id.query.js';
import { Product, CatalogDomainException } from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('GetProductByIdHandler', () => {
  let handler: GetProductByIdHandler;
  let productRepo: any;

  beforeEach(() => {
    productRepo = {
      findById: vi.fn(),
    };
    handler = new GetProductByIdHandler(productRepo);
  });

  it('should get product by id if it exists', async () => {
    const product = Product.create(
      {
        categoryId: 'cat_1',
        name: 'MacBook',
        description: 'Laptop',
        thumbnail: 'img.png',
      },
      'prod_1',
    );
    productRepo.findById.mockResolvedValueOnce(product);

    const query = new GetProductByIdQuery('prod_1');
    const result = await handler.execute(query);

    expect(result).toBeInstanceOf(Product);
    expect(result.id).toBe('prod_1');
    expect(productRepo.findById).toHaveBeenCalledWith('prod_1');
  });

  it('should throw CatalogDomainException if product not found', async () => {
    productRepo.findById.mockResolvedValue(null);

    const query = new GetProductByIdQuery('invalid_prod_id');

    await expect(handler.execute(query)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(query)).rejects.toMatchObject({
      code: CatalogErrorCodes.PRODUCT_NOT_FOUND.code,
    });
  });
});
