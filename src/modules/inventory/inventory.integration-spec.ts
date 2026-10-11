import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CommandBus } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  CACHE,
  DatabaseModule,
  InventoryErrorCodes,
  JOB_QUEUE,
  JobQueueModule,
  LockModule,
  LockService,
  PrismaService,
  RedisModule,
  RedisService,
  type IJobQueue,
} from '@/core/index.js';
import { InventoryModule } from './inventory.module.js';
import { inventoryConfig, type InventoryConfig } from './inventory.config.js';
import {
  ConfirmReservationCommand,
  ReleaseExpiredReservationCommand,
  ReleaseExpiredReservationsCommand,
  ReleaseReservationCommand,
  RepairInFlightHoldsCommand,
  ReservationMaintenance,
  ReserveStockCommand,
  ReturnReservationCommand,
  StockRebuilder,
  type ReserveStockResult,
} from './application/index.js';
import type {
  IAvailabilityStore,
  IReservationRepository,
  IStockRepository,
} from './domain/index.js';
import { RedisAvailabilityStore } from './infrastructure/index.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const KEYS = CACHE.INVENTORY.KEYS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const A = 'iv_a';
const B = 'iv_b';
const C = 'iv_c';
const D = 'iv_d'; // never given a stock row

const config = (overrides: Partial<InventoryConfig> = {}): InventoryConfig => ({
  reservationTtlSeconds: 900,
  maintenanceIntervalSeconds: 0, // tests run the rounds themselves
  inflightGraceSeconds: 1, // a being-held record is "left behind" after 1 s (wide enough for a busy machine)
  ...overrides,
});

/**
 * Waits until the REDIS clock, not this process's, has moved on by `ms`. The repair compares a
 * record's age by the Redis clock, and the Redis container's clock does not tick exactly like the
 * host's (a fixed sleep failed one run in three), so a sleep alone cannot promise the grace period is over.
 */
const waitOnRedisClock = async (client: Redis, ms: number) => {
  const now = async () => {
    const [seconds, micros] = await client.time();
    return Number(seconds) * 1000 + Number(micros) / 1000;
  };
  const start = await now();
  while ((await now()) - start < ms) await sleep(50);
};

/** The result of a call that may fail, so a hundred of them can be counted. */
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: any) => ({
      ok: false as const,
      code: error?.code as string,
      error,
    }),
  );

/**
 * The whole module against the real Postgres, Redis and LockService. The job queue is the inline
 * one (test/setup.ts), so a "give the stock back" timer runs in this process.
 */
describe('Inventory (Integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let redis: Redis;
  let commands: CommandBus;
  let jobs: IJobQueue;
  let reservationRepo: IReservationRepository;
  let stockRepo: IStockRepository;
  let store: IAvailabilityStore;
  let maintenance: ReservationMaintenance;

  const build = async (
    settings: Partial<InventoryConfig> = {},
    customise?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
  ) => {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
        RedisModule,
        LockModule,
        JobQueueModule,
        InventoryModule,
      ],
    })
      .overrideProvider(inventoryConfig.KEY)
      .useValue(config(settings));
    customise?.(builder);
    const built = await builder.compile();
    await built.init();
    return built;
  };

  const pick = (built: TestingModule) => {
    moduleRef = built;
    prisma = built.get(PrismaService);
    redis = built.get(RedisService).getClient();
    commands = built.get(CommandBus);
    jobs = built.get<IJobQueue>(JOB_QUEUE);
    reservationRepo = built.get<IReservationRepository>(
      'IReservationRepository',
      { strict: false },
    );
    stockRepo = built.get<IStockRepository>('IStockRepository', {
      strict: false,
    });
    store = built.get<IAvailabilityStore>('IAvailabilityStore', {
      strict: false,
    });
    maintenance = built.get(ReservationMaintenance);
  };

  const clean = async () => {
    const keys = await redis.keys('ecom:v1:inventory:*');
    if (keys.length > 0) await redis.del(...keys);
    const locks = await redis.keys('ecom:v1:lock:inventory:*');
    if (locks.length > 0) await redis.del(...locks);
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
  };

  const seedCatalog = async () => {
    await prisma.category.create({
      data: { id: 'iv_cat', name: 'Inventory', path: '/iv_cat/' },
    });
    await prisma.product.create({
      data: { id: 'iv_prod', categoryId: 'iv_cat', name: 'Inventory product' },
    });
    for (const id of [A, B, C, D]) {
      await prisma.sku.create({
        data: {
          id,
          productId: 'iv_prod',
          price: 10,
          attributes: {},
          skuCode: `CODE-${id}`,
        },
      });
    }
  };

  // ── small helpers ──────────────────────────────────────────────────────────

  const reserve = (orderId: string, items: { skuId: string; qty: number }[]) =>
    commands.execute<ReserveStockCommand, ReserveStockResult>(
      new ReserveStockCommand(orderId, items),
    );
  /** Puts stock in the warehouse, like scripts/seed-stock.sql: Redis has no number for it yet. */
  const setStock = (skuId: string, onHand: number) =>
    prisma.skuStock.upsert({
      where: { skuId },
      create: { skuId, onHand },
      update: { onHand },
    });
  /** Gives Redis its number for a SKU, rebuilt from Postgres. */
  const rebuild = (skuId: string) =>
    moduleRef.get(StockRebuilder).rebuild([skuId]);
  const confirm = (orderId: string) =>
    commands.execute(new ConfirmReservationCommand(orderId));
  const release = (orderId: string) =>
    commands.execute(new ReleaseReservationCommand(orderId));
  const available = async (skuId: string) => {
    const value = await redis.get(KEYS.AVAILABLE(skuId));
    return value === null ? null : Number(value);
  };
  const onHand = async (skuId: string) =>
    (await prisma.skuStock.findUniqueOrThrow({ where: { skuId } })).onHand;
  const rowsOf = (orderId: string) =>
    prisma.reservation.findMany({ where: { orderId } });
  const statusOf = async (orderId: string) =>
    (await rowsOf(orderId)).map((row) => row.status);
  const expire = (orderId: string) =>
    prisma.reservation.updateMany({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 3_600_000) },
    });
  const forgetRedis = async () => {
    const keys = await redis.keys('ecom:v1:inventory:*');
    if (keys.length > 0) await redis.del(...keys);
  };
  const held = async (skuId: string) =>
    (
      await prisma.reservation.aggregate({
        _sum: { qty: true },
        where: { skuId, status: 'RESERVED' },
      })
    )._sum.qty ?? 0;
  /** The rule that ties the two sides together: available = onHand - units held. */
  const expectConsistent = async (skuId: string) => {
    expect(await available(skuId)).toBe(
      (await onHand(skuId)) - (await held(skuId)),
    );
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    pick(await build());
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await clean();
    await seedCatalog();
  });

  afterAll(async () => {
    await clean();
    await moduleRef.close();
  });

  // ── the three mechanisms ───────────────────────────────────────────────────

  describe('contention: many buyers, one item (AC-1 to AC-5)', () => {
    it('holds the units in Redis and Postgres and sets the timer (AC-1)', async () => {
      await setStock(A, 5);
      const enqueue = vi.spyOn(jobs, 'enqueue');
      const before = Date.now();

      const result = await reserve('O1', [{ skuId: A, qty: 2 }]);

      expect(await available(A)).toBe(3);
      const rows = await rowsOf('O1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ skuId: A, qty: 2, status: 'RESERVED' });
      expect(rows[0].expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 900_000 - 5,
      );
      expect(result.expiresAt.getTime()).toBe(rows[0].expiresAt.getTime());
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0][0]).toMatchObject({
        name: 'release-reservation',
        delayMs: 900_000,
      });
      expect(enqueue.mock.calls[0][1]).toEqual({ orderId: 'O1' });
      await expectConsistent(A);
    });

    it('hands the last unit to exactly one of 200 orders placed at once (AC-2)', async () => {
      await setStock(A, 1);

      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          settle(reserve(`RUSH-${i}`, [{ skuId: A, qty: 1 }])),
        ),
      );

      const won = results.filter((r) => r.ok);
      const lost = results.filter((r) => !r.ok);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(199);
      expect(
        lost.every(
          (r) => !r.ok && r.code === InventoryErrorCodes.OUT_OF_STOCK.code,
        ),
      ).toBe(true);
      expect(await available(A)).toBe(0);
      expect(await prisma.reservation.count()).toBe(1);
      expect(await onHand(A)).toBe(1);
    });

    it('never sells more than there is when orders of several units compete', async () => {
      await setStock(A, 20);

      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          settle(reserve(`MULTI-${i}`, [{ skuId: A, qty: 3 }])),
        ),
      );

      const won = results.filter((r) => r.ok).length;
      expect(won).toBe(6); // 6 x 3 = 18; a 7th would need 21
      expect(await available(A)).toBe(20 - 18);
      expect(await held(A)).toBe(18);
      await expectConsistent(A);
    });

    it('takes the whole order or nothing (AC-3)', async () => {
      await setStock(A, 5);
      await setStock(B, 0);
      const enqueue = vi.spyOn(jobs, 'enqueue');

      const result = await settle(
        reserve('O1', [
          { skuId: A, qty: 2 },
          { skuId: B, qty: 1 },
        ]),
      );

      expect(!result.ok && result.code).toBe(
        InventoryErrorCodes.OUT_OF_STOCK.code,
      );
      expect(await available(A)).toBe(5);
      expect(await prisma.reservation.count()).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('lists every short SKU and leaves the others alone (AC-4)', async () => {
      await setStock(A, 1);
      await setStock(B, 0);
      await setStock(C, 10);

      const result = await settle(
        reserve('O1', [
          { skuId: A, qty: 2 },
          { skuId: B, qty: 1 },
          { skuId: C, qty: 1 },
        ]),
      );

      expect(!result.ok && result.error.details).toEqual({
        shortages: [
          { skuId: A, requested: 2, available: 1 },
          { skuId: B, requested: 1, available: 0 },
        ],
      });
      expect(await available(C)).toBe(10);
    });

    it('says sold out for a SKU with no stock row, and writes no number for it (AC-5)', async () => {
      await setStock(A, 3);

      const result = await settle(
        reserve('O1', [
          { skuId: A, qty: 1 },
          { skuId: D, qty: 1 },
        ]),
      );

      expect(!result.ok && result.error.details).toEqual({
        shortages: [{ skuId: D, requested: 1, available: 0 }],
      });
      expect(await available(D)).toBeNull();
      expect(await redis.exists(KEYS.AVAILABLE(D))).toBe(0);
      expect(await available(A)).toBe(3); // untouched
    });
  });

  describe('idempotency (AC-7 to AC-12)', () => {
    it('answers a retry of the same order with the first answer and holds nothing more (AC-7)', async () => {
      await setStock(A, 5);
      const enqueue = vi.spyOn(jobs, 'enqueue');
      const first = await reserve('O1', [{ skuId: A, qty: 2 }]);

      const second = await reserve('O1', [{ skuId: A, qty: 2 }]);

      expect(second.expiresAt).toEqual(first.expiresAt);
      expect(await available(A)).toBe(3);
      expect(await rowsOf('O1')).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('holds only once when the same order arrives five times at the same moment (AC-8)', async () => {
      await setStock(A, 5);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          settle(reserve('O1', [{ skuId: A, qty: 2 }])),
        ),
      );

      expect(await available(A)).toBe(3);
      expect(await rowsOf('O1')).toHaveLength(1);
      const wins = results.filter((r) => r.ok);
      expect(wins.length).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (!result.ok) {
          expect(result.code).toBe(
            InventoryErrorCodes.RESERVATION_IN_PROGRESS.code,
          );
        }
      }
      // Whoever got the answer got the same one, and a later retry gets it too
      const expiry = wins[0].ok && wins[0].value.expiresAt;
      for (const win of wins)
        expect(win.ok && win.value.expiresAt).toEqual(expiry);
      expect((await reserve('O1', [{ skuId: A, qty: 2 }])).expiresAt).toEqual(
        expiry,
      );
      await expectConsistent(A);
    });

    it('holds once even if Redis forgot the being-held record, thanks to the unique line in Postgres (AC-8)', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      // Simulate a request that missed the Postgres read: make Redis take the units again
      expect(await store.hold('O1', 'other', [{ skuId: A, qty: 2 }])).toEqual({
        kind: 'HELD',
      });
      expect(await available(A)).toBe(1); // taken twice on purpose

      await expect(store.undoHold('O1', [{ skuId: A, qty: 2 }])).resolves.toBe(
        true,
      );

      expect(await available(A)).toBe(3); // back to the single hold
    });

    it('refuses the same order with other content (AC-9)', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);

      const result = await settle(reserve('O1', [{ skuId: A, qty: 3 }]));

      expect(!result.ok && result.code).toBe(
        InventoryErrorCodes.RESERVATION_CONFLICT.code,
      );
      expect(await available(A)).toBe(3);
    });

    it('does not bring back an order whose units were returned (AC-10)', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      await release('O1');

      const result = await settle(reserve('O1', [{ skuId: A, qty: 2 }]));

      expect(!result.ok && result.code).toBe(
        InventoryErrorCodes.RESERVATION_RELEASED.code,
      );
      expect(await available(A)).toBe(5);
    });

    it('takes a paid order out of the warehouse for good, and confirming twice is fine (AC-11)', async () => {
      await setStock(A, 10);
      await reserve('O1', [{ skuId: A, qty: 2 }]);

      await confirm('O1');
      await confirm('O1');

      expect(await statusOf('O1')).toEqual(['CONFIRMED']);
      expect(await onHand(A)).toBe(8);
      expect(await available(A)).toBe(8);
      await expectConsistent(A);
      const unknown = await settle(confirm('nope'));
      expect(!unknown.ok && unknown.code).toBe(
        InventoryErrorCodes.RESERVATION_NOT_FOUND.code,
      );
    });

    it('gives the units back once, however often the release repeats (AC-12)', async () => {
      await setStock(A, 10);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      expect(await available(A)).toBe(8);

      await release('O1');
      await release('O1');
      await commands.execute(new ReleaseExpiredReservationCommand('O1'));
      await Promise.all([release('O1'), release('O1'), release('O1')]);

      expect(await available(A)).toBe(10);
      expect(await onHand(A)).toBe(10);
      expect(await statusOf('O1')).toEqual(['RELEASED']);
      await release('never-existed'); // not an error
    });

    it('lets exactly one of payment and expiry win, over 50 orders (AC-13)', async () => {
      await setStock(A, 100);
      const orders = Array.from({ length: 50 }, (_, i) => `RACE-${i}`);
      for (const orderId of orders) {
        await reserve(orderId, [{ skuId: A, qty: 1 }]);
        await expire(orderId);
      }

      const outcomes = await Promise.all(
        orders.map(async (orderId) => ({
          orderId,
          // started together: the payment and the timer of the same order
          results: await Promise.all([
            settle(confirm(orderId)),
            settle(
              commands.execute(new ReleaseExpiredReservationCommand(orderId)),
            ),
          ]),
        })),
      );

      let confirmed = 0;
      for (const { orderId, results } of outcomes) {
        const statuses = await statusOf(orderId);
        expect(statuses).toHaveLength(1);
        expect(['CONFIRMED', 'RELEASED']).toContain(statuses[0]);
        if (statuses[0] === 'CONFIRMED') {
          confirmed++;
        } else {
          // the payment that lost was told the order is gone
          const payment = results[0];
          expect(!payment.ok && payment.code).toBe(
            InventoryErrorCodes.RESERVATION_RELEASED.code,
          );
        }
      }
      expect(await onHand(A)).toBe(100 - confirmed);
      expect(await held(A)).toBe(0);
      await expectConsistent(A);
    });
  });

  describe('giving the units back by themselves (AC-14 to AC-16)', () => {
    it('lets the timer return the units once the hold has expired (AC-14)', async () => {
      const short = await build({ reservationTtlSeconds: 1 });
      try {
        // Re-point everything at the module that has a 1 second hold
        const previous = moduleRef;
        pick(short);
        await setStock(A, 10);
        await reserve('O1', [{ skuId: A, qty: 2 }]);
        await reserve('PAID', [{ skuId: A, qty: 1 }]);
        await confirm('PAID');
        expect(await available(A)).toBe(7);
        // (the database clock can lag this machine's: make sure O1 has expired for the database too)
        await expire('O1');

        // The timer fires about a second after the hold and gives the units back
        const deadline = Date.now() + 8_000;
        while (
          Date.now() < deadline &&
          (await statusOf('O1'))[0] !== 'RELEASED'
        ) {
          await sleep(100);
        }

        expect(await statusOf('O1')).toEqual(['RELEASED']);
        expect(await available(A)).toBe(9);
        expect(await statusOf('PAID')).toEqual(['CONFIRMED']); // a paid order is left alone
        await expectConsistent(A);
        pick(previous);
      } finally {
        await short.close();
      }
    });

    it('does not return a hold that has not expired yet (a timer that came early) (AC-14)', async () => {
      await setStock(A, 10);
      await reserve('O1', [{ skuId: A, qty: 2 }]);

      await commands.execute(new ReleaseExpiredReservationCommand('O1'));

      expect(await statusOf('O1')).toEqual(['RESERVED']);
      expect(await available(A)).toBe(8);
    });

    it('sweeps up holds whose timer never fired (AC-15)', async () => {
      await setStock(A, 10);
      await reserve('LOST-TIMER', [{ skuId: A, qty: 2 }]);
      await reserve('STILL-GOOD', [{ skuId: A, qty: 3 }]);
      await expire('LOST-TIMER');

      const released: number = await commands.execute(
        new ReleaseExpiredReservationsCommand(),
      );

      expect(released).toBe(1);
      expect(await statusOf('LOST-TIMER')).toEqual(['RELEASED']);
      expect(await statusOf('STILL-GOOD')).toEqual(['RESERVED']);
      expect(await available(A)).toBe(7);
      // a second sweep finds nothing
      expect(
        await commands.execute(new ReleaseExpiredReservationsCommand()),
      ).toBe(0);
      expect(await available(A)).toBe(7);
      await expectConsistent(A);
    });

    it('keeps the hold when the timer cannot be set, and the sweep returns it later (AC-16)', async () => {
      await setStock(A, 10);
      vi.spyOn(jobs, 'enqueue').mockRejectedValue(new Error('broker down'));

      const result = await settle(reserve('O1', [{ skuId: A, qty: 2 }]));

      expect(result.ok).toBe(true);
      expect(await available(A)).toBe(8);
      expect(await statusOf('O1')).toEqual(['RESERVED']);

      await expire('O1');
      await maintenance.runOnce();

      expect(await statusOf('O1')).toEqual(['RELEASED']);
      expect(await available(A)).toBe(10);
    });
  });

  describe('rebuilding what Redis lost (AC-17 to AC-19)', () => {
    it('rebuilds from Postgres and does not call a lost number "sold out" (AC-17)', async () => {
      await setStock(A, 10);
      await reserve('O1', [{ skuId: A, qty: 2 }]); // held
      await reserve('O2', [{ skuId: A, qty: 3 }]); // held
      await reserve('O3', [{ skuId: A, qty: 1 }]);
      await confirm('O3'); // paid: onHand 10 -> 9
      await reserve('O4', [{ skuId: A, qty: 4 }]);
      await release('O4'); // given back
      expect(await onHand(A)).toBe(9);
      await forgetRedis(); // Redis loses everything

      const result = await settle(reserve('O5', [{ skuId: A, qty: 4 }]));

      // 9 on hand - (2 + 3) held = 4 can be sold; O5 takes all 4
      expect(result.ok).toBe(true);
      expect(await available(A)).toBe(0);
      const next = await settle(reserve('O6', [{ skuId: A, qty: 1 }]));
      expect(!next.ok && next.code).toBe(InventoryErrorCodes.OUT_OF_STOCK.code);
      await expectConsistent(A);
    });

    it('rebuilds once, however many requests find the number missing, and never oversells (AC-18)', async () => {
      await setStock(A, 10);
      await forgetRedis();
      const snapshot = vi.spyOn(stockRepo, 'getSnapshot');

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          settle(reserve(`REB-${i}`, [{ skuId: A, qty: 1 }])),
        ),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect(results.filter((r) => !r.ok)).toHaveLength(10);
      expect(await available(A)).toBe(0);
      expect(snapshot.mock.calls.filter(([sku]) => sku === A)).toHaveLength(1);
      await expectConsistent(A);
    });

    it('rebuilds once even when two servers need the same SKU, because they take the same lock (AC-18)', async () => {
      await setStock(A, 10);
      await forgetRedis();
      const snapshot = vi.spyOn(stockRepo, 'getSnapshot');
      // Two server processes: each has its own StockRebuilder, but they share Redis and Postgres
      const serverOne = moduleRef.get(StockRebuilder);
      const serverTwo = new StockRebuilder(
        stockRepo,
        store,
        moduleRef.get(LockService),
      );

      await Promise.all([
        ...Array.from({ length: 10 }, () => serverOne.rebuild([A])),
        ...Array.from({ length: 10 }, () => serverTwo.rebuild([A])),
      ]);

      expect(snapshot.mock.calls.filter(([sku]) => sku === A)).toHaveLength(1);
      expect(await available(A)).toBe(10);
    });

    it('rebuilds from the units held when the number is lost with holds in place (AC-18)', async () => {
      await setStock(A, 10);
      await reserve('O1', [{ skuId: A, qty: 4 }]);
      await forgetRedis();

      await rebuild(A);

      expect(await available(A)).toBe(6);
    });

    it('does not make up a number from a release when Redis has none (AC-19)', async () => {
      await setStock(A, 10);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      await forgetRedis();

      await release('O1');

      expect(await redis.exists(KEYS.AVAILABLE(A))).toBe(0);
      // the next read rebuilds from Postgres, where the hold is already gone
      await rebuild(A);
      expect(await available(A)).toBe(10);
    });
  });

  describe('when a step fails or the process dies (AC-20 to AC-22)', () => {
    it('gives the units back in Redis when Postgres cannot save the lines (AC-20)', async () => {
      await setStock(A, 5);
      vi.spyOn(reservationRepo, 'create').mockRejectedValue(
        new Error('connection lost'),
      );

      const result = await settle(reserve('O1', [{ skuId: A, qty: 2 }]));

      expect(!result.ok && result.code).toBe(
        InventoryErrorCodes.STOCK_UNAVAILABLE.code,
      );
      expect(await available(A)).toBe(5);
      expect(await redis.exists(KEYS.INFLIGHT('O1'))).toBe(0);
      expect(await prisma.reservation.count()).toBe(0);
    });

    it('returns units a dead process took in Redis but never saved, only after the grace period (AC-21)', async () => {
      await setStock(A, 5);
      // (the stock row was just written, so Redis has no number yet; give it one, as it would in use)
      await rebuild(A);
      // The process dies right after the Redis step: no line in Postgres, record left behind
      await store.hold('GHOST', 'fp', [{ skuId: A, qty: 2 }]);
      expect(await available(A)).toBe(3);

      // A fresh record might still be a request in progress: it is left alone
      expect(await commands.execute(new RepairInFlightHoldsCommand())).toEqual({
        cleared: 0,
        returned: 0,
      });
      expect(await available(A)).toBe(3);

      await waitOnRedisClock(redis, 1300); // past the grace period (1 s in this test)
      expect(await commands.execute(new RepairInFlightHoldsCommand())).toEqual({
        cleared: 0,
        returned: 1,
      });
      expect(await available(A)).toBe(5);
      expect(await redis.exists(KEYS.INFLIGHT('GHOST'))).toBe(0);

      // and nothing happens the second time
      expect(await commands.execute(new RepairInFlightHoldsCommand())).toEqual({
        cleared: 0,
        returned: 0,
      });
      expect(await available(A)).toBe(5);
    });

    it('only clears the record when the process died after saving (AC-21)', async () => {
      await setStock(A, 5);
      await rebuild(A); // Redis has the number
      await store.hold('SAVED', 'fp', [{ skuId: A, qty: 2 }]);
      await prisma.reservation.create({
        data: {
          id: 'saved_line',
          orderId: 'SAVED',
          skuId: A,
          qty: 2,
          expiresAt: new Date(Date.now() + 900_000),
        },
      });
      await waitOnRedisClock(redis, 1300); // past the grace period (1 s in this test)

      const result = await commands.execute(new RepairInFlightHoldsCommand());

      expect(result).toEqual({ cleared: 1, returned: 0 });
      expect(await available(A)).toBe(3); // the hold is real: not given back
      expect(await redis.exists(KEYS.INFLIGHT('SAVED'))).toBe(0);
      await expectConsistent(A);
    });

    it('refuses to sell, and saves nothing, when Redis cannot be reached (AC-22)', async () => {
      const broken = new Redis({
        host: 'localhost',
        port: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      const down = await build({}, (builder) =>
        builder
          .overrideProvider('IAvailabilityStore')
          .useValue(
            new RedisAvailabilityStore({ getClient: () => broken } as any),
          ),
      );
      const previous = moduleRef;
      try {
        pick(down);
        await seedStockInPostgresOnly(A, 5);

        const result = await settle(reserve('O1', [{ skuId: A, qty: 2 }]));

        expect(!result.ok && result.code).toBe(
          InventoryErrorCodes.STOCK_UNAVAILABLE.code,
        );
        expect(await prisma.reservation.count()).toBe(0);
      } finally {
        pick(previous);
        broken.disconnect();
        await down.close();
      }
    });

    const seedStockInPostgresOnly = (skuId: string, units: number) =>
      prisma.skuStock.create({ data: { skuId, onHand: units } });
  });

  describe('putting back stock that was already paid for (AC-25, AC-26)', () => {
    const giveBackPaid = (orderId: string) =>
      commands.execute(new ReturnReservationCommand(orderId));
    const failureOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error: any) {
        return error.code as string;
      }
      throw new Error('should have failed');
    };

    it('puts the units back into the warehouse and into Redis, so the numbers are as before the order', async () => {
      await setStock(A, 5);
      await setStock(B, 3);
      await reserve('O1', [
        { skuId: A, qty: 2 },
        { skuId: B, qty: 1 },
      ]);
      await confirm('O1');
      expect(await onHand(A)).toBe(3);
      expect(await available(A)).toBe(3); // paid units are gone, not held

      await giveBackPaid('O1');

      expect(await statusOf('O1')).toEqual(['RETURNED', 'RETURNED']);
      expect(await onHand(A)).toBe(5);
      expect(await onHand(B)).toBe(3);
      expect(await available(A)).toBe(5);
      expect(await available(B)).toBe(3);
      await expectConsistent(A);
      await expectConsistent(B);
    });

    it('does nothing the second time, and ten returns at once put the units back once', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      await confirm('O1');

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => giveBackPaid('O1')),
      );
      await giveBackPaid('O1');

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await onHand(A)).toBe(5);
      expect(await available(A)).toBe(5);
    });

    it('is still right after Redis lost its numbers and they were rebuilt from Postgres', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      await confirm('O1');
      await giveBackPaid('O1');

      await forgetRedis();
      await rebuild(A);

      expect(await available(A)).toBe(5); // onHand 5 minus nothing held
    });

    it('skips a SKU Redis has no number for, and the rebuild later gives the right number', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      await confirm('O1');
      await forgetRedis();

      await giveBackPaid('O1');

      expect(await onHand(A)).toBe(5);
      expect(await available(A)).toBeNull(); // nothing was made up from the quantity alone
      await rebuild(A);
      expect(await available(A)).toBe(5);
    });

    it('still succeeds when Redis cannot take the units; Redis shows fewer units until a rebuild', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      await confirm('O1');
      vi.spyOn(store, 'giveBack').mockRejectedValueOnce(
        new Error('redis down'),
      );

      await expect(giveBackPaid('O1')).resolves.toBeUndefined();

      expect(await onHand(A)).toBe(5); // Postgres is the truth and has them back
      expect(await available(A)).toBe(3); // the safe side: fewer than there are
      await forgetRedis();
      await rebuild(A);
      expect(await available(A)).toBe(5);
    });

    it('turns away an order that was never paid (INV-008) and one that holds nothing (INV-003)', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);

      expect(await failureOf(giveBackPaid('O1'))).toBe(
        InventoryErrorCodes.RESERVATION_NOT_CONFIRMED.code,
      );
      expect(await failureOf(giveBackPaid('nope'))).toBe(
        InventoryErrorCodes.RESERVATION_NOT_FOUND.code,
      );
      // nothing moved: the hold is still the hold
      expect(await statusOf('O1')).toEqual(['RESERVED']);
      expect(await onHand(A)).toBe(5);
      expect(await available(A)).toBe(3);

      await release('O1');
      expect(await failureOf(giveBackPaid('O1'))).toBe(
        InventoryErrorCodes.RESERVATION_NOT_CONFIRMED.code,
      );
      expect(await available(A)).toBe(5);
    });

    it('gives the order no way back in: holding or paying again after the return is refused (INV-006)', async () => {
      await setStock(A, 5);
      await reserve('O1', [{ skuId: A, qty: 2 }]);
      await confirm('O1');
      await giveBackPaid('O1');

      expect(await failureOf(reserve('O1', [{ skuId: A, qty: 2 }]))).toBe(
        InventoryErrorCodes.RESERVATION_RELEASED.code,
      );
      expect(await failureOf(confirm('O1'))).toBe(
        InventoryErrorCodes.RESERVATION_RELEASED.code,
      );
      expect(await onHand(A)).toBe(5);
      expect(await available(A)).toBe(5);
    });

    it('lets the freed units be bought by someone else', async () => {
      await setStock(A, 1);
      await reserve('O1', [{ skuId: A, qty: 1 }]);
      await confirm('O1');
      expect(await failureOf(reserve('O2', [{ skuId: A, qty: 1 }]))).toBe(
        InventoryErrorCodes.OUT_OF_STOCK.code,
      );

      await giveBackPaid('O1');

      await expect(
        reserve('O2', [{ skuId: A, qty: 1 }]),
      ).resolves.toBeDefined();
      await expectConsistent(A);
    });

    it('keeps the books right when fifty paid orders are all cancelled at once', async () => {
      await setStock(A, 100);
      await rebuild(A);
      const orders = Array.from({ length: 50 }, (_, i) => `PAID-${i}`);
      for (const orderId of orders) {
        await reserve(orderId, [{ skuId: A, qty: 1 }]);
        await confirm(orderId);
      }
      expect(await onHand(A)).toBe(50);

      const results = await Promise.allSettled(
        orders.map((orderId) => giveBackPaid(orderId)),
      );

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await onHand(A)).toBe(100);
      expect(await available(A)).toBe(100);
      for (const orderId of orders) {
        expect(await statusOf(orderId)).toEqual(['RETURNED']);
      }
      await expectConsistent(A);
    });
  });

  describe('the periodic round', () => {
    it('releases expired holds and repairs leaked ones in one go', async () => {
      await setStock(A, 10);
      await reserve('EXPIRED', [{ skuId: A, qty: 2 }]);
      await expire('EXPIRED');
      await store.hold('GHOST', 'fp', [{ skuId: A, qty: 3 }]);
      await waitOnRedisClock(redis, 1300); // past the grace period (1 s in this test)

      await maintenance.runOnce();

      expect(await statusOf('EXPIRED')).toEqual(['RELEASED']);
      expect(await available(A)).toBe(10);
      await expectConsistent(A);
    });

    it('does not overlap with a round another instance is running', async () => {
      await setStock(A, 10);
      await reserve('EXPIRED', [{ skuId: A, qty: 2 }]);
      await expire('EXPIRED');

      // Two rounds at once: one gets the lock, the other skips quietly; the work is done once
      await Promise.all([maintenance.runOnce(), maintenance.runOnce()]);

      expect(await statusOf('EXPIRED')).toEqual(['RELEASED']);
      expect(await available(A)).toBe(10);
    });
  });
});
