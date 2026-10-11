import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Logger } from '@nestjs/common';
import { CACHE, CartErrorCodes, RedisService } from '@/core/index.js';
import { RedisCartStore } from '../../infrastructure/redis/redis-cart.store.js';
import { CartOrderingService } from './cart-ordering.service.js';

const KEY = CACHE.CART.KEYS.CART;
const THIRTY_DAYS = CACHE.CART.SETTINGS.TTL;
const U1 = 'cart_ord_user_1';
const U2 = 'cart_ord_user_2';

/** Against the real Redis: the script that takes several items out is what is under test. */
describe('CartOrderingService (Integration)', () => {
  let service: CartOrderingService;
  let store: RedisCartStore;
  let client: Redis;

  const skuIds = async (userId: string) =>
    (await service.getLines(userId)).map((line) => line.skuId).sort();
  const clean = async () => {
    const keys = await client.keys('ecom:v1:cart:*');
    if (keys.length > 0) await client.del(...keys);
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        RedisCartStore,
        { provide: 'ICartStore', useExisting: RedisCartStore },
        CartOrderingService,
      ],
    }).compile();
    service = module.get(CartOrderingService);
    store = module.get(RedisCartStore);
    client = module.get(RedisService).getClient();
  });

  beforeEach(clean);

  afterAll(async () => {
    await clean();
    await client.quit();
  });

  describe('getLines', () => {
    it('gives the lines as they are: quantity, price seen and when, nothing looked up again', async () => {
      await store.add(U1, 'A', 2, 3990000);
      await store.add(U1, 'B', 1, 199000.5);

      const lines = await service.getLines(U1);

      expect(
        lines.map((l) => [l.skuId, l.quantity, l.addedPrice]).sort(),
      ).toEqual([
        ['A', 2, 3990000],
        ['B', 1, 199000.5],
      ]);
      for (const line of lines) expect(line.addedAt).toBeGreaterThan(0);
    });

    it('gives an empty list for a user without a cart', async () => {
      expect(await service.getLines(U1)).toEqual([]);
    });
  });

  describe('removeLines', () => {
    it('takes out exactly the given SKUs and leaves the other items', async () => {
      for (const sku of ['A', 'B', 'C', 'D']) await store.add(U1, sku, 1, 1000);

      await service.removeLines(U1, ['B', 'D']);

      expect(await skuIds(U1)).toEqual(['A', 'C']);
    });

    it('skips a SKU that is not in the cart and still takes out the others', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U1, 'B', 1, 1000);

      await service.removeLines(U1, ['NOT-THERE', 'A']);

      expect(await skuIds(U1)).toEqual(['B']);
    });

    it('does nothing for an empty list, for a cart that does not exist, and when repeated', async () => {
      await store.add(U1, 'A', 1, 1000);
      const ttlBefore = await client.ttl(KEY(U1));

      await service.removeLines(U1, []);
      await service.removeLines(U2, ['A']);
      await service.removeLines(U1, ['A']);
      await service.removeLines(U1, ['A']);

      expect(ttlBefore).toBeGreaterThan(0);
      expect(await skuIds(U1)).toEqual([]);
      expect(await skuIds(U2)).toEqual([]);
    });

    it('leaves no key behind when the last items are taken out', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U1, 'B', 1, 1000);

      await service.removeLines(U1, ['A', 'B']);

      expect(await client.exists(KEY(U1))).toBe(0);
    });

    it('starts the 30 days again while items remain', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U1, 'B', 1, 1000);
      await client.expire(KEY(U1), 100);

      await service.removeLines(U1, ['A']);

      expect(await client.ttl(KEY(U1))).toBeGreaterThan(THIRTY_DAYS - 60);
    });

    it('only touches the cart of the user it is given', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U2, 'A', 5, 1000);

      await service.removeLines(U1, ['A']);

      expect(await skuIds(U1)).toEqual([]);
      expect(await skuIds(U2)).toEqual(['A']);
    });

    it('takes out fifty items in one go', async () => {
      const all = Array.from({ length: 50 }, (_, i) => `S${i}`);
      for (const sku of all) await store.add(U1, sku, 1, 1000);
      await store.add(U1, 'KEEP', 1, 1000).catch(() => undefined); // the cart is full: refused

      await service.removeLines(U1, all);

      expect(await skuIds(U1)).toEqual([]);
    });

    it('keeps working for the single-item remove the cart already had', async () => {
      await store.add(U1, 'A', 1, 1000);
      await store.add(U1, 'B', 1, 1000);

      await store.remove(U1, 'A');

      expect(await skuIds(U1)).toEqual(['B']);
    });
  });

  describe('Redis cannot be reached', () => {
    let brokenClient: Redis;
    let broken: CartOrderingService;

    beforeAll(() => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      brokenClient = new Redis({
        host: 'localhost',
        port: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      broken = new CartOrderingService(
        new RedisCartStore({
          getClient: () => brokenClient,
        } as unknown as RedisService),
      );
    });

    afterAll(() => {
      brokenClient.disconnect();
      vi.restoreAllMocks();
    });

    it.each([
      ['getLines', () => broken.getLines(U1)],
      ['removeLines', () => broken.removeLines(U1, ['A'])],
    ])('%s fails with CART-005 instead of guessing', async (_, call) => {
      await expect(call()).rejects.toMatchObject({
        code: CartErrorCodes.CART_UNAVAILABLE.code,
      });
    });
  });
});
