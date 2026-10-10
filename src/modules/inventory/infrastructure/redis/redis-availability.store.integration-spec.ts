import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Logger } from '@nestjs/common';
import { CACHE, InventoryErrorCodes, RedisService } from '@/core/index.js';
import { RedisAvailabilityStore } from './redis-availability.store.js';

const KEYS = CACHE.INVENTORY.KEYS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Against the real Redis: the Lua scripts are what is under test, and a mock would prove nothing. */
describe('RedisAvailabilityStore (Integration)', () => {
  let store: RedisAvailabilityStore;
  let redis: RedisService;
  let client: Redis;

  const setStock = async (numbers: Record<string, number>) => {
    for (const [skuId, units] of Object.entries(numbers)) {
      await client.set(KEYS.AVAILABLE(skuId), String(units));
    }
  };
  const stockOf = async (skuId: string) => {
    const value = await client.get(KEYS.AVAILABLE(skuId));
    return value === null ? null : Number(value);
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisAvailabilityStore, RedisService],
    }).compile();
    store = module.get(RedisAvailabilityStore);
    redis = module.get(RedisService);
    client = redis.getClient();
  });

  beforeEach(async () => {
    const keys = await client.keys('ecom:v1:inventory:*');
    if (keys.length > 0) await client.del(...keys);
  });

  afterAll(async () => {
    const keys = await client.keys('ecom:v1:inventory:*');
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  describe('hold: the whole order or nothing (AC-1, AC-3, AC-4)', () => {
    it('takes every item and writes the being-held record', async () => {
      await setStock({ A: 5, B: 3 });

      const result = await store.hold('O1', 'fp-1', [
        { skuId: 'A', qty: 2 },
        { skuId: 'B', qty: 1 },
      ]);

      expect(result).toEqual({ kind: 'HELD' });
      expect(await stockOf('A')).toBe(3);
      expect(await stockOf('B')).toBe(2);
      expect(await store.readInflight('O1')).toEqual([
        { skuId: 'A', qty: 2 },
        { skuId: 'B', qty: 1 },
      ]);
      expect(await client.zscore(KEYS.INFLIGHT_INDEX, 'O1')).not.toBeNull();
    });

    it('takes exactly what is there: the last unit goes to one order', async () => {
      await setStock({ A: 2 });

      expect(await store.hold('O1', 'fp', [{ skuId: 'A', qty: 2 }])).toEqual({
        kind: 'HELD',
      });
      expect(await stockOf('A')).toBe(0);
    });

    it('takes nothing when one item is short, and reports every short item with what Redis has', async () => {
      await setStock({ A: 1, B: 0, C: 10 });

      const result = await store.hold('O1', 'fp', [
        { skuId: 'A', qty: 2 },
        { skuId: 'B', qty: 1 },
        { skuId: 'C', qty: 1 },
      ]);

      expect(result).toEqual({
        kind: 'SHORT',
        shortages: [
          { skuId: 'A', requested: 2, available: 1 },
          { skuId: 'B', requested: 1, available: 0 },
        ],
      });
      // C had plenty and was not touched: nothing is taken for a short order
      expect(await stockOf('A')).toBe(1);
      expect(await stockOf('B')).toBe(0);
      expect(await stockOf('C')).toBe(10);
      expect(await store.readInflight('O1')).toBeNull();
      expect(await client.zscore(KEYS.INFLIGHT_INDEX, 'O1')).toBeNull();
    });
  });

  describe('a number Redis lost is not "sold out" (AC-5, AC-17)', () => {
    it('answers MISSING for the SKUs without a number and takes nothing', async () => {
      await setStock({ A: 5 });

      const result = await store.hold('O1', 'fp', [
        { skuId: 'A', qty: 1 },
        { skuId: 'B', qty: 1 },
        { skuId: 'C', qty: 1 },
      ]);

      expect(result).toEqual({ kind: 'MISSING', skuIds: ['B', 'C'] });
      expect(await stockOf('A')).toBe(5);
      expect(await stockOf('B')).toBeNull(); // and no number was invented
    });

    it('says MISSING before SHORT: a lost number could be enough once rebuilt', async () => {
      await setStock({ A: 0 }); // short for 1

      const result = await store.hold('O1', 'fp', [
        { skuId: 'A', qty: 1 },
        { skuId: 'B', qty: 1 },
      ]);

      expect(result).toEqual({ kind: 'MISSING', skuIds: ['B'] });
    });

    it('treats a number of 0 as a number, not as lost', async () => {
      await setStock({ A: 0 });

      const result = await store.hold('O1', 'fp', [{ skuId: 'A', qty: 1 }]);

      expect(result.kind).toBe('SHORT');
    });
  });

  describe('the same order twice (AC-8)', () => {
    it('answers IN_PROGRESS to the second hold and does not take the units again', async () => {
      await setStock({ A: 5 });
      await store.hold('O1', 'fp', [{ skuId: 'A', qty: 2 }]);

      const second = await store.hold('O1', 'fp', [{ skuId: 'A', qty: 2 }]);

      expect(second).toEqual({ kind: 'IN_PROGRESS' });
      expect(await stockOf('A')).toBe(3);
    });

    it('lets the order be held again once the record is cleared (finishHold)', async () => {
      await setStock({ A: 5 });
      await store.hold('O1', 'fp', [{ skuId: 'A', qty: 2 }]);
      await store.finishHold('O1');

      expect(await store.readInflight('O1')).toBeNull();
      expect(await client.zscore(KEYS.INFLIGHT_INDEX, 'O1')).toBeNull();
      // (the caller decides; Postgres answers a retry before Redis is asked again)
      expect(await store.hold('O1', 'fp', [{ skuId: 'A', qty: 1 }])).toEqual({
        kind: 'HELD',
      });
    });
  });

  describe('contention: many buyers at once (AC-2)', () => {
    it('hands the last unit to exactly one of 200 simultaneous orders and never goes below zero', async () => {
      await setStock({ A: 1 });

      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          store.hold(`O${i}`, `fp${i}`, [{ skuId: 'A', qty: 1 }]),
        ),
      );

      expect(results.filter((r) => r.kind === 'HELD')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'SHORT')).toHaveLength(199);
      expect(await stockOf('A')).toBe(0);
    });

    it('sells exactly 10 of 10 to 25 buyers of 1 each, in any interleaving', async () => {
      await setStock({ A: 10 });

      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          store.hold(`O${i}`, `fp${i}`, [{ skuId: 'A', qty: 1 }]),
        ),
      );

      expect(results.filter((r) => r.kind === 'HELD')).toHaveLength(10);
      expect(await stockOf('A')).toBe(0);
    });

    it('never splits an order across two SKUs: orders competing for A and B all-or-nothing', async () => {
      await setStock({ A: 3, B: 2 });

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.hold(`O${i}`, `fp${i}`, [
            { skuId: 'A', qty: 1 },
            { skuId: 'B', qty: 1 },
          ]),
        ),
      );

      const held = results.filter((r) => r.kind === 'HELD').length;
      expect(held).toBe(2); // B runs out first
      expect(await stockOf('A')).toBe(3 - held);
      expect(await stockOf('B')).toBe(0);
    });
  });

  describe('undoHold (AC-20, AC-21)', () => {
    it('gives the units back and removes the record', async () => {
      await setStock({ A: 5 });
      const items = [{ skuId: 'A', qty: 2 }];
      await store.hold('O1', 'fp', items);

      expect(await store.undoHold('O1', items)).toBe(true);

      expect(await stockOf('A')).toBe(5);
      expect(await store.readInflight('O1')).toBeNull();
      expect(await client.zscore(KEYS.INFLIGHT_INDEX, 'O1')).toBeNull();
    });

    it('adds back only once, however many times it is called', async () => {
      await setStock({ A: 5 });
      const items = [{ skuId: 'A', qty: 2 }];
      await store.hold('O1', 'fp', items);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.undoHold('O1', items)),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await stockOf('A')).toBe(5);
    });

    it('adds nothing when there is no record: the order was never held, or was already settled', async () => {
      await setStock({ A: 5 });

      expect(await store.undoHold('O1', [{ skuId: 'A', qty: 2 }])).toBe(false);

      expect(await stockOf('A')).toBe(5);
    });

    it('does not create a number for a SKU that Redis lost in the meantime', async () => {
      await setStock({ A: 5, B: 5 });
      const items = [
        { skuId: 'A', qty: 1 },
        { skuId: 'B', qty: 1 },
      ];
      await store.hold('O1', 'fp', items);
      await client.del(KEYS.AVAILABLE('B')); // Redis lost B

      await store.undoHold('O1', items);

      expect(await stockOf('A')).toBe(5);
      expect(await stockOf('B')).toBeNull();
    });
  });

  describe('listStaleInflight (AC-21)', () => {
    it('lists only records older than the given age, by the Redis clock, oldest first', async () => {
      await setStock({ A: 9 });
      await store.hold('OLD', 'fp', [{ skuId: 'A', qty: 1 }]);
      await sleep(60);
      await store.hold('NEW', 'fp', [{ skuId: 'A', qty: 1 }]);

      expect(await store.listStaleInflight(30, 10)).toEqual(['OLD']);
      expect(await store.listStaleInflight(60_000, 10)).toEqual([]);
      await sleep(40);
      expect(await store.listStaleInflight(30, 10)).toEqual(['OLD', 'NEW']);
    });

    it('stops at the limit', async () => {
      await setStock({ A: 9 });
      for (const id of ['O1', 'O2', 'O3']) {
        await store.hold(id, 'fp', [{ skuId: 'A', qty: 1 }]);
        await sleep(5);
      }
      await sleep(20);

      expect(await store.listStaleInflight(10, 2)).toEqual(['O1', 'O2']);
    });
  });

  describe('giveBack (AC-19)', () => {
    it('adds the units to the numbers that exist', async () => {
      await setStock({ A: 3, B: 0 });

      await store.giveBack([
        { skuId: 'A', qty: 2 },
        { skuId: 'B', qty: 1 },
      ]);

      expect(await stockOf('A')).toBe(5);
      expect(await stockOf('B')).toBe(1);
    });

    it('skips a SKU Redis has no number for, instead of inventing one from the quantity alone', async () => {
      await setStock({ A: 3 });

      await store.giveBack([
        { skuId: 'A', qty: 2 },
        { skuId: 'LOST', qty: 2 },
      ]);

      expect(await stockOf('A')).toBe(5);
      expect(await stockOf('LOST')).toBeNull();
    });

    it('does nothing for an empty list', async () => {
      await expect(store.giveBack([])).resolves.toBeUndefined();
    });
  });

  describe('setIfAbsent, peek and delete (AC-18, AC-24)', () => {
    it('writes a number only where there is none', async () => {
      expect(await store.setIfAbsent('A', 7)).toBe(true);
      expect(await store.setIfAbsent('A', 99)).toBe(false);

      expect(await stockOf('A')).toBe(7); // the live number was not overwritten
    });

    it('keeps 0 as a real number', async () => {
      expect(await store.setIfAbsent('A', 0)).toBe(true);
      expect(await store.setIfAbsent('A', 5)).toBe(false);
      expect(await stockOf('A')).toBe(0);
    });

    it('peeks the numbers without changing anything, null for a lost one', async () => {
      await setStock({ A: 4, Z: 0 });

      const numbers = await store.peek(['A', 'B', 'Z']);

      expect([...numbers]).toEqual([
        ['A', 4],
        ['B', null],
        ['Z', 0],
      ]);
      expect(await stockOf('B')).toBeNull();
    });

    it('peeks nothing for an empty list', async () => {
      expect((await store.peek([])).size).toBe(0);
    });

    it('forgets the numbers of the SKUs it is told to', async () => {
      await setStock({ A: 1, B: 2, C: 3 });

      await store.delete(['A', 'C']);

      expect(await stockOf('A')).toBeNull();
      expect(await stockOf('B')).toBe(2);
      expect(await stockOf('C')).toBeNull();
    });
  });

  describe('Redis cannot be reached (AC-22)', () => {
    let brokenClient: Redis;
    let broken: RedisAvailabilityStore;

    beforeAll(() => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      // A real client pointed at a port nobody listens on, failing at once instead of queueing
      brokenClient = new Redis({
        host: 'localhost',
        port: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      broken = new RedisAvailabilityStore({
        getClient: () => brokenClient,
      } as unknown as RedisService);
    });

    afterAll(() => {
      brokenClient.disconnect();
      vi.restoreAllMocks();
    });

    it.each([
      ['hold', () => broken.hold('O1', 'fp', [{ skuId: 'A', qty: 1 }])],
      ['peek', () => broken.peek(['A'])],
      ['finishHold', () => broken.finishHold('O1')],
      ['undoHold', () => broken.undoHold('O1', [{ skuId: 'A', qty: 1 }])],
      ['readInflight', () => broken.readInflight('O1')],
      ['listStaleInflight', () => broken.listStaleInflight(1000, 10)],
      ['giveBack', () => broken.giveBack([{ skuId: 'A', qty: 1 }])],
      ['setIfAbsent', () => broken.setIfAbsent('A', 1)],
      ['delete', () => broken.delete(['A'])],
    ])('%s fails with INV-007 instead of guessing', async (_, call) => {
      await expect(call()).rejects.toMatchObject({
        code: InventoryErrorCodes.STOCK_UNAVAILABLE.code,
      });
    });
  });
});
