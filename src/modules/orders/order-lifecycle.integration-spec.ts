import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
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
  ConfirmReservationCommand,
  ReleaseExpiredReservationsCommand,
  ReleaseReservationCommand,
} from '../inventory/application/index.js';
import { RedisCartStore } from '../cart/infrastructure/index.js';
import { CartOrderingService } from '../cart/application/index.js';
import { PrismaAddressRepository } from '../users/infrastructure/database/prisma-address.repository.js';
import { GetAddressHandler } from '../users/application/index.js';
import { PrismaOrderRepository } from './infrastructure/index.js';
import {
  CancelOrderCommand,
  CancelOrderHandler,
  ConfirmOrderCommand,
  ConfirmOrderHandler,
  ExpireDueOrdersCommand,
  ExpireDueOrdersHandler,
  FinishPendingCodOrdersCommand,
  FinishPendingCodOrdersHandler,
  OrderMaintenance,
  OrderStockReturner,
  PlaceOrderCommand,
  PlaceOrderHandler,
  ReturnStockForCancelledOrdersCommand,
  ReturnStockForCancelledOrdersHandler,
  type PlaceOrderResult,
} from './application/index.js';
import {
  OrderStatus,
  PaymentMethod,
  deriveOrderId,
  orderStatusChangedEvent,
  type Order,
} from './domain/index.js';
import { ordersConfig } from './orders.config.js';

const U1 = 'ord_life_user_1';
const U2 = 'ord_life_user_2';
const USERS = [U1, U2];
// The database clock can differ from this machine's by a second or so, so "long ago" is generous
const LONG_AGO = 3_600_000;

/**
 * What happens to an order after it is placed: cancel (pending and confirmed), expiry, the
 * cash-on-delivery sweep, putting stock back, and every race between them. The real catalog,
 * inventory, cart, address book and order tables (Postgres and Redis), through the command bus.
 */
describe('The life of an order (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redis: ReturnType<RedisService['getClient']>;
  let commands: CommandBus;
  let cartStore: RedisCartStore;
  let orderRepo: PrismaOrderRepository;
  let maintenance: OrderMaintenance;
  let addressId: string;

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
        {
          provide: ordersConfig.KEY,
          useValue: {
            outboxIntervalMs: 0,
            outboxBatchSize: 50,
            maintenanceIntervalSeconds: 0,
          },
        },
        OrderStockReturner,
        PlaceOrderHandler,
        ConfirmOrderHandler,
        CancelOrderHandler,
        ExpireDueOrdersHandler,
        FinishPendingCodOrdersHandler,
        ReturnStockForCancelledOrdersHandler,
        OrderMaintenance,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    redis = module.get(RedisService).getClient();
    commands = module.get(CommandBus);
    cartStore = module.get(RedisCartStore);
    orderRepo = module.get(PrismaOrderRepository);
    maintenance = module.get(OrderMaintenance);

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

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanRedis();
    await cleanPostgres();
    await prisma.category.create({
      data: { id: 'life_cat', name: 'C', path: '/life_cat/' },
    });
    await prisma.product.create({
      data: {
        id: 'life_prod',
        categoryId: 'life_cat',
        name: 'AirPods',
        status: 'PUBLISHED',
      },
    });
    addressId = `life-address-${Date.now()}`;
    await prisma.address.create({
      data: {
        id: addressId,
        userId: U1,
        recipientName: 'A',
        phone: '0901234567',
        provinceCode: '97',
        provinceName: 'Tỉnh Thử Nghiệm',
        wardCode: '97001',
        wardName: 'Phường Thử Nghiệm',
        street: '1 Đường Thử',
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

  let counter = 0;
  /**
   * Places an order of 3 units of its own SKU (stock 10) and gives back what is needed to check
   * it. `confirmFailure` makes the first confirm of a cash-on-delivery order fail, which leaves
   * the order PENDING with its stock held.
   */
  const placed = async (
    method: PaymentMethod,
    options: { confirmFailure?: boolean } = {},
  ) => {
    const n = ++counter;
    const skuId = `LIFE_${n}`;
    await prisma.sku.create({
      data: {
        id: skuId,
        productId: 'life_prod',
        price: 100,
        attributes: { n: String(n) },
        skuCode: `CODE-${skuId}`,
      },
    });
    await prisma.skuStock.create({ data: { skuId, onHand: 10 } });
    await cartStore.add(U1, skuId, 3, 100);
    if (options.confirmFailure) {
      const reservationRepo = module.get<any>('IReservationRepository', {
        strict: false,
      });
      vi.spyOn(reservationRepo, 'confirm').mockRejectedValueOnce(
        new Error('Postgres hiccup'),
      );
    }
    const { order } = await commands.execute<
      PlaceOrderCommand,
      PlaceOrderResult
    >(new PlaceOrderCommand(U1, `life-key-${n}-xxxx`, addressId, method));
    vi.restoreAllMocks();
    return { order, skuId };
  };
  /** An online order after a successful payment (the payment module will do this for real). */
  const paid = async () => {
    const made = await placed(PaymentMethod.ONLINE);
    const o = made.order;
    await orderRepo.transition(
      o.id,
      OrderStatus.PENDING,
      OrderStatus.PAYMENT_PROCESSING,
      orderStatusChangedEvent(
        o,
        OrderStatus.PENDING,
        OrderStatus.PAYMENT_PROCESSING,
      ),
    );
    await commands.execute(new ConfirmReservationCommand(o.id));
    await orderRepo.transition(
      o.id,
      OrderStatus.PAYMENT_PROCESSING,
      OrderStatus.CONFIRMED,
      orderStatusChangedEvent(
        o,
        OrderStatus.PAYMENT_PROCESSING,
        OrderStatus.CONFIRMED,
      ),
    );
    return made;
  };
  const move = (o: Order, from: OrderStatus, to: OrderStatus) =>
    orderRepo.transition(o.id, from, to, orderStatusChangedEvent(o, from, to));
  const cancel = (orderId: string, userId = U1) =>
    commands.execute<CancelOrderCommand, Order>(
      new CancelOrderCommand(userId, orderId),
    );
  const failureOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return error.code as string;
    }
    throw new Error('should have failed');
  };
  const reload = async (orderId: string) =>
    (await orderRepo.findById(orderId))!;
  const onHand = async (skuId: string) =>
    (await prisma.skuStock.findUniqueOrThrow({ where: { skuId } })).onHand;
  const available = async (skuId: string) =>
    Number(await redis.get(CACHE.INVENTORY.KEYS.AVAILABLE(skuId)));
  const reservationStatus = async (orderId: string) =>
    (await prisma.reservation.findMany({ where: { orderId } })).map(
      (r) => r.status,
    );
  const eventTypes = async (orderId: string) =>
    (
      await prisma.outboxEvent.findMany({
        where: { aggregateId: orderId },
        orderBy: { seq: 'asc' },
      })
    ).map((e) => e.type);
  const statusChanges = async (orderId: string) =>
    (
      await prisma.outboxEvent.findMany({
        where: { aggregateId: orderId, type: 'order.status_changed' },
        orderBy: { seq: 'asc' },
      })
    ).map((e) => `${(e.payload as any).from}>${(e.payload as any).to}`);
  /** Moves a time column of the order back, to look like it was set long ago (database clock). */
  const setColumn = (orderId: string, column: string, agoMs: number) =>
    prisma.$executeRawUnsafe(
      `UPDATE "Order" SET "${column}" = (now() AT TIME ZONE 'UTC') - make_interval(secs => $1) WHERE "id" = $2`,
      agoMs / 1000,
      orderId,
    );

  // ── AC-12: the customer cancels ────────────────────────────────────────────

  describe('cancelling a PENDING order (AC-12)', () => {
    it('cancels it, gives the held stock back in Postgres and in Redis, and writes the event', async () => {
      const { order, skuId } = await placed(PaymentMethod.ONLINE);
      expect(await available(skuId)).toBe(7);

      const cancelled = await cancel(order.id);

      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        version: 2,
        stockReturnPending: false,
      });
      expect(await reservationStatus(order.id)).toEqual(['RELEASED']);
      expect(await available(skuId)).toBe(10);
      expect(await onHand(skuId)).toBe(10);
      expect(await statusChanges(order.id)).toEqual(['PENDING>CANCELLED']);
    });

    it('also cancels a cash-on-delivery order that is still PENDING', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD, {
        confirmFailure: true,
      });
      expect(order.status).toBe('PENDING');

      await cancel(order.id);

      expect((await reload(order.id)).status).toBe('CANCELLED');
      expect(await available(skuId)).toBe(10);
    });

    it('still cancels when the held stock cannot be given back; the hold then expires by itself', async () => {
      const { order, skuId } = await placed(PaymentMethod.ONLINE);
      const real = commands.execute.bind(commands);
      vi.spyOn(commands, 'execute').mockImplementation((command: any) =>
        command instanceof ReleaseReservationCommand
          ? Promise.reject(new Error('Redis down'))
          : real(command),
      );

      const cancelled = await cancel(order.id);
      vi.restoreAllMocks();

      expect(cancelled.status).toBe('CANCELLED');
      expect(await reservationStatus(order.id)).toEqual(['RESERVED']);
      await prisma.reservation.updateMany({
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await commands.execute(new ReleaseExpiredReservationsCommand());
      expect(await reservationStatus(order.id)).toEqual(['RELEASED']);
      expect(await available(skuId)).toBe(10);
    });
  });

  describe('cancelling a CONFIRMED order (AC-12)', () => {
    it.each([PaymentMethod.COD, PaymentMethod.ONLINE])(
      '%s: cancels it and puts the stock back (onHand, Reservation RETURNED, Redis), flag off, events in order',
      async (method) => {
        const { order, skuId } =
          method === PaymentMethod.COD
            ? await placed(PaymentMethod.COD)
            : await paid();
        expect(await onHand(skuId)).toBe(7);
        expect(await available(skuId)).toBe(7);

        const cancelled = await cancel(order.id);

        expect(cancelled).toMatchObject({
          status: 'CANCELLED',
          stockReturnPending: false,
        });
        expect(await reservationStatus(order.id)).toEqual(['RETURNED']);
        expect(await onHand(skuId)).toBe(10);
        expect(await available(skuId)).toBe(10);
        expect((await reload(order.id)).stockReturnPending).toBe(false);
        expect(await statusChanges(order.id)).toEqual(
          method === PaymentMethod.COD
            ? ['PENDING>CONFIRMED', 'CONFIRMED>CANCELLED']
            : [
                'PENDING>PAYMENT_PROCESSING',
                'PAYMENT_PROCESSING>CONFIRMED',
                'CONFIRMED>CANCELLED',
              ],
        );
      },
    );

    it('when putting the stock back fails: the order is still cancelled, the flag stays on, and the sweep puts the stock back once', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD);
      const reservationRepo = module.get<any>('IReservationRepository', {
        strict: false,
      });
      vi.spyOn(reservationRepo, 'returnConfirmed').mockRejectedValueOnce(
        new Error('Postgres down'),
      );

      const cancelled = await cancel(order.id);

      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        stockReturnPending: true,
      });
      expect(await onHand(skuId)).toBe(7); // not back yet
      // Too fresh for the sweep: the request that is working on it gets its chance
      expect(
        await commands.execute(new ReturnStockForCancelledOrdersCommand()),
      ).toBe(0);

      await setColumn(order.id, 'updatedAt', LONG_AGO);
      expect(
        await commands.execute(new ReturnStockForCancelledOrdersCommand()),
      ).toBe(1);

      expect(await onHand(skuId)).toBe(10);
      expect(await available(skuId)).toBe(10);
      expect(await reservationStatus(order.id)).toEqual(['RETURNED']);
      expect((await reload(order.id)).stockReturnPending).toBe(false);
      // Again, and again: nothing more happens, the stock is never added twice
      expect(
        await commands.execute(new ReturnStockForCancelledOrdersCommand()),
      ).toBe(0);
      expect(await onHand(skuId)).toBe(10);
      expect(await available(skuId)).toBe(10);
    });

    it('a process that dies right after the cancel (flag on, nothing else done) is repaired by the sweep', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD);
      // What the cancel step leaves behind when the request dies straight after it
      await orderRepo.transition(
        order.id,
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
        orderStatusChangedEvent(
          order,
          OrderStatus.CONFIRMED,
          OrderStatus.CANCELLED,
        ),
        { stockReturnPending: true },
      );
      await setColumn(order.id, 'updatedAt', LONG_AGO);

      await maintenance.runOnce();

      expect(await onHand(skuId)).toBe(10);
      expect((await reload(order.id)).stockReturnPending).toBe(false);
    });

    it('the stock being returned twice is impossible: a second return finds nothing', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD);
      await cancel(order.id);
      const returner = module.get(OrderStockReturner);

      await returner.putBack(order.id);
      await returner.putBack(order.id);

      expect(await onHand(skuId)).toBe(10);
      expect(await available(skuId)).toBe(10);
    });
  });

  describe('what cannot be cancelled (AC-12)', () => {
    it('cancelling twice: the second is ORD-006 and the stock is returned once', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD);
      await cancel(order.id);

      expect(await failureOf(cancel(order.id))).toBe('ORD-006');
      expect(await onHand(skuId)).toBe(10);
    });

    it('SHIPPING, DELIVERED, EXPIRED, PAYMENT_PROCESSING: ORD-006, nothing changes', async () => {
      const shipping = (await placed(PaymentMethod.COD)).order;
      await move(shipping, OrderStatus.CONFIRMED, OrderStatus.SHIPPING);
      const delivered = (await placed(PaymentMethod.COD)).order;
      await move(delivered, OrderStatus.CONFIRMED, OrderStatus.SHIPPING);
      await move(delivered, OrderStatus.SHIPPING, OrderStatus.DELIVERED);
      const expired = (await placed(PaymentMethod.ONLINE)).order;
      await move(expired, OrderStatus.PENDING, OrderStatus.EXPIRED);
      const processing = (await placed(PaymentMethod.ONLINE)).order;
      await move(
        processing,
        OrderStatus.PENDING,
        OrderStatus.PAYMENT_PROCESSING,
      );

      for (const [o, status] of [
        [shipping, 'SHIPPING'],
        [delivered, 'DELIVERED'],
        [expired, 'EXPIRED'],
        [processing, 'PAYMENT_PROCESSING'],
      ] as const) {
        expect(await failureOf(cancel(o.id))).toBe('ORD-006');
        expect((await reload(o.id)).status).toBe(status);
      }
      expect(await reservationStatus(shipping.id)).toEqual(['CONFIRMED']);
    });

    it("another user's order and an order that does not exist: the same ORD-002", async () => {
      const { order } = await placed(PaymentMethod.ONLINE);

      expect(await failureOf(cancel(order.id, U2))).toBe('ORD-002');
      expect(
        await failureOf(cancel(deriveOrderId(U1, 'nothing-here-0000'))),
      ).toBe('ORD-002');
      expect((await reload(order.id)).status).toBe('PENDING');
    });
  });

  // ── AC-10: races ───────────────────────────────────────────────────────────

  describe('things that reach the same order together (AC-9, AC-10)', () => {
    it('5 cancels of the same order: one wins, four get ORD-006, the stock goes back once', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => cancel(order.id)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason.code).toBe('ORD-006');
      }
      expect(await onHand(skuId)).toBe(10);
      expect(await available(skuId)).toBe(10);
      expect((await reload(order.id)).version).toBe(3);
      expect(await statusChanges(order.id)).toEqual([
        'PENDING>CONFIRMED',
        'CONFIRMED>CANCELLED',
      ]);
    });

    it('a cancel and a shipment of a CONFIRMED order: exactly one wins, and the stock agrees with it', async () => {
      const winners = { cancel: 0, ship: 0 };
      for (let i = 0; i < 8; i++) {
        const { order, skuId } = await placed(PaymentMethod.COD);

        const [cancelled, shipped] = await Promise.allSettled([
          cancel(order.id),
          move(order, OrderStatus.CONFIRMED, OrderStatus.SHIPPING),
        ]);

        const final = await reload(order.id);
        if (final.status === 'CANCELLED') {
          winners.cancel++;
          expect(cancelled.status).toBe('fulfilled');
          expect((shipped as PromiseFulfilledResult<unknown>).value).toBeNull();
          expect(await reservationStatus(order.id)).toEqual(['RETURNED']);
          expect(await onHand(skuId)).toBe(10);
          expect(await available(skuId)).toBe(10);
        } else {
          winners.ship++;
          expect(final.status).toBe('SHIPPING');
          expect((cancelled as PromiseRejectedResult).reason.code).toBe(
            'ORD-006',
          );
          expect(await reservationStatus(order.id)).toEqual(['CONFIRMED']);
          expect(await onHand(skuId)).toBe(7);
          expect(await available(skuId)).toBe(7);
        }
        expect(final.version).toBe(3);
      }
      expect(winners.cancel + winners.ship).toBe(8);
    });

    it('a cancel and an expiry of an online order: exactly one wins, the stock is given back once', async () => {
      for (let i = 0; i < 6; i++) {
        const { order, skuId } = await placed(PaymentMethod.ONLINE);
        await setColumn(order.id, 'expiresAt', LONG_AGO);

        await Promise.allSettled([
          cancel(order.id),
          commands.execute(new ExpireDueOrdersCommand()),
        ]);

        const final = await reload(order.id);
        expect(['CANCELLED', 'EXPIRED']).toContain(final.status);
        expect(final.version).toBe(2);
        expect(await statusChanges(order.id)).toHaveLength(1);
        expect(await reservationStatus(order.id)).toEqual(['RELEASED']);
        expect(await available(skuId)).toBe(10);
      }
    });

    it('a cancel and a confirm of a cash-on-delivery order: the order and the stock always agree', async () => {
      for (let i = 0; i < 8; i++) {
        const { order, skuId } = await placed(PaymentMethod.COD, {
          confirmFailure: true,
        });

        await Promise.allSettled([
          cancel(order.id),
          commands.execute(new ConfirmOrderCommand(order.id)),
        ]);

        const final = await reload(order.id);
        if (final.status === 'CONFIRMED') {
          expect(await reservationStatus(order.id)).toEqual(['CONFIRMED']);
          expect(await onHand(skuId)).toBe(7);
          expect(await available(skuId)).toBe(7);
        } else {
          expect(final.status).toBe('CANCELLED');
          expect(['RELEASED', 'RETURNED']).toContain(
            (await reservationStatus(order.id))[0],
          );
          expect(await onHand(skuId)).toBe(10);
          expect(await available(skuId)).toBe(10);
          expect(final.stockReturnPending).toBe(false);
        }
      }
    });
  });

  // ── AC-11: the sweep ───────────────────────────────────────────────────────

  describe('expiring online orders (AC-11)', () => {
    it('expires an unpaid online order past its time, gives the stock back and writes the event; again does nothing', async () => {
      const { order, skuId } = await placed(PaymentMethod.ONLINE);
      await setColumn(order.id, 'expiresAt', LONG_AGO);

      expect(await commands.execute(new ExpireDueOrdersCommand())).toBe(1);

      expect((await reload(order.id)).status).toBe('EXPIRED');
      expect(await reservationStatus(order.id)).toEqual(['RELEASED']);
      expect(await available(skuId)).toBe(10);
      expect(await statusChanges(order.id)).toEqual(['PENDING>EXPIRED']);
      expect(await commands.execute(new ExpireDueOrdersCommand())).toBe(0);
      expect(await statusChanges(order.id)).toEqual(['PENDING>EXPIRED']);
    });

    it('leaves alone: an order not yet due, a cash-on-delivery order, a paid order, an order being paid', async () => {
      const notDue = (await placed(PaymentMethod.ONLINE)).order;
      const cod = (await placed(PaymentMethod.COD)).order;
      const confirmed = (await paid()).order;
      const processing = (await placed(PaymentMethod.ONLINE)).order;
      await move(
        processing,
        OrderStatus.PENDING,
        OrderStatus.PAYMENT_PROCESSING,
      );
      for (const o of [cod, confirmed, processing]) {
        await setColumn(o.id, 'expiresAt', LONG_AGO);
      }

      expect(await commands.execute(new ExpireDueOrdersCommand())).toBe(0);

      expect((await reload(notDue.id)).status).toBe('PENDING');
      expect((await reload(cod.id)).status).toBe('CONFIRMED');
      expect((await reload(confirmed.id)).status).toBe('CONFIRMED');
      expect((await reload(processing.id)).status).toBe('PAYMENT_PROCESSING');
    });

    it('one order that fails does not stop the others', async () => {
      const a = (await placed(PaymentMethod.ONLINE)).order;
      const b = (await placed(PaymentMethod.ONLINE)).order;
      await setColumn(a.id, 'expiresAt', 2 * LONG_AGO);
      await setColumn(b.id, 'expiresAt', LONG_AGO);
      vi.spyOn(orderRepo, 'transition').mockRejectedValueOnce(
        new Error('hiccup'),
      );

      expect(await commands.execute(new ExpireDueOrdersCommand())).toBe(1);

      expect((await reload(a.id)).status).toBe('PENDING');
      expect((await reload(b.id)).status).toBe('EXPIRED');
    });
  });

  describe('finishing cash-on-delivery orders (AC-11)', () => {
    it('confirms a PENDING cash-on-delivery order once it is older than the grace period, and not before', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD, {
        confirmFailure: true,
      });
      expect(order.status).toBe('PENDING');

      expect(await commands.execute(new FinishPendingCodOrdersCommand())).toBe(
        0,
      );
      expect((await reload(order.id)).status).toBe('PENDING');

      await setColumn(order.id, 'createdAt', LONG_AGO);
      expect(await commands.execute(new FinishPendingCodOrdersCommand())).toBe(
        1,
      );

      expect((await reload(order.id)).status).toBe('CONFIRMED');
      expect(await onHand(skuId)).toBe(7);
      expect(await commands.execute(new FinishPendingCodOrdersCommand())).toBe(
        0,
      );
      expect(await statusChanges(order.id)).toEqual(['PENDING>CONFIRMED']);
    });

    it('expires an order whose held stock was already given back, and tells the customer by the event', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD, {
        confirmFailure: true,
      });
      await commands.execute(new ReleaseReservationCommand(order.id));
      await setColumn(order.id, 'createdAt', LONG_AGO);

      expect(await commands.execute(new FinishPendingCodOrdersCommand())).toBe(
        1,
      );

      expect((await reload(order.id)).status).toBe('EXPIRED');
      expect(await statusChanges(order.id)).toEqual(['PENDING>EXPIRED']);
      expect(await onHand(skuId)).toBe(10);
    });

    it('finishes an order whose stock was taken out but whose status was not moved (the process died in between)', async () => {
      const { order, skuId } = await placed(PaymentMethod.COD, {
        confirmFailure: true,
      });
      await commands.execute(new ConfirmReservationCommand(order.id));
      await setColumn(order.id, 'createdAt', LONG_AGO);

      await commands.execute(new FinishPendingCodOrdersCommand());

      expect((await reload(order.id)).status).toBe('CONFIRMED');
      expect(await onHand(skuId)).toBe(7); // taken out once, not twice
    });

    it('does not touch orders that are not PENDING cash-on-delivery orders', async () => {
      const confirmed = (await placed(PaymentMethod.COD)).order;
      const online = (await placed(PaymentMethod.ONLINE)).order;
      for (const o of [confirmed, online]) {
        await setColumn(o.id, 'createdAt', LONG_AGO);
      }

      expect(await commands.execute(new FinishPendingCodOrdersCommand())).toBe(
        0,
      );
      expect((await reload(online.id)).status).toBe('PENDING');
    });
  });

  describe('the maintenance round (AC-11)', () => {
    it('runs all three sweeps in one round, and a second round changes nothing', async () => {
      const due = await placed(PaymentMethod.ONLINE);
      await setColumn(due.order.id, 'expiresAt', LONG_AGO);
      const stuck = await placed(PaymentMethod.COD, { confirmFailure: true });
      await setColumn(stuck.order.id, 'createdAt', LONG_AGO);
      const half = await placed(PaymentMethod.COD);
      await orderRepo.transition(
        half.order.id,
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
        orderStatusChangedEvent(
          half.order,
          OrderStatus.CONFIRMED,
          OrderStatus.CANCELLED,
        ),
        { stockReturnPending: true },
      );
      await setColumn(half.order.id, 'updatedAt', LONG_AGO);

      await maintenance.runOnce();

      expect((await reload(due.order.id)).status).toBe('EXPIRED');
      expect((await reload(stuck.order.id)).status).toBe('CONFIRMED');
      expect((await reload(half.order.id)).stockReturnPending).toBe(false);
      expect(await onHand(half.skuId)).toBe(10);
      const before = await prisma.outboxEvent.count();

      await maintenance.runOnce();

      expect(await prisma.outboxEvent.count()).toBe(before);
      expect(await onHand(stuck.skuId)).toBe(7);
      expect(await eventTypes(due.order.id)).toEqual([
        'order.created',
        'order.status_changed',
      ]);
    });

    it('two rounds at the same time: one works, the other skips, nothing is done twice', async () => {
      const due = await placed(PaymentMethod.ONLINE);
      await setColumn(due.order.id, 'expiresAt', LONG_AGO);

      await Promise.all([maintenance.runOnce(), maintenance.runOnce()]);

      expect(await statusChanges(due.order.id)).toEqual(['PENDING>EXPIRED']);
      expect(await available(due.skuId)).toBe(10);
    });
  });
});
