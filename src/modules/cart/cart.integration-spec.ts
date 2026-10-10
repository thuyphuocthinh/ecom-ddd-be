import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import {
  CACHE,
  DatabaseModule,
  LockModule,
  PrismaService,
  RedisModule,
  RedisService,
} from '@/core/index.js';
import { CatalogMapper } from '../catalog/infrastructure/database/mappers/catalog.mapper.js';
import { PrismaProductRepository } from '../catalog/infrastructure/database/repositories/prisma-product.repository.js';
import { SkuLookupService } from '../catalog/application/index.js';
import {
  PrismaStockRepository,
  RedisAvailabilityStore,
} from '../inventory/infrastructure/index.js';
import {
  StockAvailabilityService,
  StockRebuilder,
} from '../inventory/application/index.js';
import { RedisCartStore } from './infrastructure/index.js';
import {
  AddCartItemCommand,
  AddCartItemHandler,
  ClearCartCommand,
  ClearCartHandler,
  GetCartHandler,
  GetCartQuery,
  RemoveCartItemCommand,
  RemoveCartItemHandler,
  SetCartItemQuantityCommand,
  SetCartItemQuantityHandler,
} from './application/index.js';
import type { CartItemResult } from './application/index.js';
import type { CartView } from './domain/index.js';

const U1 = 'cart_it_user_1';

/**
 * The cart with the REAL catalog and inventory behind it (Postgres and Redis), through the
 * command and query buses. Only the HTTP layer is left out; test/cart.e2e-spec.ts has that.
 */
describe('Cart with the real catalog and stock (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redis: ReturnType<RedisService['getClient']>;
  let commands: CommandBus;
  let queries: QueryBus;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
        RedisModule,
        LockModule,
        CqrsModule,
      ],
      providers: [
        CatalogMapper,
        { provide: 'IProductRepository', useClass: PrismaProductRepository },
        SkuLookupService,
        { provide: 'IStockRepository', useClass: PrismaStockRepository },
        { provide: 'IAvailabilityStore', useClass: RedisAvailabilityStore },
        StockRebuilder,
        StockAvailabilityService,
        { provide: 'ICartStore', useClass: RedisCartStore },
        AddCartItemHandler,
        SetCartItemQuantityHandler,
        RemoveCartItemHandler,
        ClearCartHandler,
        GetCartHandler,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    redis = module.get(RedisService).getClient();
    commands = module.get(CommandBus);
    queries = module.get(QueryBus);
  });

  const cleanRedis = async () => {
    for (const pattern of ['ecom:v1:cart:*', 'ecom:v1:inventory:*']) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
  };
  const cleanPostgres = async () => {
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
  };

  beforeEach(async () => {
    await cleanRedis();
    await cleanPostgres();
    await prisma.category.create({
      data: { id: 'cart_cat', name: 'C', path: '/cart_cat/' },
    });
    await product('P_ON', 'PUBLISHED', 'AirPods');
    await product('P_DRAFT', 'DRAFT', 'Not on sale');
  });

  afterAll(async () => {
    await cleanRedis();
    await cleanPostgres();
    await module.close();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const product = (id: string, status: 'PUBLISHED' | 'DRAFT', name: string) =>
    prisma.product.create({
      data: {
        id,
        categoryId: 'cart_cat',
        name,
        status,
        thumbnail: `https://example.com/${id}.jpg`,
      },
    });
  const sku = (id: string, productId: string, price: number, stock?: number) =>
    prisma.sku
      .create({
        data: {
          id,
          productId,
          price,
          attributes: { color: id },
          skuCode: `CODE-${id}`,
        },
      })
      .then(async (created) => {
        if (stock !== undefined) {
          await prisma.skuStock.create({ data: { skuId: id, onHand: stock } });
        }
        return created;
      });
  const add = (skuId: string, quantity = 1, userId = U1) =>
    commands.execute<AddCartItemCommand, CartItemResult>(
      new AddCartItemCommand(userId, skuId, quantity),
    );
  const setQuantity = (skuId: string, quantity: number, userId = U1) =>
    commands.execute<SetCartItemQuantityCommand, CartItemResult>(
      new SetCartItemQuantityCommand(userId, skuId, quantity),
    );
  const view = (userId = U1) =>
    queries.execute<GetCartQuery, CartView>(new GetCartQuery(userId));
  const lineOf = async (skuId: string) =>
    (await view()).items.find((item) => item.skuId === skuId)!;
  const failureOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return error.code as string;
    }
    throw new Error('should have failed');
  };
  const stockKey = (skuId: string) => CACHE.INVENTORY.KEYS.AVAILABLE(skuId);

  // ── what can go in (AC-2, AC-4) ────────────────────────────────────────────

  it('puts a SKU in at the price it has now (AC-2)', async () => {
    await sku('S1', 'P_ON', 3990000.5, 10);

    const result = await add('S1', 2);

    expect(result).toEqual({ skuId: 'S1', quantity: 2, addedPrice: 3990000.5 });
  });

  it('refuses a SKU that does not exist or whose product is not on sale, and writes nothing (AC-4)', async () => {
    await sku('S_DRAFT', 'P_DRAFT', 1000, 10);

    expect(await failureOf(add('S_DRAFT'))).toBe('CART-003');
    expect(await failureOf(add('NO-SUCH-SKU'))).toBe('CART-003');
    expect((await view()).items).toEqual([]);
  });

  it('turns away the 51st different SKU with CART-001 (AC-5)', async () => {
    await prisma.sku.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        id: `M${i}`,
        productId: 'P_ON',
        price: 1000,
        attributes: { n: String(i) },
        skuCode: `CODE-M${i}`,
      })),
    });
    for (let i = 0; i < 50; i++) await add(`M${i}`);

    expect(await failureOf(add('M50'))).toBe('CART-001');
    expect(await add('M3', 2)).toMatchObject({ quantity: 3 }); // an existing line still takes more
    expect((await view()).lineCount).toBe(50);
  });

  // ── the view looks everything up again (AC-8) ──────────────────────────────

  describe('viewing (AC-8)', () => {
    it('shows the name, picture, attributes, price and stock of each line', async () => {
      await sku('S1', 'P_ON', 1000, 10);
      await add('S1', 2);

      const item = await lineOf('S1');

      expect(item).toMatchObject({
        productId: 'P_ON',
        productName: 'AirPods',
        thumbnail: 'https://example.com/P_ON.jpg',
        attributes: { color: 'S1' },
        quantity: 2,
        price: 1000,
        addedPrice: 1000,
        available: 10,
        flags: [],
      });
      expect((await view()).subtotal).toBe(2000);
    });

    it('flags priceChanged with both prices after the price changes', async () => {
      await sku('S1', 'P_ON', 3990000, 10);
      await add('S1');

      await prisma.sku.update({
        where: { id: 'S1' },
        data: { price: 4990000 },
      });
      const item = await lineOf('S1');

      expect(item).toMatchObject({
        price: 4990000,
        addedPrice: 3990000,
        flags: ['priceChanged'],
      });
      expect((await view()).subtotal).toBe(4990000); // counted at the new price
    });

    it('flags outOfStock and notEnoughStock', async () => {
      await sku('S_ZERO', 'P_ON', 1000, 0);
      await sku('S_FEW', 'P_ON', 1000, 1);
      await add('S_ZERO');
      await add('S_FEW', 3);

      const cart = await view();

      expect(
        Object.fromEntries(cart.items.map((i) => [i.skuId, i.flags])),
      ).toEqual({
        S_ZERO: ['outOfStock'],
        S_FEW: ['notEnoughStock'],
      });
      expect(cart.items.find((i) => i.skuId === 'S_FEW')!.available).toBe(1);
      expect(cart.subtotal).toBe(0); // neither can be ordered as it is
    });

    it('counts a SKU without any stock row as sold out, and does not make a number for it in Redis', async () => {
      await sku('S_NOROW', 'P_ON', 1000); // no stock row
      await add('S_NOROW');

      const item = await lineOf('S_NOROW');

      expect(item.flags).toEqual(['outOfStock']);
      expect(item.available).toBe(0);
      expect(await redis.exists(stockKey('S_NOROW'))).toBe(0);
    });

    it('flags unpublished, hiding price and stock, when the product is taken off sale', async () => {
      await sku('S1', 'P_ON', 1000, 10);
      await sku('S2', 'P_ON', 500, 10);
      await add('S1');
      await add('S2');

      await prisma.product.update({
        where: { id: 'P_ON' },
        data: { status: 'DRAFT' },
      });
      const cart = await view();

      for (const item of cart.items) {
        expect(item).toMatchObject({
          productName: 'AirPods', // it is still known what it was
          price: null,
          available: null,
          flags: ['unpublished'],
        });
      }
      expect(cart.subtotal).toBe(0);
    });

    it('flags unpublished with nothing else known when the SKU is deleted, and the other lines are fine', async () => {
      await sku('S_KEEP', 'P_ON', 1000, 10);
      await sku('S_GONE', 'P_ON', 1000, 10);
      await add('S_KEEP');
      await add('S_GONE');

      await prisma.skuStock.delete({ where: { skuId: 'S_GONE' } });
      await prisma.sku.delete({ where: { id: 'S_GONE' } });
      const cart = await view();

      expect(cart.items.find((i) => i.skuId === 'S_GONE')).toMatchObject({
        productName: null,
        thumbnail: null,
        attributes: null,
        price: null,
        flags: ['unpublished'],
      });
      expect(cart.items.find((i) => i.skuId === 'S_KEEP')!.flags).toEqual([]);
      expect(cart.subtotal).toBe(1000);
    });

    it('lists the newest item first', async () => {
      await sku('S1', 'P_ON', 1000, 10);
      await sku('S2', 'P_ON', 1000, 10);
      await sku('S3', 'P_ON', 1000, 10);
      await add('S1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await add('S2');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await add('S3');
      await add('S1'); // adding more of the first does not make it the newest

      expect((await view()).items.map((i) => i.skuId)).toEqual([
        'S3',
        'S2',
        'S1',
      ]);
    });

    it('gives an empty cart for a user who never added anything (AC-1)', async () => {
      expect(await view()).toEqual({
        items: [],
        subtotal: 0,
        lineCount: 0,
        quantityCount: 0,
      });
    });
  });

  // ── the price the customer saw (AC-3, AC-6) ────────────────────────────────

  describe('the recorded price', () => {
    it('is renewed when more is added or the quantity is set, because the customer has just seen the price', async () => {
      await sku('S1', 'P_ON', 1000, 10);
      await add('S1');

      await prisma.sku.update({ where: { id: 'S1' }, data: { price: 1500 } });
      expect((await lineOf('S1')).flags).toEqual(['priceChanged']);
      const set = await setQuantity('S1', 3);
      expect(set).toEqual({ skuId: 'S1', quantity: 3, addedPrice: 1500 });
      expect((await lineOf('S1')).flags).toEqual([]);

      await prisma.sku.update({ where: { id: 'S1' }, data: { price: 1800 } });
      const added = await add('S1', 1);
      expect(added).toEqual({ skuId: 'S1', quantity: 4, addedPrice: 1800 });
      expect((await lineOf('S1')).flags).toEqual([]);
    });

    it('is not renewed by viewing', async () => {
      await sku('S1', 'P_ON', 1000, 10);
      await add('S1');
      await prisma.sku.update({ where: { id: 'S1' }, data: { price: 1500 } });

      await view();
      await view();

      expect((await lineOf('S1')).addedPrice).toBe(1000);
    });

    it('stays as it was when the quantity of an item that is no longer on sale is changed', async () => {
      await sku('S1', 'P_ON', 1000, 10);
      await add('S1', 5);
      await prisma.sku.update({ where: { id: 'S1' }, data: { price: 1500 } });
      await prisma.product.update({
        where: { id: 'P_ON' },
        data: { status: 'DRAFT' },
      });

      const result = await setQuantity('S1', 2);

      expect(result).toEqual({ skuId: 'S1', quantity: 2, addedPrice: 1000 });
    });

    it('is not created by setting the quantity of a line that is not there (CART-004)', async () => {
      await sku('S1', 'P_ON', 1000, 10);

      expect(await failureOf(setQuantity('S1', 2))).toBe('CART-004');
      expect((await view()).items).toEqual([]);
    });
  });

  // ── stock that Redis lost (AC-16 of the inventory) ─────────────────────────

  it('still shows the right stock when Redis lost its numbers, and puts them back', async () => {
    await sku('S1', 'P_ON', 1000, 10);
    await sku('S2', 'P_ON', 1000, 2);
    await add('S1');
    await add('S2', 3);
    await redis.del(stockKey('S1'), stockKey('S2'));

    const cart = await view();

    expect(cart.items.find((i) => i.skuId === 'S1')).toMatchObject({
      available: 10,
      flags: [],
    });
    expect(cart.items.find((i) => i.skuId === 'S2')).toMatchObject({
      available: 2,
      flags: ['notEnoughStock'],
    });
    expect(await redis.get(stockKey('S1'))).toBe('10');
    expect(await redis.get(stockKey('S2'))).toBe('2');
  });

  it('subtracts what is held for other orders (the stock is what can be sold now)', async () => {
    await sku('S1', 'P_ON', 1000, 10);
    await add('S1', 4);
    await prisma.reservation.create({
      data: {
        id: 'cart_res_1',
        orderId: 'cart_order_1',
        skuId: 'S1',
        qty: 8,
        expiresAt: new Date(Date.now() + 900_000),
      },
    });

    const item = await lineOf('S1'); // Redis has no number yet: rebuilt as 10 - 8

    expect(item).toMatchObject({ available: 2, flags: ['notEnoughStock'] });
  });

  // ── the cart holds nothing (AC-10) ─────────────────────────────────────────

  it('never changes the stock or makes a reservation, whatever is done with the cart', async () => {
    await sku('S1', 'P_ON', 1000, 10);
    await sku('S2', 'P_ON', 1000, 5);
    // give Redis its numbers
    await view();
    await add('S1');
    await view();
    const before = {
      onHand: (
        await prisma.skuStock.findMany({ orderBy: { skuId: 'asc' } })
      ).map((s) => s.onHand),
      s1: await redis.get(stockKey('S1')),
    };

    await add('S1', 5);
    await add('S2', 2);
    await setQuantity('S1', 7);
    await view();
    await commands.execute(new RemoveCartItemCommand(U1, 'S2'));
    await commands.execute(new ClearCartCommand(U1));

    expect(
      (await prisma.skuStock.findMany({ orderBy: { skuId: 'asc' } })).map(
        (s) => s.onHand,
      ),
    ).toEqual(before.onHand);
    expect(await redis.get(stockKey('S1'))).toBe(before.s1);
    // looking at the cart may put a number in Redis for the first time, but only the one Postgres has
    expect([null, '5']).toContain(await redis.get(stockKey('S2')));
    expect(await prisma.reservation.count()).toBe(0);
  });

  // ── one question for everything (AC-9) ─────────────────────────────────────

  it('asks Postgres once and Redis for the stock once, however many items are in the cart', async () => {
    await prisma.sku.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `B${i}`,
        productId: 'P_ON',
        price: 1000,
        attributes: { n: String(i) },
        skuCode: `CODE-B${i}`,
      })),
    });
    await prisma.skuStock.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        skuId: `B${i}`,
        onHand: 10,
      })),
    });
    for (let i = 0; i < 20; i++) await add(`B${i}`);
    await view(); // numbers now exist in Redis
    const findMany = vi.spyOn(prisma.sku, 'findMany');
    const peek = vi.spyOn(
      module.get<RedisAvailabilityStore>('IAvailabilityStore'),
      'peek',
    );

    const cart = await view();

    expect(cart.lineCount).toBe(20);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek.mock.calls[0][0]).toHaveLength(20);
    findMany.mockRestore();
    peek.mockRestore();
  });

  // ── carts of different users (AC-13) ───────────────────────────────────────

  it('keeps the carts of two users apart', async () => {
    await sku('S1', 'P_ON', 1000, 10);
    await add('S1', 2, 'cart_it_user_1');
    await add('S1', 5, 'cart_it_user_2');

    expect((await view('cart_it_user_1')).items[0].quantity).toBe(2);
    expect((await view('cart_it_user_2')).items[0].quantity).toBe(5);

    await commands.execute(new ClearCartCommand('cart_it_user_1'));
    expect((await view('cart_it_user_1')).items).toEqual([]);
    expect((await view('cart_it_user_2')).items[0].quantity).toBe(5);
  });
});
