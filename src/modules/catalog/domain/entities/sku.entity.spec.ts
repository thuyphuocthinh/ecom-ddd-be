import { describe, it, expect } from 'vitest';
import { Sku } from './sku.entity.js';
import { CatalogDomainException } from '../exceptions/catalog.exception.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('Sku Entity', () => {
  it('should create a valid SKU', () => {
    const sku = Sku.create({
      productId: 'prod_1',
      price: 150000,
      attributes: { color: 'Blue' },
      skuCode: 'PROD-BLUE',
    });

    expect(sku.productId).toBe('prod_1');
    expect(sku.price).toBe(150000);
  });

  it('should throw exception if price is negative when creating', () => {
    expect(() => {
      Sku.create({
        productId: 'prod_1',
        price: -100,
        attributes: { color: 'Blue' },
        skuCode: 'PROD-BLUE',
      });
    }).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.NEGATIVE_PRICE),
    );
  });

  it('should update price successfully', () => {
    const sku = Sku.create({
      productId: 'prod_1',
      price: 150000,
      attributes: { color: 'Blue' },
      skuCode: 'PROD-BLUE',
    });

    sku.updatePrice(200000);
    expect(sku.price).toBe(200000);
  });

  it('should throw exception if updated price is negative', () => {
    const sku = Sku.create({
      productId: 'prod_1',
      price: 150000,
      attributes: { color: 'Blue' },
      skuCode: 'PROD-BLUE',
    });

    expect(() => {
      sku.updatePrice(-50000);
    }).toThrowError(
      new CatalogDomainException(CatalogErrorCodes.NEGATIVE_PRICE),
    );
  });
});
