import { describe, it, expect } from 'vitest';
import { Product, Sku, Price, SkuAttributes } from '../index.js';

const sku = (price: number, compareAtPrice?: number | null, id = 'sku-1') =>
  Sku.create(
    {
      productId: 'p1',
      price: Price.create(price),
      compareAtPrice:
        compareAtPrice === undefined || compareAtPrice === null
          ? compareAtPrice
          : Price.create(compareAtPrice),
      attributes: SkuAttributes.create({ id }),
      skuCode: `code-${id}`,
    },
    id,
  );
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (error: any) {
    return error.code as string;
  }
  throw new Error('should have been refused');
};

describe('the price before a discount (Sku)', () => {
  it('is empty for a SKU that is not discounted, whether it is left out or null', () => {
    expect(sku(100).compareAtPrice).toBeNull();
    expect(sku(100, null).compareAtPrice).toBeNull();
    expect(sku(100).discountPercent).toBe(0);
  });

  it('must be greater than the selling price, with CAT-018 (equal is not a discount)', () => {
    expect(refused(() => sku(100, 100))).toBe('CAT-018');
    expect(refused(() => sku(100, 99))).toBe('CAT-018');
    expect(refused(() => sku(0, 0))).toBe('CAT-018');
    expect(sku(100, 101).compareAtPrice?.amount).toBe(101);
    expect(sku(0, 1).compareAtPrice?.amount).toBe(1);
  });

  describe('the discount in whole percent', () => {
    it.each([
      [3_990_000, 4_590_000, 13],
      [75, 100, 25],
      [50, 100, 50],
      [1, 100, 99],
    ])('%s against %s is %s%%', (price, original, percent) => {
      expect(sku(price, original).discountPercent).toBe(percent);
    });

    it('is at least 1% whenever there is a discount, however small', () => {
      expect(sku(1000, 1001).discountPercent).toBe(1);
      expect(sku(9_999, 10_000).discountPercent).toBe(1);
    });
  });

  describe('changing the price', () => {
    it('with no original price given, keeps the one it has, if it is still above', () => {
      const s = sku(100, 150);

      s.updatePrice(Price.create(120));

      expect(s.price.amount).toBe(120);
      expect(s.compareAtPrice?.amount).toBe(150);
    });

    it('refuses a new price that reaches the original it keeps, and changes nothing', () => {
      const s = sku(100, 150);

      expect(refused(() => s.updatePrice(Price.create(150)))).toBe('CAT-018');
      expect(refused(() => s.updatePrice(Price.create(200)))).toBe('CAT-018');
      expect(s.price.amount).toBe(100);
      expect(s.compareAtPrice?.amount).toBe(150);
    });

    it('with null removes the discount, and that also lets the price rise past the old original', () => {
      const s = sku(100, 150);

      s.updatePrice(Price.create(200), null);

      expect(s.price.amount).toBe(200);
      expect(s.compareAtPrice).toBeNull();
      expect(s.discountPercent).toBe(0);
    });

    it('with a number sets a new original, checked against the new price', () => {
      const s = sku(100);

      s.updatePrice(Price.create(100), Price.create(130));
      expect(s.compareAtPrice?.amount).toBe(130);
      expect(
        refused(() => s.updatePrice(Price.create(100), Price.create(100))),
      ).toBe('CAT-018');
      expect(s.compareAtPrice?.amount).toBe(130);
    });

    it('a SKU that has no discount may take any price when none is given', () => {
      const s = sku(100);

      s.updatePrice(Price.create(5_000));

      expect(s.price.amount).toBe(5_000);
      expect(s.compareAtPrice).toBeNull();
    });
  });
});

describe('the price and discount of a product', () => {
  const productWith = (...skus: Sku[]) => {
    const product = Product.create({ categoryId: 'c', name: 'P' }, 'p1');
    for (const s of skus) {
      product.addSku(
        {
          price: s.price,
          compareAtPrice: s.compareAtPrice,
          attributes: s.attributes,
          skuCode: s.skuCode,
        },
        s.id,
      );
    }
    return product;
  };

  it('has no lowest price and no discount when it has no SKU', () => {
    const product = productWith();

    expect(product.minPrice).toBeNull();
    expect(product.onSale).toBe(false);
    expect(product.discountPercent).toBe(0);
  });

  it('has the lowest selling price of its SKUs', () => {
    expect(
      productWith(
        sku(300, undefined, 'a'),
        sku(100, undefined, 'b'),
        sku(200, undefined, 'c'),
      ).minPrice,
    ).toBe(100);
  });

  it('is on sale when any SKU is, with the biggest discount among them', () => {
    const product = productWith(
      sku(100, undefined, 'a'),
      sku(90, 100, 'b'),
      sku(50, 100, 'c'),
    );

    expect(product.onSale).toBe(true);
    expect(product.discountPercent).toBe(50);
  });

  it('is not on sale when no SKU has an original price', () => {
    const product = productWith(
      sku(100, undefined, 'a'),
      sku(90, undefined, 'b'),
    );

    expect(product.onSale).toBe(false);
    expect(product.discountPercent).toBe(0);
  });

  it('follows its SKUs when they change', () => {
    const product = productWith(
      sku(300, undefined, 'a'),
      sku(500, undefined, 'b'),
    );
    expect(product.minPrice).toBe(300);

    product.updateSkuPrice('a', Price.create(700), null);
    expect(product.minPrice).toBe(500);

    product.updateSkuPrice('b', Price.create(400), Price.create(800));
    expect(product.minPrice).toBe(400);
    expect(product.onSale).toBe(true);
    expect(product.discountPercent).toBe(50);

    product.removeSku('b');
    expect(product.minPrice).toBe(700);
    expect(product.onSale).toBe(false);
  });

  it('refuses a discount that is not one when the price of a SKU changes, and changes nothing', () => {
    const product = productWith(sku(100, 150, 'a'));

    expect(refused(() => product.updateSkuPrice('a', Price.create(150)))).toBe(
      'CAT-018',
    );
    expect(product.minPrice).toBe(100);
  });

  it('a SKU added with an original price is checked as well', () => {
    const product = productWith();

    expect(
      refused(() =>
        product.addSku({
          price: Price.create(100),
          compareAtPrice: Price.create(90),
          attributes: SkuAttributes.create({ id: 'x' }),
          skuCode: 'x',
        }),
      ),
    ).toBe('CAT-018');
    expect(product.skus).toHaveLength(0);
  });
});
