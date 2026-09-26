import { describe, it, expect } from 'vitest';
import { Sku } from './sku.entity.js';
import { Price } from '../value-objects/price.vo.js';
import { SkuAttributes } from '../value-objects/sku-attributes.vo.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('Sku Entity', () => {
  it('should create a valid SKU', () => {
    const sku = Sku.create({
      productId: 'prod_1',
      price: Price.create(150000),
      attributes: SkuAttributes.create({ color: 'Blue' }),
      skuCode: 'PROD-BLUE',
    });

    expect(sku.productId).toBe('prod_1');
    expect(sku.price.amount).toBe(150000);
  });

  it('should throw exception if price is negative when creating', () => {
    expect(() => Price.create(-100)).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.NEGATIVE_PRICE),
    );
  });

  it('should update price successfully', () => {
    const sku = Sku.create({
      productId: 'prod_1',
      price: Price.create(150000),
      attributes: SkuAttributes.create({ color: 'Blue' }),
      skuCode: 'PROD-BLUE',
    });

    sku.updatePrice(Price.create(200000));
    expect(sku.price.amount).toBe(200000);
  });

  it('should throw exception if updated price is negative', () => {
    expect(() => Price.create(-50000)).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.NEGATIVE_PRICE),
    );
  });
});
