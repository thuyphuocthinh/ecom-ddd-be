import { describe, it, expect } from 'vitest';
import { Product, ProductStatus } from './product.entity.js';
import { Price } from '../value-objects/price.vo.js';
import { SkuAttributes } from '../value-objects/sku-attributes.vo.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('Product Entity', () => {
  it('should create a product with default DRAFT status', () => {
    const product = Product.create({
      categoryId: 'cat_1',
      name: 'Áo phông nam',
      description: 'Mô tả',
    });

    expect(product.categoryId).toBe('cat_1');
    expect(product.name).toBe('Áo phông nam');
    expect(product.status).toBe(ProductStatus.DRAFT);
    expect(product.skus.length).toBe(0);
  });

  it('should add a new SKU successfully', () => {
    const product = Product.create({ categoryId: 'cat_1', name: 'Test' });
    product.addSku({
      price: Price.create(100000),
      attributes: SkuAttributes.create({ color: 'Red', size: 'M' }),
      skuCode: 'TEST-RED-M',
    });

    expect(product.skus.length).toBe(1);
    expect(product.skus[0].price.amount).toBe(100000);
    expect(product.skus[0].attributes.toPlainObject()).toEqual({
      color: 'Red',
      size: 'M',
    });
  });

  it('should throw an exception when adding duplicated SKUs', () => {
    const product = Product.create({ categoryId: 'cat_1', name: 'Test' });
    product.addSku({
      price: Price.create(100000),
      attributes: SkuAttributes.create({ color: 'Red', size: 'M' }),
      skuCode: 'TEST-RED-M',
    });

    expect(() => {
      product.addSku({
        price: Price.create(120000),
        attributes: SkuAttributes.create({ size: 'M', color: 'Red' }), // Same attributes, different order
        skuCode: 'TEST-RED-M-2',
      });
    }).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.SKU_DUPLICATED),
    );
  });

  it('should track removed SKU ids without touching untouched SKUs', () => {
    const product = Product.create({ categoryId: 'cat_1', name: 'Test' });
    const skuA = product.addSku({
      price: Price.create(100000),
      attributes: SkuAttributes.create({ color: 'Red' }),
      skuCode: 'A',
    });
    product.addSku({
      price: Price.create(100000),
      attributes: SkuAttributes.create({ color: 'Blue' }),
      skuCode: 'B',
    });

    product.removeSku(skuA.id);

    expect(product.removedSkuIds).toEqual([skuA.id]);
    expect(product.skus.map((s) => s.skuCode)).toEqual(['B']);
  });
});
