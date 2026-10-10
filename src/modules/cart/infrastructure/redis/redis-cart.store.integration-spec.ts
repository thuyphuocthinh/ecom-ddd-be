import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Logger } from '@nestjs/common';
import { CACHE, CartErrorCodes, RedisService } from '@/core/index.js';
import { RedisCartStore } from './redis-cart.store.js';

const KEY = CACHE.CART.KEYS.CART;
const THIRTY_DAYS = CACHE.CART.SETTINGS.TTL;

const U1 = 'cart_user_1';
const U2 = 'cart_user_2';

/** Against the real Redis: the Lua scripts are what is under test, and a mock would prove nothing. */
describe('RedisCartStore (Integration)', () => {
  let store: RedisCartStore;
  let redis: RedisService;
  let client: Redis;

  const clean = async () => {
    const keys = await client.keys('ecom:v1:cart:*');
    if (keys.length > 0) await client.del(...keys);
  };
  const skuIds = async (userId: string) =>
    (await store.read(userId)).map((line) => line.skuId).sort();
  const lineOf = async (userId: string, skuId: string) =>
    (await store.read(userId)).find((line) => line.skuId === skuId);

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisCartStore, RedisService],
    }).compile();
    store = module.get(RedisCartStore);
    redis = module.get(RedisService);
    client = redis.getClient();
  });

  beforeEach(clean);

  afterAll(async () => {
    await clean();
    await client.quit();
  });

  describe('add (AC-2, AC-3)', () => {
    it('creates a line with the quantity, the price seen and the time of adding', async () => {
      const before = Date.now();

      const outcome = await store.add(U1, 'A', 2, 3990000);

      expect(outcome).toEqual({ kind: 'OK', quantity: 2 });
      const line = await lineOf(U1, 'A');
      expect(line).toMatchObject({
        skuId: 'A',
        quantity: 2,
        addedPrice: 3990000,
      });
      // the Redis clock and this process agree to within a couple of seconds
      expect(Math.abs(line!.addedAt - before)).toBeLessThan(5000);
    });

    it('adds up when the line exists, records the new price and keeps the first time', async () => {
      await store.add(U1, 'A', 2, 3990000);
      const first = await lineOf(U1, 'A');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const outcome = await store.add(U1, 'A', 3, 4990000);

      expect(outcome).toEqual({ kind: 'OK', quantity: 5 });
      const line = await lineOf(U1, 'A');
      expect(line).toMatchObject({ quantity: 5, addedPrice: 4990000 });
      expect(line!.addedAt).toBe(first!.addedAt);
      expect(await skuIds(U1)).toEqual(['A']); // not a second line
    });

    it('keeps prices with decimals exactly', async () => {
      await store.add(U1, 'A', 1, 199000.5);

      expect((await lineOf(U1, 'A'))!.addedPrice).toBe(199000.5);
    });
  });

  describe('the limits (AC-5)', () => {
    it('refuses a new item when the cart already has 50 lines, but still adds to an existing line', async () => {
      for (let i = 1; i <= 50; i++) await store.add(U1, `S${i}`, 1, 1000);

      expect(await store.add(U1, 'NEW', 1, 1000)).toEqual({
        kind: 'LINES_FULL',
      });
      expect(await store.add(U1, 'S7', 4, 1000)).toEqual({
        kind: 'OK',
        quantity: 5,
      });
      expect(await skuIds(U1)).toHaveLength(50);
      expect(await lineOf(U1, 'NEW')).toBeUndefined();
    });

    it('refuses what would be more than 99 of one item and leaves the line as it was', async () => {
      await store.add(U1, 'A', 95, 1000);

      expect(await store.add(U1, 'A', 5, 1000)).toEqual({
        kind: 'QUANTITY_EXCEEDED',
      });
      expect((await lineOf(U1, 'A'))!.quantity).toBe(95);
      expect(await store.add(U1, 'A', 4, 1000)).toEqual({
        kind: 'OK',
        quantity: 99,
      });
    });

    it('refuses a new line that starts above 99', async () => {
      expect(await store.add(U1, 'A', 100, 1000)).toEqual({
        kind: 'QUANTITY_EXCEEDED',
      });
      expect(await skuIds(U1)).toEqual([]);
    });

    it('refuses to set more than 99', async () => {
      await store.add(U1, 'A', 1, 1000);

      expect(await store.setQuantity(U1, 'A', 100, null)).toEqual({
        kind: 'QUANTITY_EXCEEDED',
      });
      expect((await lineOf(U1, 'A'))!.quantity).toBe(1);
      expect(await store.setQuantity(U1, 'A', 99, null)).toMatchObject({
        kind: 'OK',
        quantity: 99,
      });
    });
  });

  describe('setQuantity (AC-6)', () => {
    it('replaces the quantity, and sending it again changes nothing', async () => {
      await store.add(U1, 'A', 2, 1000);

      const first = await store.setQuantity(U1, 'A', 7, null);
      const again = await store.setQuantity(U1, 'A', 7, null);

      expect(first).toEqual({ kind: 'OK', quantity: 7, addedPrice: 1000 });
      expect(again).toEqual(first);
      expect((await lineOf(U1, 'A'))!.quantity).toBe(7);
    });

    it('records the price given, or keeps the recorded one when none is given', async () => {
      await store.add(U1, 'A', 1, 1000);

      const kept = await store.setQuantity(U1, 'A', 2, null);
      const replaced = await store.setQuantity(U1, 'A', 3, 1250.5);

      expect(kept).toMatchObject({ addedPrice: 1000 });
      expect(replaced).toMatchObject({ addedPrice: 1250.5 });
      expect((await lineOf(U1, 'A'))!.addedPrice).toBe(1250.5);
    });

    it('does not create a line that is not there', async () => {
      expect(await store.setQuantity(U1, 'A', 2, 1000)).toEqual({
        kind: 'NOT_IN_CART',
      });
      expect(await skuIds(U1)).toEqual([]);
    });

    it('keeps the time of first adding', async () => {
      await store.add(U1, 'A', 1, 1000);
      const first = await lineOf(U1, 'A');

      await store.setQuantity(U1, 'A', 5, 1000);

      expect((await lineOf(U1, 'A'))!.addedAt).toBe(first!.addedAt);
    });
  });

  describe('remove and clear (AC-7)', () => {
    it('removes one line and leaves the others; removing again or a missing line is fine', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U1, 'B', 1, 1000);

      await store.remove(U1, 'A');
      await store.remove(U1, 'A');
      await store.remove(U1, 'NOT-THERE');

      expect(await skuIds(U1)).toEqual(['B']);
    });

    it('leaves no key when the last line is removed', async () => {
      await store.add(U1, 'A', 1, 1000);

      await store.remove(U1, 'A');

      expect(await client.exists(KEY(U1))).toBe(0);
      expect(await store.read(U1)).toEqual([]);
    });

    it('empties the cart, also when it is already empty', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U1, 'B', 1, 1000);

      await store.clear(U1);
      await store.clear(U1);

      expect(await store.read(U1)).toEqual([]);
    });
  });

  describe('time to live (AC-12)', () => {
    it('is 30 days after adding, setting and removing a line (while lines remain)', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U1, 'B', 1, 1000);
      expect(await client.ttl(KEY(U1))).toBeGreaterThan(THIRTY_DAYS - 60);

      await client.expire(KEY(U1), 100);
      await store.setQuantity(U1, 'A', 2, null);
      expect(await client.ttl(KEY(U1))).toBeGreaterThan(THIRTY_DAYS - 60);

      await client.expire(KEY(U1), 100);
      await store.remove(U1, 'B');
      expect(await client.ttl(KEY(U1))).toBeGreaterThan(THIRTY_DAYS - 60);
    });

    it('is not renewed by reading', async () => {
      await store.add(U1, 'A', 1, 1000);
      await client.expire(KEY(U1), 100);

      await store.read(U1);
      await store.read(U1);

      expect(await client.ttl(KEY(U1))).toBeLessThanOrEqual(100);
    });

    it('makes a cart nobody touched disappear', async () => {
      await store.add(U1, 'A', 1, 1000);
      await client.pexpire(KEY(U1), 50);

      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(await store.read(U1)).toEqual([]);
    });
  });

  describe('carts of different users (AC-13)', () => {
    it('are separate, also for the same SKU', async () => {
      await store.add(U1, 'A', 2, 1000);
      await store.add(U2, 'A', 5, 1000);
      await store.remove(U1, 'A');

      expect(await lineOf(U1, 'A')).toBeUndefined();
      expect((await lineOf(U2, 'A'))!.quantity).toBe(5);
    });
  });

  describe('at the same moment (AC-11)', () => {
    it('does not lose a single addition: 20 adds of 1 make exactly 20', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.add(U1, 'A', 1, 1000)),
      );

      expect(results.every((r) => r.kind === 'OK')).toBe(true);
      expect((await lineOf(U1, 'A'))!.quantity).toBe(20);
      // each add saw a different number: nobody read the same old value
      const seen = results.map((r) => (r.kind === 'OK' ? r.quantity : 0));
      expect(new Set(seen).size).toBe(20);
    });

    it('lets exactly 99 of 100 adds in', async () => {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => store.add(U1, 'A', 1, 1000)),
      );

      expect(results.filter((r) => r.kind === 'OK')).toHaveLength(99);
      expect(
        results.filter((r) => r.kind === 'QUANTITY_EXCEEDED'),
      ).toHaveLength(1);
      expect((await lineOf(U1, 'A'))!.quantity).toBe(99);
    });

    it('lets exactly 5 new items in when there are 45 lines and 10 different new items come together', async () => {
      for (let i = 1; i <= 45; i++) await store.add(U1, `S${i}`, 1, 1000);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.add(U1, `N${i}`, 1, 1000)),
      );

      expect(results.filter((r) => r.kind === 'OK')).toHaveLength(5);
      expect(results.filter((r) => r.kind === 'LINES_FULL')).toHaveLength(5);
      expect(await skuIds(U1)).toHaveLength(50);
    });

    it('does not mix carts of two users adding together', async () => {
      await Promise.all([
        ...Array.from({ length: 10 }, () => store.add(U1, 'A', 1, 1000)),
        ...Array.from({ length: 7 }, () => store.add(U2, 'A', 1, 1000)),
      ]);

      expect((await lineOf(U1, 'A'))!.quantity).toBe(10);
      expect((await lineOf(U2, 'A'))!.quantity).toBe(7);
    });

    it('keeps one line when the same new item is added and set at once', async () => {
      await Promise.all([
        store.add(U1, 'A', 1, 1000),
        store.add(U1, 'A', 1, 1000),
        store.setQuantity(U1, 'A', 5, null),
        store.remove(U1, 'A'),
      ]);

      const lines = await store.read(U1);
      expect(lines.length).toBeLessThanOrEqual(1);
      for (const line of lines) expect(line.quantity).toBeGreaterThan(0);
    });
  });

  describe('a line that is not what the scripts write', () => {
    it('is left out when reading, and does not hold up adding', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await store.add(U1, 'GOOD', 2, 1000);
      await client.hset(KEY(U1), 'BAD', 'not json');
      await client.hset(KEY(U1), 'WRONG', JSON.stringify({ q: 'x' }));

      expect(await skuIds(U1)).toEqual(['GOOD']);
      // adding to a broken line replaces it instead of failing
      expect(await store.add(U1, 'BAD', 3, 1000)).toEqual({
        kind: 'OK',
        quantity: 3,
      });
      expect(await skuIds(U1)).toEqual(['BAD', 'GOOD']);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('reading 50 lines is fast (AC-16)', () => {
    it('takes a median under 10 ms', async () => {
      for (let i = 1; i <= 50; i++) await store.add(U1, `S${i}`, 3, 1999000);
      await store.read(U1); // warm up the connection and the script

      const times: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = process.hrtime.bigint();
        const lines = await store.read(U1);
        times.push(Number(process.hrtime.bigint() - start) / 1e6);
        expect(lines).toHaveLength(50);
      }
      times.sort((a, b) => a - b);

      expect(times[15]).toBeLessThan(10);
    });
  });

  describe('Redis cannot be reached (AC-15)', () => {
    let brokenClient: Redis;
    let broken: RedisCartStore;

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
      broken = new RedisCartStore({
        getClient: () => brokenClient,
      } as unknown as RedisService);
    });

    afterAll(() => {
      brokenClient.disconnect();
      vi.restoreAllMocks();
    });

    it.each([
      ['add', () => broken.add(U1, 'A', 1, 1000)],
      ['setQuantity', () => broken.setQuantity(U1, 'A', 1, null)],
      ['remove', () => broken.remove(U1, 'A')],
      ['clear', () => broken.clear(U1)],
      ['read', () => broken.read(U1)],
    ])('%s fails with CART-005 instead of guessing', async (_, call) => {
      await expect(call()).rejects.toMatchObject({
        code: CartErrorCodes.CART_UNAVAILABLE.code,
        status: 503,
      });
    });
  });
});
