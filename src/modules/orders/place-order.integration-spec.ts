import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import {
  CACHE,
  DatabaseModule,
  JobQueueModule,
  LockModule,
  PrismaService,
  RedisModule,
  RedisService,
} from '@/core/index.js';
import { CatalogMapper } from '../catalog/infrastructure/database/mappers/catalog.mapper.js';
import { PrismaProductRepository } from '../catalog/infrastructure/database/repositories/prisma-product.repository.js';
import { SkuLookupService } from '../catalog/application/index.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import {
  ReleaseExpiredReservationsCommand,
  ReleaseReservationCommand,
} from '../inventory/application/index.js';
import { RedisCartStore } from '../cart/infrastructure/index.js';
import { CartOrderingService } from '../cart/application/index.js';
import { PrismaAddressRepository } from '../users/infrastructure/database/prisma-address.repository.js';
import { GetAddressHandler } from '../users/application/index.js';
import { PrismaOrderRepository } from './infrastructure/index.js';
import {
  ConfirmOrderCommand,
  ConfirmOrderHandler,
  PlaceOrderCommand,
  PlaceOrderHandler,
  type ConfirmOrderResult,
  type PlaceOrderResult,
} from './application/index.js';
import { PaymentMethod, deriveOrderId } from './domain/index.js';

const USERS = Array.from({ length: 10 }, (_, i) => `ord_it_user_${i}`);
const [U1] = USERS;
const KEY = 'checkout-key-0001';

/**
 * Placing an order with the REAL catalog, inventory, cart, address book and order tables
 * (Postgres and Redis), through the command bus. Only the HTTP layer is left out.
 */
describe('Placing an order (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redis: ReturnType<RedisService['getClient']>;
  let commands: CommandBus;
  let cartStore: RedisCartStore;
  let orderRepo: PrismaOrderRepository;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
        RedisModule,
        LockModule,
        JobQueueModule,
        CqrsModule,
        InventoryModule,
      ],
      providers: [
        CatalogMapper,
        { provide: 'IProductRepository', useClass: PrismaProductRepository },
        SkuLookupService,
        RedisCartStore,
        { provide: 'ICartStore', useExisting: RedisCartStore },
        CartOrderingService,
        { provide: 'IAddressRepository', useClass: PrismaAddressRepository },
        GetAddressHandler,
        PrismaOrderRepository,
        { provide: 'IOrderRepository', useExisting: PrismaOrderRepository },
        PlaceOrderHandler,
        ConfirmOrderHandler,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    redis = module.get(RedisService).getClient();
    commands = module.get(CommandBus);
    cartStore = module.get(RedisCartStore);
    orderRepo = module.get(PrismaOrderRepository);
  });

  const cleanRedis = async () => {
    for (const pattern of [
      'ecom:v1:cart:*',
      'ecom:v1:inventory:*',
      'ecom:v1:lock:order:*',
    ]) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
  };
  const cleanPostgres = async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.order.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.address.deleteMany({ where: { userId: { in: USERS } } });
  };

  beforeAll(async () => {
    await prisma.province.upsert({
      where: { code: '97' },
      update: {},
      create: { code: '97', name: 'Tỉnh Thử Nghiệm', type: 'PROVINCE' },
    });
    await prisma.ward.upsert({
      where: { code: '97001' },
      update: {},
      create: {
        code: '97001',
        provinceCode: '97',
        name: 'Phường Thử Nghiệm',
        type: 'WARD',
      },
    });
    for (const id of USERS) {
      await prisma.user.upsert({ where: { id }, update: {}, create: { id } });
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanRedis();
    await cleanPostgres();
    await prisma.category.create({
      data: { id: 'ord_cat', name: 'C', path: '/ord_cat/' },
    });
    await prisma.product.create({
      data: {
        id: 'ord_prod',
        categoryId: 'ord_cat',
        name: 'AirPods',
        status: 'PUBLISHED',
        thumbnail: 'https://example.com/airpods.jpg',
      },
    });
    await prisma.product.create({
      data: {
        id: 'ord_draft',
        categoryId: 'ord_cat',
        name: 'Hidden',
        status: 'DRAFT',
      },
    });
  });

  afterAll(async () => {
    await cleanRedis();
    await cleanPostgres();
    await prisma.user.deleteMany({ where: { id: { in: USERS } } });
    await prisma.ward.deleteMany({ where: { code: '97001' } });
    await prisma.province.deleteMany({ where: { code: '97' } });
    await module.close();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const sku = async (
    id: string,
    price: number,
    stock: number,
    productId = 'ord_prod',
  ) => {
    await prisma.sku.create({
      data: {
        id,
        productId,
        price,
        attributes: { color: id },
        skuCode: `CODE-${id}`,
      },
    });
    await prisma.skuStock.create({ data: { skuId: id, onHand: stock } });
  };
  const address = async (userId = U1) => {
    const id = randomUUID();
    await prisma.address.create({
      data: {
        id,
        userId,
        recipientName: 'Nguyễn Văn A',
        phone: '0901234567',
        provinceCode: '97',
        provinceName: 'Tỉnh Thử Nghiệm',
        wardCode: '97001',
        wardName: 'Phường Thử Nghiệm',
        street: '12 Đường Thử',
        label: 'Nhà',
      },
    });
    return id;
  };
  const inCart = (
    skuId: string,
    quantity: number,
    seenPrice = 1,
    userId = U1,
  ) => cartStore.add(userId, skuId, quantity, seenPrice);
  const cartOf = async (userId = U1) =>
    (await cartStore.read(userId)).map((l) => [l.skuId, l.quantity]).sort();
  const place = (
    addressId: string,
    method: PaymentMethod,
    key = KEY,
    userId = U1,
  ) =>
    commands.execute<PlaceOrderCommand, PlaceOrderResult>(
      new PlaceOrderCommand(userId, key, addressId, method),
    );
  const failureOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return error as { code: string; details?: any };
    }
    throw new Error('should have failed');
  };
  const onHand = async (skuId: string) =>
    (await prisma.skuStock.findUniqueOrThrow({ where: { skuId } })).onHand;
  const available = async (skuId: string) =>
    Number(await redis.get(CACHE.INVENTORY.KEYS.AVAILABLE(skuId)));
  const reservations = (orderId: string) =>
    prisma.reservation.findMany({
      where: { orderId },
      orderBy: { skuId: 'asc' },
    });
  const events = (orderId: string) =>
    prisma.outboxEvent.findMany({
      where: { aggregateId: orderId },
      orderBy: { seq: 'asc' },
    });

  // ── AC-1, AC-2: online ─────────────────────────────────────────────────────

  describe('an online order (AC-1, AC-2)', () => {
    it('takes a snapshot of price and address, holds the stock, writes one event and empties the cart', async () => {
      await sku('S1', 3990000.5, 10);
      await sku('S2', 199000, 5);
      await inCart('S1', 2, 1); // the cart saw a price of 1; the order must use the current one
      await inCart('S2', 1);
      const addressId = await address();

      const { order, replayed } = await place(addressId, PaymentMethod.ONLINE);

      expect(replayed).toBe(false);
      expect(order).toMatchObject({
        id: deriveOrderId(U1, KEY),
        userId: U1,
        status: 'PENDING',
        paymentMethod: 'ONLINE',
        version: 1,
        total: 3990000.5 * 2 + 199000,
      });
      expect(
        order.items.map((i) => [i.skuId, i.unitPrice, i.quantity, i.lineTotal]),
      ).toEqual([
        ['S1', 3990000.5, 2, 7980001],
        ['S2', 199000, 1, 199000],
      ]);
      expect(order.items[0]).toMatchObject({
        productName: 'AirPods',
        thumbnail: 'https://example.com/airpods.jpg',
        attributes: { color: 'S1' },
      });
      expect(order.shippingAddress).toEqual({
        recipientName: 'Nguyễn Văn A',
        phone: '0901234567',
        provinceCode: '97',
        provinceName: 'Tỉnh Thử Nghiệm',
        wardCode: '97001',
        wardName: 'Phường Thử Nghiệm',
        street: '12 Đường Thử',
        label: 'Nhà',
      });
      const held = await reservations(order.id);
      expect(held.map((r) => [r.skuId, r.qty, r.status])).toEqual([
        ['S1', 2, 'RESERVED'],
        ['S2', 1, 'RESERVED'],
      ]);
      expect(order.expiresAt.getTime()).toBe(held[0].expiresAt.getTime());
      expect(await onHand('S1')).toBe(10); // held, not taken out
      expect(await available('S1')).toBe(8);
      expect((await events(order.id)).map((e) => e.type)).toEqual([
        'order.created',
      ]);
      expect(await cartOf()).toEqual([]);
      // What was written is what comes back
      expect(await orderRepo.findById(order.id)).toMatchObject({
        status: 'PENDING',
        total: order.total,
      });
    });

    it('does not confirm it: the order stays PENDING, no event but order.created', async () => {
      await sku('S1', 100, 5);
      await inCart('S1', 1);

      const { order } = await place(await address(), PaymentMethod.ONLINE);

      expect((await orderRepo.findById(order.id))?.status).toBe('PENDING');
      expect((await events(order.id)).map((e) => e.type)).toEqual([
        'order.created',
      ]);
    });
  });

  // ── AC-3: cash on delivery ─────────────────────────────────────────────────

  describe('a cash-on-delivery order (AC-3)', () => {
    it('is CONFIRMED at once: stock taken out of the warehouse, two events in order', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 3);

      const { order } = await place(await address(), PaymentMethod.COD);

      expect(order).toMatchObject({ status: 'CONFIRMED', version: 2 });
      expect((await reservations(order.id)).map((r) => r.status)).toEqual([
        'CONFIRMED',
      ]);
      expect(await onHand('S1')).toBe(7);
      expect(await available('S1')).toBe(7); // already counted as held: the same number
      const written = await events(order.id);
      expect(written.map((e) => e.type)).toEqual([
        'order.created',
        'order.status_changed',
      ]);
      expect(written[1].payload).toMatchObject({
        from: 'PENDING',
        to: 'CONFIRMED',
      });
      expect(await cartOf()).toEqual([]);
    });

    it('when confirming fails in the middle, answers PENDING, and a later confirm finishes it', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 3);
      const reservationRepo = module.get<any>('IReservationRepository', {
        strict: false,
      });
      vi.spyOn(reservationRepo, 'confirm').mockRejectedValueOnce(
        new Error('Postgres hiccup'),
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const { order } = await place(await address(), PaymentMethod.COD);

      expect(order.status).toBe('PENDING');
      expect(await cartOf()).toEqual([]); // the order is saved, so the cart is cleared
      expect(await onHand('S1')).toBe(10);

      const result = await commands.execute<
        ConfirmOrderCommand,
        ConfirmOrderResult
      >(new ConfirmOrderCommand(order.id));

      expect(result).toMatchObject({ kind: 'CONFIRMED' });
      expect(await onHand('S1')).toBe(7);
      expect((await events(order.id)).map((e) => e.type)).toEqual([
        'order.created',
        'order.status_changed',
      ]);
    });

    it('when the process dies between taking the stock out and moving the order, confirming again takes the stock out only once', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 3);
      vi.spyOn(orderRepo, 'transition').mockRejectedValueOnce(
        new Error('died'),
      );

      const { order } = await place(await address(), PaymentMethod.COD);

      expect(order.status).toBe('PENDING');
      expect(await onHand('S1')).toBe(7); // already out of the warehouse
      expect((await reservations(order.id))[0].status).toBe('CONFIRMED');

      await commands.execute(new ConfirmOrderCommand(order.id));

      expect((await orderRepo.findById(order.id))?.status).toBe('CONFIRMED');
      expect(await onHand('S1')).toBe(7);
    });

    it('reports HOLD_LOST when the held stock was given back before the order was confirmed', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 3);
      const reservationRepo = module.get<any>('IReservationRepository', {
        strict: false,
      });
      vi.spyOn(reservationRepo, 'confirm').mockRejectedValueOnce(
        new Error('hiccup'),
      );
      const { order } = await place(await address(), PaymentMethod.COD);
      await commands.execute(new ReleaseReservationCommand(order.id));

      const result = await commands.execute<
        ConfirmOrderCommand,
        ConfirmOrderResult
      >(new ConfirmOrderCommand(order.id));

      expect(result).toEqual({ kind: 'HOLD_LOST' });
      expect((await orderRepo.findById(order.id))?.status).toBe('PENDING');
      expect(await onHand('S1')).toBe(10);
    });
  });

  // ── AC-4: the same key again ───────────────────────────────────────────────

  describe('sending the request again (AC-4)', () => {
    it('gives back the same order, even when the cart is empty now, and writes nothing more', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      const addressId = await address();
      const first = await place(addressId, PaymentMethod.ONLINE);

      const again = await place(addressId, PaymentMethod.ONLINE);

      expect(again.replayed).toBe(true);
      expect(again.order.id).toBe(first.order.id);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.reservation.count()).toBe(1);
      expect(await events(first.order.id)).toHaveLength(1);
      expect(await available('S1')).toBe(8);
    });

    it('gives back the order as it is now (confirmed, cancelled...), not as it was', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      const addressId = await address();
      const first = await place(addressId, PaymentMethod.COD);

      const again = await place(addressId, PaymentMethod.COD);

      expect(first.order.status).toBe('CONFIRMED');
      expect(again).toMatchObject({
        replayed: true,
        order: { status: 'CONFIRMED' },
      });
    });

    it('refuses a key that is not acceptable (ORD-005) and changes nothing', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);

      const error = await failureOf(
        place(await address(), PaymentMethod.ONLINE, 'short'),
      );

      expect(error.code).toBe('ORD-005');
      expect(await cartOf()).toEqual([['S1', 2]]);
      expect(await prisma.reservation.count()).toBe(0);
    });

    it('treats the same key of two users as two orders', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 1, 1, USERS[0]);
      await inCart('S1', 1, 1, USERS[1]);

      const a = await place(
        await address(USERS[0]),
        PaymentMethod.ONLINE,
        KEY,
        USERS[0],
      );
      const b = await place(
        await address(USERS[1]),
        PaymentMethod.ONLINE,
        KEY,
        USERS[1],
      );

      expect(a.order.id).not.toBe(b.order.id);
      expect(b.replayed).toBe(false);
    });
  });

  // ── AC-5: at the same time ─────────────────────────────────────────────────

  describe('requests at the same time (AC-5)', () => {
    it.each([PaymentMethod.ONLINE, PaymentMethod.COD])(
      '5 requests with the same key (%s): one order, one hold, one event, one new and four replayed',
      async (method) => {
        await sku('S1', 100, 10);
        await inCart('S1', 2);
        const addressId = await address();

        const results = await Promise.all(
          Array.from({ length: 5 }, () => place(addressId, method)),
        );

        expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
        expect(results.filter((r) => !r.replayed)).toHaveLength(1);
        expect(results.filter((r) => r.replayed)).toHaveLength(4);
        const orderId = results[0].order.id;
        expect(await prisma.order.count()).toBe(1);
        expect(await reservations(orderId)).toHaveLength(1);
        const types = (await events(orderId)).map((e) => e.type);
        expect(types.filter((t) => t === 'order.created')).toHaveLength(1);
        expect(await onHand('S1')).toBe(method === PaymentMethod.COD ? 8 : 10);
        expect(await available('S1')).toBe(8);
      },
    );

    it('2 requests with different keys from the same cart: one order, the other says the cart is empty (ORD-003)', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      const addressId = await address();

      const results = await Promise.allSettled([
        place(addressId, PaymentMethod.ONLINE, 'checkout-key-AAAA'),
        place(addressId, PaymentMethod.ONLINE, 'checkout-key-BBBB'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(lost.reason.code).toBe('ORD-003');
      expect(await prisma.order.count()).toBe(1);
      expect(await available('S1')).toBe(8);
    });

    it('10 users after the last unit: one order, nine ORD-001 with the shortage, stock never below zero, their carts unchanged', async () => {
      await sku('LAST', 100, 1);
      const addresses: string[] = [];
      for (const userId of USERS) {
        await inCart('LAST', 1, 1, userId);
        addresses.push(await address(userId));
      }

      const results = await Promise.allSettled(
        USERS.map((userId, i) =>
          place(
            addresses[i],
            PaymentMethod.ONLINE,
            `last-unit-key-${i}`,
            userId,
          ),
        ),
      );

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(9);
      for (const loss of lost) {
        expect(loss.reason.code).toBe('ORD-001');
        expect(loss.reason.details.shortages).toEqual([
          { skuId: 'LAST', requested: 1, available: 0 },
        ]);
      }
      expect(await available('LAST')).toBe(0);
      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.reservation.count()).toBe(1);
      const winner = (won[0] as PromiseFulfilledResult<PlaceOrderResult>).value
        .order.userId;
      for (const userId of USERS) {
        expect(await cartOf(userId)).toEqual(
          userId === winner ? [] : [['LAST', 1]],
        );
      }
    });
  });

  // ── AC-6: cannot be placed, nothing left behind ────────────────────────────

  describe('an order that cannot be placed leaves nothing behind (AC-6)', () => {
    const nothingLeft = async (skuIds: string[]) => {
      expect(await prisma.order.count()).toBe(0);
      expect(await prisma.orderItem.count()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(await prisma.reservation.count()).toBe(0);
      for (const skuId of skuIds) {
        expect(await available(skuId)).toBeGreaterThanOrEqual(0);
      }
    };

    it('an empty cart: ORD-003', async () => {
      const error = await failureOf(
        place(await address(), PaymentMethod.ONLINE),
      );

      expect(error.code).toBe('ORD-003');
      await nothingLeft([]);
    });

    it('a product no longer on sale, or a SKU that is gone: ORD-004 with those SKUs', async () => {
      await sku('S_OK', 100, 10);
      await sku('S_HIDDEN', 100, 10, 'ord_draft');
      await inCart('S_OK', 1);
      await inCart('S_HIDDEN', 1);
      await inCart('S_GONE', 1);

      const error = await failureOf(
        place(await address(), PaymentMethod.ONLINE),
      );

      expect(error.code).toBe('ORD-004');
      expect([...error.details.skuIds].sort()).toEqual(['S_GONE', 'S_HIDDEN']);
      await nothingLeft(['S_OK']);
      expect(await cartOf()).toHaveLength(3);
      expect(await onHand('S_OK')).toBe(10);
    });

    it('one item short among two: ORD-001 for it, and the other item is not held either', async () => {
      await sku('S_PLENTY', 100, 10);
      await sku('S_SHORT', 100, 1);
      await inCart('S_PLENTY', 2);
      await inCart('S_SHORT', 3);

      const error = await failureOf(
        place(await address(), PaymentMethod.ONLINE),
      );

      expect(error.code).toBe('ORD-001');
      expect(error.details.shortages).toEqual([
        { skuId: 'S_SHORT', requested: 3, available: 1 },
      ]);
      await nothingLeft(['S_PLENTY', 'S_SHORT']);
      expect(await available('S_PLENTY')).toBe(10);
      expect(await cartOf()).toEqual([
        ['S_PLENTY', 2],
        ['S_SHORT', 3],
      ]);
    });

    it('an address of another user or that does not exist: ADDR-001, nothing held', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 1);
      const someoneElses = await address(USERS[1]);

      for (const addressId of [someoneElses, randomUUID()]) {
        const error = await failureOf(place(addressId, PaymentMethod.ONLINE));
        expect(error.code).toBe('ADDR-001');
      }

      await nothingLeft(['S1']);
      expect(await cartOf()).toEqual([['S1', 1]]);
    });

    it('Redis down while reading the cart: the error is not turned into an order', async () => {
      await sku('S1', 100, 10);
      vi.spyOn(cartStore, 'read').mockRejectedValueOnce(
        Object.assign(new Error('down'), { code: 'CART-005' }),
      );

      const error = await failureOf(
        place(await address(), PaymentMethod.ONLINE),
      );

      expect(error.code).toBe('CART-005');
      await nothingLeft(['S1']);
    });
  });

  // ── AC-7: snapshot ─────────────────────────────────────────────────────────

  it('keeps the order as it was placed when the price changes or the address is edited or deleted later (AC-7)', async () => {
    await sku('S1', 100, 10);
    await inCart('S1', 2);
    const addressId = await address();
    const { order } = await place(addressId, PaymentMethod.ONLINE);

    await prisma.sku.update({ where: { id: 'S1' }, data: { price: 999 } });
    await prisma.address.update({
      where: { id: addressId },
      data: { street: 'Somewhere else', phone: '0999999999' },
    });
    await prisma.address.delete({ where: { id: addressId } });

    const read = await orderRepo.findById(order.id);
    expect(read?.items[0].unitPrice).toBe(100);
    expect(read?.total).toBe(200);
    expect(read?.shippingAddress).toMatchObject({
      street: '12 Đường Thử',
      phone: '0901234567',
    });
  });

  // ── AC-8: the order and its event, or neither ──────────────────────────────

  describe('the order and its event, or neither (AC-8)', () => {
    it('when saving fails, nothing is saved, the cart is untouched and the stock stays held for this order', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      vi.spyOn(orderRepo, 'create').mockRejectedValueOnce(
        new Error('connection lost'),
      );

      await expect(
        place(await address(), PaymentMethod.ONLINE),
      ).rejects.toThrow('connection lost');

      expect(await prisma.order.count()).toBe(0);
      expect(await prisma.orderItem.count()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(
        (await prisma.reservation.findMany()).map((r) => r.status),
      ).toEqual(['RESERVED']);
      expect(await available('S1')).toBe(8);
      expect(await cartOf()).toEqual([['S1', 2]]);
    });

    it('sending the same request again after a failed save places the order with the same id, holding the stock once', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      const addressId = await address();
      vi.spyOn(orderRepo, 'create').mockRejectedValueOnce(
        new Error('connection lost'),
      );
      await expect(place(addressId, PaymentMethod.ONLINE)).rejects.toThrow(
        'connection lost',
      );

      const again = await place(addressId, PaymentMethod.ONLINE);

      expect(again.order.id).toBe(deriveOrderId(U1, KEY));
      expect(again.replayed).toBe(false);
      expect(await reservations(again.order.id)).toHaveLength(1);
      expect(await available('S1')).toBe(8);
      expect(await events(again.order.id)).toHaveLength(1);
      expect(await cartOf()).toEqual([]);
    });

    it('a cash-on-delivery order sent again after a failed save is confirmed as usual', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      const addressId = await address();
      vi.spyOn(orderRepo, 'create').mockRejectedValueOnce(
        new Error('connection lost'),
      );
      await expect(place(addressId, PaymentMethod.COD)).rejects.toThrow(
        'connection lost',
      );

      const again = await place(addressId, PaymentMethod.COD);

      expect(again.order.status).toBe('CONFIRMED');
      expect(await onHand('S1')).toBe(8);
    });

    it('a failed save nobody sends again: the hold expires by itself and the stock comes back', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      vi.spyOn(orderRepo, 'create').mockRejectedValueOnce(
        new Error('connection lost'),
      );
      await expect(
        place(await address(), PaymentMethod.ONLINE),
      ).rejects.toThrow('connection lost');
      await prisma.reservation.updateMany({
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await commands.execute(new ReleaseExpiredReservationsCommand());

      expect(
        (await prisma.reservation.findMany()).map((r) => r.status),
      ).toEqual(['RELEASED']);
      expect(await available('S1')).toBe(10);
    });

    it('a cart that cannot be cleared does not fail the order, and the order is not lost', async () => {
      await sku('S1', 100, 10);
      await inCart('S1', 2);
      vi.spyOn(cartStore, 'removeMany').mockRejectedValueOnce(
        new Error('Redis down'),
      );

      const { order } = await place(await address(), PaymentMethod.ONLINE);

      expect(await orderRepo.findById(order.id)).not.toBeNull();
      expect(await cartOf()).toEqual([['S1', 2]]);
    });

    it('only the ordered items leave the cart: an item put in after the order was read stays', async () => {
      await sku('S1', 100, 10);
      await sku('S2', 100, 10);
      await inCart('S1', 1);
      const addressId = await address();
      const original = cartStore.removeMany.bind(cartStore);
      vi.spyOn(cartStore, 'removeMany').mockImplementationOnce(
        async (userId, skuIds) => {
          await inCart('S2', 4); // the customer adds another item while the order is being placed
          return original(userId, skuIds);
        },
      );

      await place(addressId, PaymentMethod.ONLINE);

      expect(await cartOf()).toEqual([['S2', 4]]);
    });
  });
});
