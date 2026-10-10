import { summarise, viewLine } from './cart-view.js';
import type { CartLine, SkuInfo } from '../cart-line.js';

const line = (overrides: Partial<CartLine> = {}): CartLine => ({
  skuId: 'A',
  quantity: 2,
  addedPrice: 3990000,
  addedAt: 1_000,
  ...overrides,
});

const sku = (overrides: Partial<SkuInfo> = {}): SkuInfo => ({
  productId: 'P1',
  productName: 'AirPods',
  thumbnail: 'https://example.com/a.jpg',
  attributes: { color: 'White' },
  price: 3990000,
  published: true,
  ...overrides,
});

describe('viewLine (AC-8)', () => {
  it('has no flag when the price is the same and there is enough stock', () => {
    const view = viewLine(line(), sku(), 10);

    expect(view).toEqual({
      skuId: 'A',
      productId: 'P1',
      productName: 'AirPods',
      thumbnail: 'https://example.com/a.jpg',
      attributes: { color: 'White' },
      quantity: 2,
      price: 3990000,
      addedPrice: 3990000,
      available: 10,
      flags: [],
    });
  });

  it.each([
    ['the price went up', 4990000, 'priceChanged'],
    ['the price went down', 2990000, 'priceChanged'],
  ])('flags priceChanged when %s, and shows both prices', (_, now) => {
    const view = viewLine(line(), sku({ price: now }), 10);

    expect(view.flags).toEqual(['priceChanged']);
    expect(view.price).toBe(now);
    expect(view.addedPrice).toBe(3990000);
  });

  it('does not flag a price that only differs by floating point noise', () => {
    const view = viewLine(
      line({ addedPrice: 0.1 + 0.2 }),
      sku({ price: 0.3 }),
      10,
    );

    expect(view.flags).toEqual([]);
  });

  it('flags outOfStock when nothing is left', () => {
    expect(viewLine(line(), sku(), 0).flags).toEqual(['outOfStock']);
  });

  it('treats a missing stock number as nothing left', () => {
    expect(viewLine(line(), sku(), undefined).flags).toEqual(['outOfStock']);
    expect(viewLine(line(), sku(), undefined).available).toBe(0);
  });

  it('never shows a negative number of units', () => {
    const view = viewLine(line(), sku(), -3);

    expect(view.available).toBe(0);
    expect(view.flags).toEqual(['outOfStock']);
  });

  it.each([
    [1, true],
    [2, false], // exactly the quantity in the cart is enough
    [3, false],
  ])(
    'with %i left and 2 in the cart, notEnoughStock is %s',
    (left, flagged) => {
      const flags = viewLine(line({ quantity: 2 }), sku(), left).flags;

      expect(flags.includes('notEnoughStock')).toBe(flagged);
    },
  );

  it('can have priceChanged and notEnoughStock together, in a fixed order', () => {
    const view = viewLine(line({ quantity: 5 }), sku({ price: 4990000 }), 1);

    expect(view.flags).toEqual(['priceChanged', 'notEnoughStock']);
    expect(view.available).toBe(1);
  });

  it('says only "unpublished" when the product is no longer on sale, but still shows what it is', () => {
    const view = viewLine(line(), sku({ published: false, price: 1 }), 9);

    expect(view).toMatchObject({
      productName: 'AirPods',
      thumbnail: 'https://example.com/a.jpg',
      attributes: { color: 'White' },
      price: null,
      available: null,
      addedPrice: 3990000,
      flags: ['unpublished'],
    });
  });

  it('says only "unpublished", with nothing else known, when the SKU is gone from the catalog', () => {
    const view = viewLine(line(), undefined, undefined);

    expect(view).toEqual({
      skuId: 'A',
      productId: null,
      productName: null,
      thumbnail: null,
      attributes: null,
      quantity: 2,
      price: null,
      addedPrice: 3990000,
      available: null,
      flags: ['unpublished'],
    });
  });
});

describe('summarise (AC-8)', () => {
  const item = (
    skuId: string,
    quantity: number,
    price: number | null,
    flags: string[] = [],
  ) =>
    ({
      skuId,
      quantity,
      price,
      flags,
      productId: null,
      productName: null,
      thumbnail: null,
      attributes: null,
      addedPrice: price ?? 0,
      available: null,
    }) as unknown as ReturnType<typeof viewLine>;

  it('is zero for an empty cart', () => {
    expect(summarise([])).toEqual({
      items: [],
      subtotal: 0,
      lineCount: 0,
      quantityCount: 0,
    });
  });

  it('adds up only the lines that can be ordered as they are', () => {
    const result = summarise([
      item('A', 2, 1000),
      item('B', 1, 5000, ['priceChanged']), // the price is already the new one: counted
      item('C', 3, 700, ['outOfStock']),
      item('D', 3, 700, ['notEnoughStock']),
      item('E', 1, null, ['unpublished']),
    ]);

    expect(result.subtotal).toBe(2 * 1000 + 5000);
    expect(result.lineCount).toBe(5);
    expect(result.quantityCount).toBe(2 + 1 + 3 + 3 + 1);
  });

  it('has no floating point error', () => {
    const result = summarise([item('A', 3, 199000.5), item('B', 7, 0.1)]);

    expect(result.subtotal).toBe(597002.2); // 3 x 199000.50 + 7 x 0.10
  });

  it('keeps the order of the items it is given', () => {
    const items = [item('B', 1, 1), item('A', 1, 1)];

    expect(summarise(items).items.map((i) => i.skuId)).toEqual(['B', 'A']);
  });
});
