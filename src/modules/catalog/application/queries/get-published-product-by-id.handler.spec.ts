import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GetPublishedProductByIdHandler } from './get-published-product-by-id.handler.js';
import { GetPublishedProductByIdQuery } from './get-published-product-by-id.query.js';
import {
  Product,
  ProductStatus,
  CatalogDomainException,
} from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

const productWithStatus = (status: ProductStatus): Product =>
  new Product(
    { categoryId: 'cat_1', name: 'MacBook', status, skus: [], version: 1 },
    'prod_1',
  );

describe('GetPublishedProductByIdHandler', () => {
  let handler: GetPublishedProductByIdHandler;
  let productRepo: any;

  beforeEach(() => {
    productRepo = { findById: vi.fn() };
    handler = new GetPublishedProductByIdHandler(productRepo);
  });

  it('returns a PUBLISHED product', async () => {
    const product = productWithStatus(ProductStatus.PUBLISHED);
    productRepo.findById.mockResolvedValueOnce(product);

    const result = await handler.execute(
      new GetPublishedProductByIdQuery('prod_1'),
    );

    expect(result).toBe(product);
    expect(productRepo.findById).toHaveBeenCalledWith('prod_1');
  });

  it.each([ProductStatus.DRAFT, ProductStatus.ARCHIVED])(
    'treats a %s product as not found',
    async (status) => {
      productRepo.findById.mockResolvedValue(productWithStatus(status));

      const query = new GetPublishedProductByIdQuery('prod_1');

      await expect(handler.execute(query)).rejects.toThrow(
        CatalogDomainException,
      );
      await expect(handler.execute(query)).rejects.toMatchObject({
        code: CatalogErrorCodes.PRODUCT_NOT_FOUND.code,
      });
    },
  );

  it('gives a missing product the same error as a hidden one', async () => {
    productRepo.findById.mockResolvedValue(null);

    await expect(
      handler.execute(new GetPublishedProductByIdQuery('nope')),
    ).rejects.toMatchObject({
      code: CatalogErrorCodes.PRODUCT_NOT_FOUND.code,
    });
  });
});
