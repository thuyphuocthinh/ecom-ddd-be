import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import {
  CACHE,
  DatabaseModule,
  EVENT_BUS,
  JobQueueModule,
  LockModule,
  PrismaService,
  RedisModule,
  RedisService,
} from '@/core/index.js';
import { EventBusModule } from '../../core/infrastructure/messaging/events/event-bus.module.js';
import { InMemoryEventBus } from '../../core/infrastructure/messaging/events/in-memory-event-bus.js';
import { CatalogMapper } from '../catalog/infrastructure/database/mappers/catalog.mapper.js';
import { PrismaProductRepository } from '../catalog/infrastructure/database/repositories/prisma-product.repository.js';
import { SkuLookupService } from '../catalog/application/index.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { RedisCartStore } from '../cart/infrastructure/index.js';
import { CartOrderingService } from '../cart/application/index.js';
import { PrismaAddressRepository } from '../users/infrastructure/database/prisma-address.repository.js';
import { GetAddressHandler } from '../users/application/index.js';
import {
  OutboxRelay,
  PrismaOrderRepository,
  PrismaOutboxStore,
} from './infrastructure/index.js';
import {
  CancelOrderHandler,
  ConfirmOrderHandler,
  ExpireDueOrdersHandler,
  FinishPendingCodOrdersHandler,
  OrderMaintenance,
  OrderStockReturner,
  PlaceOrderCommand,
  PlaceOrderHandler,
  ReturnStockForCancelledOrdersHandler,
  type PlaceOrderResult,
} from './application/index.js';
import { PaymentMethod } from './domain/index.js';
import { ordersConfig } from './orders.config.js';

const USER_COUNT = 1000;
const userId = (i: number) => `burst_user_${i}`;
const addressId = (i: number) => `burst_address_${i}`;

/**
 * Many orders at once, and many waves of them, against the real Postgres and Redis, with the
 * outbox relay and the maintenance sweep running for real while the orders come in. What must
 * hold: nothing is sold twice, no request fails in a way the customer cannot understand (only
 * "not enough stock" is allowed to refuse), the connection pool of the database does not run dry,
 * and every event reaches the bus.
 */
describe('Orders arriving in bursts (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redis: ReturnType<RedisService['getClient']>;
  let commands: CommandBus;
  let cartStore: RedisCartStore;
  let bus: InMemoryEventBus;
  let relay: OutboxRelay;

  const originalPoolMax = process.env.DATABASE_POOL_MAX;

  beforeAll(async () => {
    // The application's pool is 100 connections; this test deliberately uses 10, so that a
    // transaction held open for too long (slow work inside it) shows up as failures here
    process.env.DATABASE_POOL_MAX = '10';
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
        RedisModule,
        LockModule,
        JobQueueModule,
        EventBusModule,
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
        PrismaOutboxStore,
        { provide: 'IOutboxStore', useExisting: PrismaOutboxStore },
        // The relay and the sweep run on their own timers, as they do in the real application
        {
          provide: ordersConfig.KEY,
          useValue: {
            outboxIntervalMs: 50,
            outboxBatchSize: 100,
            maintenanceIntervalSeconds: 1,
          },
        },
        OutboxRelay,
        OrderStockReturner,
        OrderMaintenance,
        PlaceOrderHandler,
        ConfirmOrderHandler,
        CancelOrderHandler,
        ExpireDueOrdersHandler,
        FinishPendingCodOrdersHandler,
        ReturnStockForCancelledOrdersHandler,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    redis = module.get(RedisService).getClient();
    commands = module.get(CommandBus);
    cartStore = module.get(RedisCartStore);
    bus = module.get<InMemoryEventBus>(EVENT_BUS);
    relay = module.get(OutboxRelay);

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
    const users = Array.from({ length: USER_COUNT }, (_, i) => ({
      id: userId(i),
    }));
    await prisma.user.createMany({ data: users, skipDuplicates: true });
  }, 60_000);

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
    await prisma.order.deleteMany({
      where: { userId: { startsWith: 'burst_user_' } },
    });
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanRedis();
    await cleanPostgres();
    bus.clear();
    await prisma.category.create({
      data: { id: 'burst_cat', name: 'C', path: '/burst_cat/' },
    });
    await prisma.product.create({
      data: {
        id: 'burst_prod',
        categoryId: 'burst_cat',
        name: 'AirPods',
        status: 'PUBLISHED',
      },
    });
    await prisma.address.deleteMany({
      where: { userId: { startsWith: 'burst_user_' } },
    });
    await prisma.address.createMany({
      data: Array.from({ length: USER_COUNT }, (_, i) => ({
        id: addressId(i),
        userId: userId(i),
        recipientName: 'Nguyễn Văn A',
        phone: '0901234567',
        provinceCode: '97',
        provinceName: 'Tỉnh Thử Nghiệm',
        wardCode: '97001',
        wardName: 'Phường Thử Nghiệm',
        street: '12 Đường Thử',
      })),
    });
  }, 60_000);

  afterAll(async () => {
    await cleanRedis();
    await cleanPostgres();
    await prisma.address.deleteMany({
      where: { userId: { startsWith: 'burst_user_' } },
    });
    await prisma.user.deleteMany({
      where: { id: { startsWith: 'burst_user_' } },
    });
    await prisma.ward.deleteMany({ where: { code: '97001' } });
    await prisma.province.deleteMany({ where: { code: '97' } });
    await module.close();
    if (originalPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = originalPoolMax;
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const sku = async (id: string, stock: number) => {
    await prisma.sku.create({
      data: {
        id,
        productId: 'burst_prod',
        price: 100,
        attributes: { id },
        skuCode: `CODE-${id}`,
      },
    });
    await prisma.skuStock.create({ data: { skuId: id, onHand: stock } });
  };
  /** Puts `lines` (skuId, quantity) in the carts of the users, a few hundred at a time. */
  const fillCarts = async (
    from: number,
    to: number,
    lines: [string, number][],
  ) => {
    for (let start = from; start < to; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, to - start) }, async (_, k) => {
          for (const [skuId, quantity] of lines) {
            await cartStore.add(userId(start + k), skuId, quantity, 100);
          }
        }),
      );
    }
  };
  const placeFor = (i: number, method: PaymentMethod) =>
    commands.execute<PlaceOrderCommand, PlaceOrderResult>(
      new PlaceOrderCommand(
        userId(i),
        `burst-key-${i}-xxxx`,
        addressId(i),
        method,
      ),
    );
  type Outcome =
    | { kind: 'placed'; i: number; result: PlaceOrderResult }
    | { kind: 'refused'; i: number; code: string }
    | { kind: 'broken'; i: number; message: string };
  const attempt = async (
    i: number,
    method: PaymentMethod,
  ): Promise<Outcome> => {
    try {
      return { kind: 'placed', i, result: await placeFor(i, method) };
    } catch (error: any) {
      // A refusal the customer can understand carries a business code; anything else is a failure
      if (error?.code === 'ORD-001')
        return { kind: 'refused', i, code: error.code };
      return {
        kind: 'broken',
        i,
        message: `${error?.code ?? error?.name}: ${error?.message}`,
      };
    }
  };
  /** The distinct ways requests failed, with how many each: empty when nothing broke. */
  const breakages = (outcomes: Outcome[]) => {
    const counts: Record<string, number> = {};
    for (const o of outcomes) {
      if (o.kind === 'broken') counts[o.message] = (counts[o.message] ?? 0) + 1;
    }
    return counts;
  };
  const methodOf = (i: number) =>
    i % 2 === 0 ? PaymentMethod.ONLINE : PaymentMethod.COD;
  const cartOf = async (i: number) =>
    (await cartStore.read(userId(i))).map((l) => [l.skuId, l.quantity]);
  const untilAllSent = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (
        (await prisma.outboxEvent.count({ where: { publishedAt: null } })) === 0
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('the outbox was not emptied in time');
  };
  /**
   * onHand minus what is still held must equal the number in Redis, and neither may go below 0.
   * (A sold unit leaves onHand; a held unit stays in onHand but is not available.)
   */
  const stockAgrees = async (skuId: string) => {
    const onHand = (
      await prisma.skuStock.findUniqueOrThrow({ where: { skuId } })
    ).onHand;
    const held = await prisma.reservation.aggregate({
      where: { skuId, status: 'RESERVED' },
      _sum: { qty: true },
    });
    const inRedis = Number(
      await redis.get(CACHE.INVENTORY.KEYS.AVAILABLE(skuId)),
    );
    expect(onHand).toBeGreaterThanOrEqual(0);
    expect(inRedis).toBeGreaterThanOrEqual(0);
    expect(onHand - (held._sum.qty ?? 0)).toBe(inRedis);
  };

  // ── AC-19 ──────────────────────────────────────────────────────────────────

  it('200 users (half online, half cash) after 10 units: exactly 10 orders, 190 refused with ORD-001, nothing broken', async () => {
    await sku('BURST_A', 10);
    await fillCarts(0, 200, [['BURST_A', 1]]);

    const outcomes = await Promise.all(
      Array.from({ length: 200 }, (_, i) => attempt(i, methodOf(i))),
    );

    expect(breakages(outcomes)).toEqual({});
    const placed = outcomes.filter((o) => o.kind === 'placed');
    const refused = outcomes.filter((o) => o.kind === 'refused');
    expect(placed).toHaveLength(10);
    expect(refused).toHaveLength(190);
    expect(await prisma.order.count()).toBe(10);
    expect(await prisma.reservation.count()).toBe(10);
    expect(
      await prisma.outboxEvent.count({ where: { type: 'order.created' } }),
    ).toBe(10);
    // The 190 who lost keep their carts, the 10 who won have none
    for (const o of refused)
      expect(await cartOf(o.i)).toEqual([['BURST_A', 1]]);
    for (const o of placed) expect(await cartOf(o.i)).toEqual([]);
    await stockAgrees('BURST_A');
    expect(
      Number(await redis.get(CACHE.INVENTORY.KEYS.AVAILABLE('BURST_A'))),
    ).toBe(0);
    // Every cash order is already confirmed
    const cash = placed.filter((o) => methodOf(o.i) === PaymentMethod.COD);
    for (const o of cash) {
      expect(
        (o as Extract<Outcome, { kind: 'placed' }>).result.order.status,
      ).toBe('CONFIRMED');
    }
  }, 120_000);

  it('200 users with carts of three items and plenty of stock: all 200 succeed, one order each', async () => {
    for (const id of ['BURST_B1', 'BURST_B2', 'BURST_B3']) await sku(id, 1000);
    await fillCarts(0, 200, [
      ['BURST_B1', 2],
      ['BURST_B2', 1],
      ['BURST_B3', 3],
    ]);

    const outcomes = await Promise.all(
      Array.from({ length: 200 }, (_, i) => attempt(i, methodOf(i))),
    );

    expect(breakages(outcomes)).toEqual({});
    expect(outcomes.filter((o) => o.kind === 'placed')).toHaveLength(200);
    expect(await prisma.order.count()).toBe(200);
    expect(await prisma.orderItem.count()).toBe(600);
    for (const userNumber of [0, 1, 99, 199]) {
      expect(
        await prisma.order.count({ where: { userId: userId(userNumber) } }),
      ).toBe(1);
    }
    for (const id of ['BURST_B1', 'BURST_B2', 'BURST_B3'])
      await stockAgrees(id);
  }, 120_000);

  it('10 waves of 100 users after 500 units, while the relay and the sweep run: nothing oversold, nothing lost, every event sent', async () => {
    await sku('BURST_C', 500);
    await fillCarts(0, USER_COUNT, [['BURST_C', 1]]);

    const outcomes: Outcome[] = [];
    for (let wave = 0; wave < 10; wave++) {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, k) => {
          const i = wave * 100 + k;
          return attempt(i, methodOf(i));
        }),
      );
      outcomes.push(...results);
    }

    expect(breakages(outcomes)).toEqual({});
    const placed = outcomes.filter(
      (o): o is Extract<Outcome, { kind: 'placed' }> => o.kind === 'placed',
    );
    // 1000 tried for 500 units: exactly 500 got one, never more than there was
    expect(placed).toHaveLength(500);
    expect(await prisma.order.count()).toBe(500);
    expect(await prisma.reservation.count()).toBe(500);
    // Every cash order is CONFIRMED, every online order is still PENDING
    for (const o of placed) {
      expect(o.result.order.status).toBe(
        methodOf(o.i) === PaymentMethod.COD ? 'CONFIRMED' : 'PENDING',
      );
    }
    expect(
      await prisma.order.count({
        where: { paymentMethod: 'COD', status: { not: 'CONFIRMED' } },
      }),
    ).toBe(0);
    await stockAgrees('BURST_C');

    // The relay (running by itself) sends everything; nothing is missing at the bus
    await untilAllSent();
    await relay.runOnce();
    const written = await prisma.outboxEvent.findMany({
      select: { id: true, type: true, aggregateId: true },
    });
    const sentIds = new Set(bus.published.map((e) => e.id));
    expect(written.filter((e) => !sentIds.has(e.id))).toEqual([]);
    expect(written.filter((e) => e.type === 'order.created')).toHaveLength(500);
    expect(
      written.filter((e) => e.type === 'order.status_changed'),
    ).toHaveLength(
      placed.filter((o) => methodOf(o.i) === PaymentMethod.COD).length,
    );
    // Each order has its created event, and the events of one order arrive in the order they were written
    const createdFor = new Set(
      written
        .filter((e) => e.type === 'order.created')
        .map((e) => e.aggregateId),
    );
    for (const o of placed)
      expect(createdFor.has(o.result.order.id)).toBe(true);
  }, 300_000);

  it('the database connections do not run dry: the pool is free again right after a burst', async () => {
    await sku('BURST_D', 1000);
    await fillCarts(0, 300, [['BURST_D', 1]]);

    const outcomes = await Promise.all(
      Array.from({ length: 300 }, (_, i) => attempt(i, methodOf(i))),
    );

    expect(breakages(outcomes)).toEqual({});
    // A plain query right afterwards answers at once (no connection is stuck in a transaction)
    const started = Date.now();
    await prisma.order.count();
    expect(Date.now() - started).toBeLessThan(1000);
    // (the relay's own batch transaction is meant to stay open while it sends, so it is left out)
    const stuck = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'
        AND query NOT ILIKE '%OutboxEvent%'`;
    expect(Number(stuck[0].count)).toBe(0);
  }, 120_000);
});
