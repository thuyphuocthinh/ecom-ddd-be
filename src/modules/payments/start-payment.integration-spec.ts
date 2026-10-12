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
import { ReleaseReservationCommand } from '../inventory/application/index.js';
import { RedisCartStore } from '../cart/infrastructure/index.js';
import { CartOrderingService } from '../cart/application/index.js';
import { PrismaAddressRepository } from '../users/infrastructure/database/prisma-address.repository.js';
import { GetAddressHandler } from '../users/application/index.js';
import { PrismaOrderRepository } from '../orders/infrastructure/index.js';
import {
  CancelOrderCommand,
  CancelOrderHandler,
  ConfirmOrderHandler,
  ExpireDueOrdersCommand,
  ExpireDueOrdersHandler,
  ExpireOrderHandler,
  GetOrderHandler,
  OrderStockReturner,
  PlaceOrderCommand,
  PlaceOrderHandler,
  ReopenOrderCommand,
  ReopenOrderHandler,
  StartOrderPaymentHandler,
  type PlaceOrderResult,
} from '../orders/application/index.js';
import { PaymentMethod, type Order } from '../orders/domain/index.js';
import { ordersConfig } from '../orders/orders.config.js';
import {
  PAYMENT_GATEWAY,
  PaymentStatus,
  paymentFailedEvent,
} from './domain/index.js';
import {
  FakePaymentGateway,
  PrismaPaymentRepository,
} from './infrastructure/index.js';
import {
  StartPaymentCommand,
  StartPaymentHandler,
  type StartPaymentResult,
} from './application/index.js';
import { paymentsConfig } from './payments.config.js';

const U1 = 'pay_flow_user_1';
const U2 = 'pay_flow_user_2';
const USERS = [U1, U2];
const WINDOW_MINUTES = 30;

/**
 * Starting to pay an online order, with the REAL catalog, stock, cart, address book, orders and
 * payments (Postgres and Redis) and the fake gateway, through the command bus (AC-1 to AC-4).
 */
describe('Starting a payment (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redis: ReturnType<RedisService['getClient']>;
  let commands: CommandBus;
  let cartStore: RedisCartStore;
  let payments: PrismaPaymentRepository;
  let orders: PrismaOrderRepository;
  let gateway: FakePaymentGateway;
  let addressId: string;
  let counter = 0;

  beforeAll(async () => {
    gateway = new FakePaymentGateway({
      secret: 'a-fake-gateway-secret-of-length',
    });
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
        CancelOrderHandler,
        ConfirmOrderHandler,
        ExpireDueOrdersHandler,
        GetOrderHandler,
        StartOrderPaymentHandler,
        ReopenOrderHandler,
        ExpireOrderHandler,
        PrismaPaymentRepository,
        { provide: 'IPaymentRepository', useExisting: PrismaPaymentRepository },
        { provide: PAYMENT_GATEWAY, useValue: gateway },
        {
          provide: paymentsConfig.KEY,
          useValue: {
            gateway: 'fake',
            windowMinutes: WINDOW_MINUTES,
            maintenanceIntervalSeconds: 0,
            webhookToleranceSeconds: 300,
            fakeWebhookSecret: 'unused-here',
          },
        },
        StartPaymentHandler,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    redis = module.get(RedisService).getClient();
    commands = module.get(CommandBus);
    cartStore = module.get(RedisCartStore);
    payments = module.get(PrismaPaymentRepository);
    orders = module.get(PrismaOrderRepository);

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
      'ecom:v1:lock:*',
    ]) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
  };
  const cleanPostgres = async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.payment.deleteMany({
      where: { order: { userId: { in: USERS } } },
    });
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
    gateway.reset();
    await cleanRedis();
    await cleanPostgres();
    await prisma.category.create({
      data: { id: 'pay_cat', name: 'C', path: '/pay_cat/' },
    });
    await prisma.product.create({
      data: {
        id: 'pay_prod',
        categoryId: 'pay_cat',
        name: 'AirPods',
        status: 'PUBLISHED',
      },
    });
    addressId = `pay-address-${Date.now()}`;
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

  /** Places an ONLINE order of 3 units (price 50000, so it costs 150000) with its own SKU. */
  const placed = async (method = PaymentMethod.ONLINE) => {
    const n = ++counter;
    const skuId = `PAYFLOW_${n}`;
    await prisma.sku.create({
      data: {
        id: skuId,
        productId: 'pay_prod',
        price: 50000,
        attributes: { n: String(n) },
        skuCode: `CODE-${skuId}`,
      },
    });
    await prisma.skuStock.create({ data: { skuId, onHand: 10 } });
    await cartStore.add(U1, skuId, 3, 50000);
    const { order } = await commands.execute<
      PlaceOrderCommand,
      PlaceOrderResult
    >(new PlaceOrderCommand(U1, `pay-flow-key-${n}-xxxx`, addressId, method));
    return { order, skuId };
  };
  const pay = (orderId: string, key = 'pay-attempt-0001', userId = U1) =>
    commands.execute<StartPaymentCommand, StartPaymentResult>(
      new StartPaymentCommand(userId, orderId, key),
    );
  const failureOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return error.code as string;
    }
    throw new Error('should have failed');
  };
  const orderOf = async (id: string) => (await orders.findById(id))!;
  const holds = (orderId: string) =>
    prisma.reservation.findMany({ where: { orderId } });
  const orderEvents = async (orderId: string) =>
    (
      await prisma.outboxEvent.findMany({
        where: { aggregateId: orderId, type: 'order.status_changed' },
        orderBy: { seq: 'asc' },
      })
    ).map((e) => `${(e.payload as any).from}>${(e.payload as any).to}`);
  const available = async (skuId: string) =>
    Number(await redis.get(CACHE.INVENTORY.KEYS.AVAILABLE(skuId)));
  /** Makes an attempt fail the way the gateway would say it did (what a webhook will do later). */
  const failAttempt = async (paymentId: string, orderId: string) => {
    const payment = (await payments.findById(paymentId))!;
    await payments.transition(
      paymentId,
      [PaymentStatus.INITIATED],
      PaymentStatus.FAILED,
      paymentFailedEvent(payment),
    );
    await commands.execute(new ReopenOrderCommand(orderId));
  };

  // ── AC-1: starting ────────────────────────────────────────────────────────

  describe('starting to pay (AC-1)', () => {
    it("writes an INITIATED payment for the price of the order, with the gateway's link; the order is PAYMENT_PROCESSING with the new time to pay; the stock is held that long", async () => {
      const { order, skuId } = await placed();
      const before = Date.now();

      const { payment, replayed } = await pay(order.id);

      expect(replayed).toBe(false);
      expect(payment).toMatchObject({
        orderId: order.id,
        status: 'INITIATED',
        amount: 150000,
        provider: 'fake',
        version: 1,
      });
      expect(payment.providerRef).toMatch(/^fake_/);
      expect(payment.payUrl).toBe(
        `/dev/fake-gateway/charges/${payment.providerRef}`,
      );
      // The time to pay is the window from now, longer than the 15 minutes the stock was first held
      expect(
        Math.abs(
          payment.expiresAt.getTime() - (before + WINDOW_MINUTES * 60_000),
        ),
      ).toBeLessThan(15_000);
      const now = await orderOf(order.id);
      expect(now).toMatchObject({ status: 'PAYMENT_PROCESSING', version: 2 });
      expect(now.expiresAt.getTime()).toBe(payment.expiresAt.getTime());
      const [hold] = await holds(order.id);
      expect(hold.status).toBe('RESERVED');
      expect(hold.expiresAt.getTime()).toBe(payment.expiresAt.getTime());
      expect(await available(skuId)).toBe(7); // still held, nothing taken out
      expect(gateway.chargeCount).toBe(1);
      expect(await orderEvents(order.id)).toEqual([
        'PENDING>PAYMENT_PROCESSING',
      ]);
      expect(await payments.findById(payment.id)).toMatchObject({
        providerRef: payment.providerRef,
      });
    });

    it('asks the gateway for exactly what the order costs, under the id of the payment', async () => {
      const { order } = await placed();
      const create = vi.spyOn(gateway, 'createCharge');

      const { payment } = await pay(order.id);

      expect(create).toHaveBeenCalledWith({
        paymentId: payment.id,
        orderId: order.id,
        amount: 150000,
      });
    });
  });

  // ── AC-2: the same key, many requests ────────────────────────────────────

  describe('sending it again and at the same moment (AC-2)', () => {
    it('the same key gives back the same payment: nothing new at the gateway, nothing new in the order', async () => {
      const { order } = await placed();
      const first = await pay(order.id);

      const again = await pay(order.id);

      expect(again.replayed).toBe(true);
      expect(again.payment).toEqual(first.payment);
      expect(gateway.chargeCount).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        1,
      );
      expect((await orderOf(order.id)).version).toBe(2);
      expect(await orderEvents(order.id)).toHaveLength(1);
    });

    it('ten requests with the same key at the same moment: one payment, one charge at the gateway, one new and nine repeats, no error', async () => {
      const { order } = await placed();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => pay(order.id)),
      );

      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(results.filter((r) => r.replayed)).toHaveLength(9);
      expect(new Set(results.map((r) => r.payment.id)).size).toBe(1);
      expect(new Set(results.map((r) => r.payment.payUrl)).size).toBe(1);
      expect(gateway.chargeCount).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        1,
      );
      expect((await orderOf(order.id)).version).toBe(2);
      expect(await orderEvents(order.id)).toHaveLength(1);
    });

    it('two different keys at the same moment for one order: one wins, the other is told a payment is already in progress (PAY-003)', async () => {
      const { order } = await placed();

      const results = await Promise.allSettled([
        pay(order.id, 'pay-attempt-AAAA'),
        pay(order.id, 'pay-attempt-BBBB'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(lost.reason.code).toBe('PAY-003');
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        1,
      );
      expect(gateway.chargeCount).toBe(1);
    });

    it('a different key while the first payment is in progress: PAY-003, and the first payment is untouched', async () => {
      const { order } = await placed();
      const first = await pay(order.id);

      expect(await failureOf(pay(order.id, 'pay-attempt-0002'))).toBe(
        'PAY-003',
      );

      expect(await payments.findById(first.payment.id)).toMatchObject({
        status: 'INITIATED',
      });
      expect(gateway.chargeCount).toBe(1);
    });
  });

  // ── AC-3: what cannot be paid, and nothing is left behind ────────────────

  describe('what cannot be started leaves nothing behind (AC-3)', () => {
    const nothingLeft = async (orderId: string, status: string) => {
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
      expect((await orderOf(orderId)).status).toBe(status);
      expect(gateway.chargeCount).toBe(0);
    };

    it('a cash on delivery order: PAY-002', async () => {
      const { order } = await placed(PaymentMethod.COD);

      expect(await failureOf(pay(order.id))).toBe('PAY-002');
      await nothingLeft(order.id, 'CONFIRMED');
    });

    it("someone else's order and an order that does not exist: ORD-002", async () => {
      const { order } = await placed();

      expect(await failureOf(pay(order.id, 'pay-attempt-0001', U2))).toBe(
        'ORD-002',
      );
      expect(await failureOf(pay('no-such-order'))).toBe('ORD-002');
      await nothingLeft(order.id, 'PENDING');
    });

    it('a cancelled order: PAY-003', async () => {
      const { order } = await placed();
      await commands.execute(new CancelOrderCommand(U1, order.id));

      expect(await failureOf(pay(order.id))).toBe('PAY-003');
      await nothingLeft(order.id, 'CANCELLED');
    });

    it('an expired order: PAY-003', async () => {
      const { order } = await placed();
      await prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`,
        order.id,
      );
      await commands.execute(new ExpireDueOrdersCommand());

      expect(await failureOf(pay(order.id))).toBe('PAY-003');
      await nothingLeft(order.id, 'EXPIRED');
    });

    it('a key that is not acceptable: PAY-001', async () => {
      const { order } = await placed();

      for (const key of ['short', 'has space in it!', 'x'.repeat(101)]) {
        expect(await failureOf(pay(order.id, key))).toBe('PAY-001');
      }
      await nothingLeft(order.id, 'PENDING');
    });

    it('stock that was given back: PAY-005, the order stays PENDING and no payment is written', async () => {
      const { order } = await placed();
      await commands.execute(new ReleaseReservationCommand(order.id));

      expect(await failureOf(pay(order.id))).toBe('PAY-005');
      await nothingLeft(order.id, 'PENDING');
    });

    it('a hold that has run out by the database clock: PAY-005, and it is not brought back', async () => {
      const { order, skuId } = await placed();
      await prisma.reservation.updateMany({
        data: { expiresAt: new Date(Date.now() - 3_600_000) },
      });

      expect(await failureOf(pay(order.id))).toBe('PAY-005');
      await nothingLeft(order.id, 'PENDING');
      expect((await holds(order.id))[0].status).toBe('RESERVED'); // the sweep gives it back, not this
      expect(await available(skuId)).toBe(7);
    });

    it('the fourth attempt: PAY-004, after three that failed', async () => {
      const { order } = await placed();
      for (let i = 1; i <= 3; i++) {
        const { payment } = await pay(order.id, `pay-attempt-000${i}`);
        await failAttempt(payment.id, order.id);
      }

      expect(await failureOf(pay(order.id, 'pay-attempt-0004'))).toBe(
        'PAY-004',
      );

      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        3,
      );
      expect((await orderOf(order.id)).status).toBe('PENDING');
      expect(gateway.chargeCount).toBe(3);
    });

    it('a failed attempt can be followed by another with a new key (the hold is extended again)', async () => {
      const { order } = await placed();
      const first = await pay(order.id, 'pay-attempt-0001');
      await failAttempt(first.payment.id, order.id);

      const second = await pay(order.id, 'pay-attempt-0002');

      expect(second.replayed).toBe(false);
      expect(second.payment.id).not.toBe(first.payment.id);
      expect((await orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
      expect(gateway.chargeCount).toBe(2);
    });
  });

  // ── AC-4: the gateway fails, the process dies ────────────────────────────

  describe('when the gateway fails or the process dies (AC-4)', () => {
    it('a gateway that is down: PAY-006, the payment is FAILED and the order is PENDING again with its stock still held; a new key starts again', async () => {
      const { order, skuId } = await placed();
      gateway.failNext('createCharge');

      expect(await failureOf(pay(order.id, 'pay-attempt-0001'))).toBe(
        'PAY-006',
      );

      const [stored] = await payments.listByOrder(order.id);
      expect(stored).toMatchObject({ status: 'FAILED', providerRef: null });
      expect(await orderEvents(order.id)).toEqual([
        'PENDING>PAYMENT_PROCESSING',
        'PAYMENT_PROCESSING>PENDING',
      ]);
      expect((await orderOf(order.id)).status).toBe('PENDING');
      expect((await holds(order.id))[0].status).toBe('RESERVED');
      expect(await available(skuId)).toBe(7);
      expect(gateway.chargeCount).toBe(0);

      const retry = await pay(order.id, 'pay-attempt-0002');
      expect(retry.payment.status).toBe('INITIATED');
      expect(gateway.chargeCount).toBe(1);
    });

    it('the same key after a gateway that was down gives back the failed payment (a new key starts again)', async () => {
      const { order } = await placed();
      gateway.failNext('createCharge');
      await failureOf(pay(order.id, 'pay-attempt-0001'));

      const again = await pay(order.id, 'pay-attempt-0001');

      expect(again.replayed).toBe(true);
      expect(again.payment.status).toBe('FAILED');
      expect(gateway.chargeCount).toBe(0);
    });

    it('the process dies after the payment was written but before the gateway answered: the same key finishes the job, with one charge', async () => {
      const { order } = await placed();
      vi.spyOn(gateway, 'createCharge').mockRejectedValueOnce(
        new Error('the process died'),
      );
      await expect(pay(order.id)).rejects.toThrow('the process died');
      const [left] = await payments.listByOrder(order.id);
      expect(left).toMatchObject({
        status: 'INITIATED',
        providerRef: null,
        payUrl: null,
      });
      expect((await orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');

      const again = await pay(order.id);

      expect(again.replayed).toBe(true);
      expect(again.payment).toMatchObject({ id: left.id, status: 'INITIATED' });
      expect(again.payment.providerRef).toMatch(/^fake_/);
      expect(gateway.chargeCount).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        1,
      );
    });

    it('the payment cannot be written: the order is put back to PENDING, nothing is charged, and the error is not hidden', async () => {
      const { order } = await placed();
      vi.spyOn(payments, 'create').mockRejectedValueOnce(
        new Error('connection lost'),
      );

      await expect(pay(order.id)).rejects.toThrow('connection lost');

      expect((await orderOf(order.id)).status).toBe('PENDING');
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        0,
      );
      expect(gateway.chargeCount).toBe(0);
      // and the same key works afterwards
      await expect(pay(order.id)).resolves.toMatchObject({ replayed: false });
    });

    it('the payment cannot be written and the order cannot be put back either: it stays PAYMENT_PROCESSING with no payment, for the sweep to find', async () => {
      const { order } = await placed();
      vi.spyOn(payments, 'create').mockRejectedValueOnce(
        new Error('connection lost'),
      );
      const real = commands.execute.bind(commands);
      vi.spyOn(commands, 'execute').mockImplementation((command: any) =>
        command.constructor.name === 'ReopenOrderCommand'
          ? Promise.reject(new Error('also down'))
          : real(command),
      );

      await expect(pay(order.id)).rejects.toThrow('connection lost');
      vi.restoreAllMocks();

      expect((await orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
      expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(
        0,
      );
    });
  });

  // ── races with the rest of the life of the order ─────────────────────────

  describe('a payment that starts at the same moment as something else', () => {
    it('a start and a cancel: exactly one wins, and the stock and the payment agree with it', async () => {
      for (let i = 0; i < 8; i++) {
        const { order, skuId } = await placed();

        const [started, cancelled] = await Promise.allSettled([
          pay(order.id),
          commands.execute<CancelOrderCommand, Order>(
            new CancelOrderCommand(U1, order.id),
          ),
        ]);

        const final = await orderOf(order.id);
        if (final.status === 'CANCELLED') {
          expect(cancelled.status).toBe('fulfilled');
          expect(['PAY-003', 'PAY-005']).toContain(
            (started as PromiseRejectedResult).reason.code,
          );
          expect(
            await prisma.payment.count({ where: { orderId: order.id } }),
          ).toBe(0);
          expect((await holds(order.id))[0].status).toBe('RELEASED');
          expect(await available(skuId)).toBe(10);
        } else {
          expect(final.status).toBe('PAYMENT_PROCESSING');
          expect(started.status).toBe('fulfilled');
          expect((cancelled as PromiseRejectedResult).reason.code).toBe(
            'ORD-006',
          );
          expect(
            await prisma.payment.count({
              where: { orderId: order.id, status: 'INITIATED' },
            }),
          ).toBe(1);
          expect((await holds(order.id))[0].status).toBe('RESERVED');
          expect(await available(skuId)).toBe(7);
        }
      }
    });

    it('a start and the expiry sweep of an order whose time is up: exactly one wins', async () => {
      for (let i = 0; i < 6; i++) {
        const { order } = await placed();
        await prisma.$executeRawUnsafe(
          `UPDATE "Order" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`,
          order.id,
        );

        const [started] = await Promise.allSettled([
          pay(order.id),
          commands.execute(new ExpireDueOrdersCommand()),
        ]);

        const final = await orderOf(order.id);
        expect(['PAYMENT_PROCESSING', 'EXPIRED']).toContain(final.status);
        if (final.status === 'EXPIRED') {
          expect(started.status).toBe('rejected');
          expect(
            await prisma.payment.count({ where: { orderId: order.id } }),
          ).toBe(0);
        }
      }
    });
  });
});
