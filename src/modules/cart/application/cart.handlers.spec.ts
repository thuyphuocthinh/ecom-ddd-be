import { vi } from 'vitest';
import { AddCartItemHandler } from './commands/add-cart-item.handler.js';
import { SetCartItemQuantityHandler } from './commands/set-cart-item-quantity.handler.js';
import { RemoveCartItemHandler } from './commands/remove-cart-item.handler.js';
import { ClearCartHandler } from './commands/clear-cart.handler.js';
import { GetCartHandler } from './queries/get-cart.handler.js';
import type { SkuLookupService } from '../../catalog/application/index.js';
import type { StockAvailabilityService } from '../../inventory/application/index.js';
import type { ICartStore, CartLine } from '../domain/index.js';

const SKU = {
  skuId: 'A',
  productId: 'P1',
  productName: 'AirPods',
  thumbnail: null,
  attributes: { color: 'White' },
  price: 3990000,
  published: true,
};

const fakeStore = () => {
  const store = {
    add: vi.fn(),
    setQuantity: vi.fn(),
    remove: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    read: vi.fn(async (): Promise<CartLine[]> => []),
  };
  return store as typeof store & ICartStore;
};

const fakeSkus = (items: (typeof SKU)[] = []) => {
  const findMany = vi.fn(
    async (ids: string[]) =>
      new Map(
        items.filter((i) => ids.includes(i.skuId)).map((i) => [i.skuId, i]),
      ),
  );
  return { findMany } as unknown as SkuLookupService & {
    findMany: typeof findMany;
  };
};

const fakeStock = (numbers: Record<string, number> = {}) => {
  const getAvailable = vi.fn(
    async (ids: string[]) =>
      new Map(ids.map((id) => [id, numbers[id] ?? 0] as [string, number])),
  );
  return { getAvailable } as unknown as StockAvailabilityService & {
    getAvailable: typeof getAvailable;
  };
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error: any) {
    return error.code as string;
  }
  throw new Error('should have failed');
};

describe('AddCartItemHandler (AC-2, AC-3, AC-4, AC-5)', () => {
  it('records the price the catalog has now and answers with the line', async () => {
    const store = fakeStore();
    store.add.mockResolvedValue({ kind: 'OK', quantity: 5 });
    const handler = new AddCartItemHandler(store, fakeSkus([SKU]));

    const result = await handler.execute({
      userId: 'u1',
      skuId: 'A',
      quantity: 3,
    });

    expect(store.add).toHaveBeenCalledWith('u1', 'A', 3, 3990000);
    expect(result).toEqual({ skuId: 'A', quantity: 5, addedPrice: 3990000 });
  });

  it('answers CART-003 and writes nothing when the SKU does not exist', async () => {
    const store = fakeStore();
    const handler = new AddCartItemHandler(store, fakeSkus([]));

    expect(
      await codeOf(handler.execute({ userId: 'u1', skuId: 'A', quantity: 1 })),
    ).toBe('CART-003');
    expect(store.add).not.toHaveBeenCalled();
  });

  it('answers CART-003 and writes nothing when the product is no longer on sale', async () => {
    const store = fakeStore();
    const handler = new AddCartItemHandler(
      store,
      fakeSkus([{ ...SKU, published: false }]),
    );

    expect(
      await codeOf(handler.execute({ userId: 'u1', skuId: 'A', quantity: 1 })),
    ).toBe('CART-003');
    expect(store.add).not.toHaveBeenCalled();
  });

  it.each([
    ['LINES_FULL', 'CART-001'],
    ['QUANTITY_EXCEEDED', 'CART-002'],
  ])('turns the store answer %s into %s', async (kind, code) => {
    const store = fakeStore();
    store.add.mockResolvedValue({ kind });
    const handler = new AddCartItemHandler(store, fakeSkus([SKU]));

    expect(
      await codeOf(handler.execute({ userId: 'u1', skuId: 'A', quantity: 1 })),
    ).toBe(code);
  });
});

describe('SetCartItemQuantityHandler (AC-6)', () => {
  it('records the current price when the item is still on sale', async () => {
    const store = fakeStore();
    store.setQuantity.mockResolvedValue({
      kind: 'OK',
      quantity: 4,
      addedPrice: 3990000,
    });
    const handler = new SetCartItemQuantityHandler(store, fakeSkus([SKU]));

    const result = await handler.execute({
      userId: 'u1',
      skuId: 'A',
      quantity: 4,
    });

    expect(store.setQuantity).toHaveBeenCalledWith('u1', 'A', 4, 3990000);
    expect(result).toEqual({ skuId: 'A', quantity: 4, addedPrice: 3990000 });
  });

  it.each([
    ['the product is no longer on sale', [{ ...SKU, published: false }]],
    ['the SKU is gone from the catalog', []],
  ])('keeps the recorded price when %s', async (_, items) => {
    const store = fakeStore();
    store.setQuantity.mockResolvedValue({
      kind: 'OK',
      quantity: 1,
      addedPrice: 1000,
    });
    const handler = new SetCartItemQuantityHandler(store, fakeSkus(items));

    await handler.execute({ userId: 'u1', skuId: 'A', quantity: 1 });

    expect(store.setQuantity).toHaveBeenCalledWith('u1', 'A', 1, null);
  });

  it.each([
    ['NOT_IN_CART', 'CART-004'],
    ['QUANTITY_EXCEEDED', 'CART-002'],
  ])('turns the store answer %s into %s', async (kind, code) => {
    const store = fakeStore();
    store.setQuantity.mockResolvedValue({ kind });
    const handler = new SetCartItemQuantityHandler(store, fakeSkus([SKU]));

    expect(
      await codeOf(handler.execute({ userId: 'u1', skuId: 'A', quantity: 1 })),
    ).toBe(code);
  });
});

describe('RemoveCartItemHandler and ClearCartHandler (AC-7)', () => {
  it('pass the user and SKU to the store and never fail', async () => {
    const store = fakeStore();

    await expect(
      new RemoveCartItemHandler(store).execute({ userId: 'u1', skuId: 'A' }),
    ).resolves.toBeUndefined();
    await expect(
      new ClearCartHandler(store).execute({ userId: 'u1' }),
    ).resolves.toBeUndefined();

    expect(store.remove).toHaveBeenCalledWith('u1', 'A');
    expect(store.clear).toHaveBeenCalledWith('u1');
  });
});

describe('GetCartHandler (AC-1, AC-8, AC-9)', () => {
  const lines: CartLine[] = [
    { skuId: 'OLD', quantity: 1, addedPrice: 100, addedAt: 1_000 },
    { skuId: 'A', quantity: 2, addedPrice: 3990000, addedAt: 3_000 },
    { skuId: 'HIDDEN', quantity: 1, addedPrice: 500, addedAt: 2_000 },
    { skuId: 'GONE', quantity: 1, addedPrice: 500, addedAt: 500 },
  ];
  const skus = [
    SKU,
    { ...SKU, skuId: 'OLD', price: 100 },
    { ...SKU, skuId: 'HIDDEN', published: false },
  ];

  it('gives an empty cart without asking the catalog or the stock anything', async () => {
    const store = fakeStore();
    const catalog = fakeSkus(skus);
    const stock = fakeStock();

    const cart = await new GetCartHandler(store, catalog, stock).execute({
      userId: 'u1',
    });

    expect(cart).toEqual({
      items: [],
      subtotal: 0,
      lineCount: 0,
      quantityCount: 0,
    });
    expect(catalog.findMany).not.toHaveBeenCalled();
    expect(stock.getAvailable).not.toHaveBeenCalled();
  });

  it('asks the catalog once for all the items and the stock once for those still on sale', async () => {
    const store = fakeStore();
    store.read.mockResolvedValue(lines);
    const catalog = fakeSkus(skus);
    const stock = fakeStock({ A: 10, OLD: 10 });

    await new GetCartHandler(store, catalog, stock).execute({ userId: 'u1' });

    expect(catalog.findMany).toHaveBeenCalledTimes(1);
    expect([...catalog.findMany.mock.calls[0][0]].sort()).toEqual([
      'A',
      'GONE',
      'HIDDEN',
      'OLD',
    ]);
    expect(stock.getAvailable).toHaveBeenCalledTimes(1);
    expect([...stock.getAvailable.mock.calls[0][0]].sort()).toEqual([
      'A',
      'OLD',
    ]);
  });

  it('lists the newest item first and computes flags and totals', async () => {
    const store = fakeStore();
    store.read.mockResolvedValue(lines);
    const handler = new GetCartHandler(
      store,
      fakeSkus(skus),
      fakeStock({ A: 1, OLD: 10 }),
    );

    const cart = await handler.execute({ userId: 'u1' });

    expect(cart.items.map((i) => i.skuId)).toEqual([
      'A',
      'HIDDEN',
      'OLD',
      'GONE',
    ]);
    expect(
      Object.fromEntries(cart.items.map((i) => [i.skuId, i.flags])),
    ).toEqual({
      A: ['notEnoughStock'], // 1 left, 2 in the cart
      HIDDEN: ['unpublished'],
      OLD: [],
      GONE: ['unpublished'],
    });
    // only OLD can be ordered as it is
    expect(cart.subtotal).toBe(100);
    expect(cart.lineCount).toBe(4);
    expect(cart.quantityCount).toBe(5);
  });

  it('is not troubled by one bad item: the others are still shown', async () => {
    const store = fakeStore();
    store.read.mockResolvedValue([
      { skuId: 'GONE', quantity: 1, addedPrice: 1, addedAt: 2 },
      { skuId: 'A', quantity: 1, addedPrice: 3990000, addedAt: 1 },
    ]);
    const handler = new GetCartHandler(
      store,
      fakeSkus([SKU]),
      fakeStock({ A: 5 }),
    );

    const cart = await handler.execute({ userId: 'u1' });

    expect(cart.items.map((i) => i.flags)).toEqual([['unpublished'], []]);
    expect(cart.subtotal).toBe(3990000);
  });
});
