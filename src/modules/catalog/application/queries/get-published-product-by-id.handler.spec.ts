import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GetPublishedProductByIdHandler } from './get-published-product-by-id.handler.js';
import { GetPublishedProductByIdQuery } from './get-published-product-by-id.query.js';
import {
  Price,
  Product,
  ProductStatus,
  Sku,
  SkuAttributes,
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
    productRepo = {
      findById: vi.fn(),
      findInStockSkuIds: vi.fn().mockResolvedValue(new Set<string>()),
    };
    handler = new GetPublishedProductByIdHandler(productRepo);
  });

  it('returns a PUBLISHED product', async () => {
    const product = productWithStatus(ProductStatus.PUBLISHED);
    productRepo.findById.mockResolvedValueOnce(product);

    const result = await handler.execute(
      new GetPublishedProductByIdQuery('prod_1'),
    );

    expect(result.product).toBe(product);
    expect(productRepo.findById).toHaveBeenCalledWith('prod_1');
  });

  it('says which SKUs are in stock, read after the product (never from its cache)', async () => {
    const product = new Product(
      {
        categoryId: 'cat_1',
        name: 'MacBook',
        status: ProductStatus.PUBLISHED,
        skus: [
          Sku.create(
            {
              productId: 'prod_1',
              price: Price.create(100),
              attributes: SkuAttributes.create({ size: 'M' }),
              skuCode: 'S-M',
            },
            'sku_m',
          ),
          Sku.create(
            {
              productId: 'prod_1',
              price: Price.create(100),
              attributes: SkuAttributes.create({ size: 'L' }),
              skuCode: 'S-L',
            },
            'sku_l',
          ),
        ],
        version: 1,
      },
      'prod_1',
    );
    productRepo.findById.mockResolvedValueOnce(product);
    productRepo.findInStockSkuIds.mockResolvedValueOnce(new Set(['sku_m']));

    const result = await handler.execute(
      new GetPublishedProductByIdQuery('prod_1'),
    );

    expect(productRepo.findInStockSkuIds).toHaveBeenCalledWith([
      'sku_m',
      'sku_l',
    ]);
    expect(result.inStockSkuIds).toEqual(new Set(['sku_m']));
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
      // a product that is not on sale is not looked at any further
      expect(productRepo.findInStockSkuIds).not.toHaveBeenCalled();
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
