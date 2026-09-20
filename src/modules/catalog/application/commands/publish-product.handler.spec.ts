import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PublishProductHandler } from './publish-product.handler.js';
import { PublishProductCommand } from './publish-product.command.js';
import {
  Product,
  ProductStatus,
  CatalogDomainException,
} from '../../domain/index.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('PublishProductHandler', () => {
  let handler: PublishProductHandler;
  let productRepo: any;

  beforeEach(() => {
    productRepo = {
      findById: vi.fn(),
      save: vi.fn(),
    };
    handler = new PublishProductHandler(productRepo);
  });

  it('should publish product successfully', async () => {
    const product = Product.create(
      { categoryId: 'cat_1', name: 'Product' },
      'prod_1',
    );
    product.addSku({
      price: 100,
      attributes: { color: 'red' },
      skuCode: 'SKU-1',
    });

    productRepo.findById.mockResolvedValue(product);
    productRepo.save.mockResolvedValue(undefined);

    const command = new PublishProductCommand('prod_1');
    const updatedProduct = await handler.execute(command);

    expect(updatedProduct.status).toBe(ProductStatus.PUBLISHED);
    expect(productRepo.save).toHaveBeenCalledWith(updatedProduct);
  });

  it('should throw exception if product not found', async () => {
    productRepo.findById.mockResolvedValue(null);

    const command = new PublishProductCommand('invalid_prod');
    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.PRODUCT_NOT_FOUND.code,
    });
  });

  it('should bubble up exception from domain if publish fails (e.g. no skus)', async () => {
    const product = Product.create(
      { categoryId: 'cat_1', name: 'Product' },
      'prod_1',
    );
    productRepo.findById.mockResolvedValue(product);

    const command = new PublishProductCommand('prod_1');

    await expect(handler.execute(command)).rejects.toThrow(
      CatalogDomainException,
    );
    await expect(handler.execute(command)).rejects.toMatchObject({
      code: CatalogErrorCodes.INVALID_PUBLISH.code,
    });

    expect(productRepo.save).not.toHaveBeenCalled();
  });
});
