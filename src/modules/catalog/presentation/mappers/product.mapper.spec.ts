import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { Price, Product, SkuAttributes } from '../../domain/index.js';
import { CatalogMapper } from '../../infrastructure/database/mappers/catalog.mapper.js';
import { ProductMapper } from './product.mapper.js';

const productWith = (
  ...skus: { id: string; price: number; compare?: number }[]
) => {
  const product = Product.create({ categoryId: 'c', name: 'P' }, 'p1');
  for (const sku of skus) {
    product.addSku(
      {
        price: Price.create(sku.price),
        compareAtPrice:
          sku.compare === undefined ? null : Price.create(sku.compare),
        attributes: SkuAttributes.create({ id: sku.id }),
        skuCode: `code-${sku.id}`,
      },
      sku.id,
    );
  }
  return product;
};

describe('a product for the admin', () => {
  it('has the prices and the discount, and no stock flag at all', () => {
    const response = ProductMapper.toResponse(
      productWith({ id: 'a', price: 90, compare: 100 }, { id: 'b', price: 50 }),
    );

    expect(response).toMatchObject({
      minPrice: 50,
      onSale: true,
      discountPercent: 10,
    });
    expect(response).not.toHaveProperty('inStock');
    expect(response.skus[0]).toMatchObject({
      price: 90,
      compareAtPrice: 100,
      discountPercent: 10,
    });
    expect(response.skus[1]).toMatchObject({
      price: 50,
      compareAtPrice: null,
      discountPercent: 0,
    });
    for (const sku of response.skus) expect(sku).not.toHaveProperty('inStock');
  });

  it('can be used as the function of a map (it is: the lists map with it) without being confused by the index', () => {
    const responses = [
      productWith({ id: 'a', price: 1 }),
      productWith({ id: 'b', price: 2 }),
    ].map(ProductMapper.toResponse);

    expect(responses.map((r) => r.minPrice)).toEqual([1, 2]);
    expect(responses[1]).not.toHaveProperty('inStock');
  });

  it('a product with no SKU has no lowest price and no discount', () => {
    const response = ProductMapper.toResponse(productWith());

    expect(response).toMatchObject({
      minPrice: null,
      onSale: false,
      discountPercent: 0,
    });
    expect(response.skus).toEqual([]);
  });
});

describe('a product for the storefront', () => {
  const product = () =>
    productWith(
      { id: 'in', price: 100 },
      { id: 'out', price: 200 },
      { id: 'unknown', price: 300 },
    );

  it('says for each SKU whether it is in stock, and the product is when any SKU is', () => {
    const response = ProductMapper.toPublicResponse(product(), new Set(['in']));

    expect(response.skus.map((s) => [s.id, s.inStock])).toEqual([
      ['in', true],
      ['out', false],
      ['unknown', false],
    ]);
    expect(response.inStock).toBe(true);
  });

  it('is out of stock when no SKU is', () => {
    const response = ProductMapper.toPublicResponse(product(), new Set());

    expect(response.inStock).toBe(false);
    expect(response.skus.every((s) => s.inStock === false)).toBe(true);
  });

  it('is out of stock when it has no SKU', () => {
    expect(
      ProductMapper.toPublicResponse(productWith(), new Set()).inStock,
    ).toBe(false);
  });

  it('ignores a SKU id of some other product in the set', () => {
    const response = ProductMapper.toPublicResponse(
      product(),
      new Set(['elsewhere']),
    );

    expect(response.inStock).toBe(false);
  });

  it('keeps everything else of the admin response as it is', () => {
    const subject = productWith({ id: 'a', price: 90, compare: 100 });
    const admin = ProductMapper.toResponse(subject);
    const shown = ProductMapper.toPublicResponse(subject, new Set(['a']));

    expect(shown).toMatchObject({
      ...admin,
      skus: [{ ...admin.skus[0], inStock: true }],
      inStock: true,
    });
  });

  it('does not show the internal fields', () => {
    const text = JSON.stringify(
      ProductMapper.toPublicResponse(product(), new Set(['in'])),
    );

    expect(text).not.toContain('version');
    expect(text).not.toContain('barcode');
  });
});

describe('the mapper between the database and the domain', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'sku-1',
    productId: 'p1',
    price: new Prisma.Decimal('3990000.00'),
    compareAtPrice: new Prisma.Decimal('4590000.00'),
    attributes: { color: 'black' },
    skuCode: 'AERO',
    barcode: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...over,
  });

  it('reads the price before a discount, as the price is read', () => {
    const sku = CatalogMapper.toSkuDomain(row() as never);

    expect(sku.price.amount).toBe(3_990_000);
    expect(sku.compareAtPrice?.amount).toBe(4_590_000);
  });

  it('reads a row from the product cache, where decimals are text', () => {
    const cached = JSON.parse(
      JSON.stringify(row({ createdAt: '2026-10-01T00:00:00.000Z' })),
    );

    const sku = CatalogMapper.toSkuDomain(cached);

    expect(sku.price.amount).toBe(3_990_000);
    expect(sku.compareAtPrice?.amount).toBe(4_590_000);
  });

  it('reads a cached row written before the column existed, and a null, as no discount', () => {
    const { compareAtPrice: _removed, ...old } = row();

    expect(CatalogMapper.toSkuDomain(old as never).compareAtPrice).toBeNull();
    expect(
      CatalogMapper.toSkuDomain(row({ compareAtPrice: null }) as never)
        .compareAtPrice,
    ).toBeNull();
  });

  it('writes the price before a discount, or null', () => {
    const discounted = productWith({ id: 'a', price: 90, compare: 100 });
    const plain = productWith({ id: 'b', price: 90 });

    expect(
      CatalogMapper.toSkuPersistence(
        discounted.skus[0],
      ).compareAtPrice?.toNumber(),
    ).toBe(100);
    expect(
      CatalogMapper.toSkuPersistence(plain.skus[0]).compareAtPrice,
    ).toBeNull();
  });

  it('writes the lowest price of the product, worked out from its SKUs, or null with none', () => {
    const product = productWith(
      { id: 'a', price: 300 },
      { id: 'b', price: 120 },
    );

    expect(
      CatalogMapper.toProductPersistence(product).minPrice?.toNumber(),
    ).toBe(120);
    expect(
      CatalogMapper.toProductPersistence(productWith()).minPrice,
    ).toBeNull();
  });
});
