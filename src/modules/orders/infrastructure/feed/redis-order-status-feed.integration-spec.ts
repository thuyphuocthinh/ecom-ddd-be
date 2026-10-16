import { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import { OrderStatus } from '../../domain/index.js';
import {
  ORDER_STATUS_CHANNEL,
  RedisOrderStatusFeed,
  parseUpdate,
} from './redis-order-status-feed.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (up to a second) until the condition holds, so a test does not depend on the exact delay. */
async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; waited < 1000 && !condition(); waited += 10) {
    await sleep(10);
  }
}

describe('parseUpdate', () => {
  it('reads a good message', () => {
    expect(
      parseUpdate(JSON.stringify({ orderId: 'X', status: 'CONFIRMED' })),
    ).toEqual({ orderId: 'X', status: OrderStatus.CONFIRMED });
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ orderId: '', status: 'CONFIRMED' }),
    JSON.stringify({ orderId: 'X', status: 'NOPE' }),
    JSON.stringify({ orderId: 7, status: 'CONFIRMED' }),
  ])('is null for %s', (message) => {
    expect(parseUpdate(message)).toBeNull();
  });
});

/**
 * Against the real Redis. Two feeds with two Redis connections play two copies of the application:
 * a message published by one must reach a listener of the other (AC-8).
 */
describe('RedisOrderStatusFeed (Integration)', () => {
  let redisA: RedisService;
  let redisB: RedisService;
  let copyA: RedisOrderStatusFeed;
  let copyB: RedisOrderStatusFeed;

  beforeAll(async () => {
    redisA = new RedisService();
    redisB = new RedisService();
    copyA = new RedisOrderStatusFeed(redisA);
    copyB = new RedisOrderStatusFeed(redisB);
    copyA.onModuleInit();
    copyB.onModuleInit();
    await Promise.all([copyA.subscribed, copyB.subscribed]);
  });

  afterAll(async () => {
    await copyA.onModuleDestroy();
    await copyB.onModuleDestroy();
    await redisA.getClient().quit();
    await redisB.getClient().quit();
  });

  it('delivers a message published by one copy to a listener in the other copy (AC-8)', async () => {
    const received: unknown[] = [];
    copyB.watch('order-AC8', (update) => received.push(update));

    await copyA.publish({
      orderId: 'order-AC8',
      status: OrderStatus.CONFIRMED,
    });
    await until(() => received.length > 0);

    expect(received).toEqual([
      { orderId: 'order-AC8', status: OrderStatus.CONFIRMED },
    ]);
  });

  it('delivers to a listener in the same copy that published', async () => {
    const received: unknown[] = [];
    copyA.watch('order-same', (update) => received.push(update));

    await copyA.publish({ orderId: 'order-same', status: OrderStatus.EXPIRED });
    await until(() => received.length > 0);

    expect(received).toHaveLength(1);
  });

  it('gives a message only to the listeners of its order', async () => {
    const other: unknown[] = [];
    copyB.watch('order-other', (update) => other.push(update));

    await copyA.publish({
      orderId: 'order-not-watched',
      status: OrderStatus.PENDING,
    });
    await sleep(100);

    expect(other).toEqual([]);
  });

  it('stops delivering after the listener is removed', async () => {
    const received: unknown[] = [];
    const stop = copyB.watch('order-stop', (update) => received.push(update));
    stop();

    await copyA.publish({
      orderId: 'order-stop',
      status: OrderStatus.CONFIRMED,
    });
    await sleep(100);

    expect(received).toEqual([]);
  });

  it('survives a message that is not an update', async () => {
    const received: unknown[] = [];
    copyB.watch('order-after-junk', (update) => received.push(update));

    await redisA.getClient().publish(ORDER_STATUS_CHANNEL, 'garbage');
    await copyA.publish({
      orderId: 'order-after-junk',
      status: OrderStatus.CONFIRMED,
    });
    await until(() => received.length > 0);

    expect(received).toHaveLength(1);
  });
});
