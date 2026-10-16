import type { MessageEvent } from '@nestjs/common';
import type { QueryBus } from '@nestjs/cqrs';
import { OrderStatus } from '../../domain/index.js';
import { InMemoryOrderStatusFeed } from '../../infrastructure/feed/in-memory-order-status-feed.js';
import {
  HEARTBEAT_MS,
  MAX_STREAM_MS,
  OrderStatusStreamService,
} from './order-status-stream.service.js';

const USER = 'user-1';
const ORDER = 'order-1';

/** A query bus whose answer to "read this order" is chosen by the test. */
function setup(read: () => Promise<{ status: OrderStatus }>) {
  const execute = vi.fn(read);
  const feed = new InMemoryOrderStatusFeed();
  const service = new OrderStatusStreamService(
    { execute } as unknown as QueryBus,
    feed,
  );
  return { service, feed, execute };
}

/** Subscribes and collects what the stream sends. */
async function listen(service: OrderStatusStreamService, orderId = ORDER) {
  const stream = await service.open(USER, orderId);
  const messages: MessageEvent[] = [];
  const state = { completed: false, error: undefined as unknown };
  const subscription = stream.subscribe({
    next: (message) => messages.push(message),
    complete: () => (state.completed = true),
    error: (error) => (state.error = error),
  });
  return { messages, state, subscription };
}

const status = (value: OrderStatus, orderId = ORDER): MessageEvent => ({
  type: 'status',
  data: { orderId, status: value },
});

describe('OrderStatusStreamService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the current status first (AC-1)', async () => {
    const { service } = setup(async () => ({
      status: OrderStatus.PAYMENT_PROCESSING,
    }));

    const { messages } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    expect(messages).toEqual([status(OrderStatus.PAYMENT_PROCESSING)]);
  });

  it('pushes a message when the order changes (AC-2)', async () => {
    const { service, feed } = setup(async () => ({
      status: OrderStatus.PAYMENT_PROCESSING,
    }));
    const { messages } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    await feed.publish({ orderId: ORDER, status: OrderStatus.CONFIRMED });

    expect(messages.at(-1)).toEqual(status(OrderStatus.CONFIRMED));
    expect(messages).toHaveLength(2);
  });

  it('ignores the changes of other orders (AC-3)', async () => {
    const { service, feed } = setup(async () => ({
      status: OrderStatus.PENDING,
    }));
    const { messages } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    await feed.publish({ orderId: 'other', status: OrderStatus.CONFIRMED });

    expect(messages).toEqual([status(OrderStatus.PENDING)]);
  });

  it('refuses an order that is not the user’s, and registers nothing (AC-4)', async () => {
    const notYours = new Error('ORD-002');
    const { service, feed } = setup(async () => {
      throw notYours;
    });
    const watch = vi.spyOn(feed, 'watch');

    await expect(service.open(USER, ORDER)).rejects.toBe(notYours);

    expect(watch).not.toHaveBeenCalled();
    expect(feed.watchers.count(ORDER)).toBe(0);
  });

  it.each([OrderStatus.DELIVERED, OrderStatus.CANCELLED, OrderStatus.EXPIRED])(
    'ends after a message with the final status %s (AC-5)',
    async (final) => {
      const { service, feed } = setup(async () => ({
        status: OrderStatus.PENDING,
      }));
      const { messages, state } = await listen(service);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.completed).toBe(false);

      await feed.publish({ orderId: ORDER, status: final });

      expect(messages.at(-1)).toEqual(status(final));
      expect(state.completed).toBe(true);
      expect(feed.watchers.count(ORDER)).toBe(0);
    },
  );

  it('sends the status and ends at once when the order is already final (AC-5)', async () => {
    const { service, feed } = setup(async () => ({
      status: OrderStatus.CANCELLED,
    }));

    const { messages, state } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    expect(messages).toEqual([status(OrderStatus.CANCELLED)]);
    expect(state.completed).toBe(true);
    expect(feed.watchers.count(ORDER)).toBe(0);
  });

  it('keeps going after CONFIRMED, which is not final', async () => {
    const { service } = setup(async () => ({ status: OrderStatus.CONFIRMED }));

    const { state } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.completed).toBe(false);
  });

  it('sends a ping every 20 seconds (AC-6)', async () => {
    const { service } = setup(async () => ({ status: OrderStatus.PENDING }));
    const { messages } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);

    const pings = messages.filter((message) => message.type === 'ping');
    expect(pings).toHaveLength(3);
  });

  it('closes by itself after 30 minutes (AC-6)', async () => {
    const { service, feed } = setup(async () => ({
      status: OrderStatus.PENDING,
    }));
    const { state } = await listen(service);
    await vi.advanceTimersByTimeAsync(MAX_STREAM_MS - 1);
    expect(state.completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(state.completed).toBe(true);
    expect(feed.watchers.count(ORDER)).toBe(0);
  });

  it('removes the listener and the timers when the browser disconnects (AC-7)', async () => {
    const { service, feed } = setup(async () => ({
      status: OrderStatus.PENDING,
    }));
    const { messages, subscription } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.watchers.count(ORDER)).toBe(1);

    subscription.unsubscribe();

    expect(feed.watchers.count(ORDER)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await feed.publish({ orderId: ORDER, status: OrderStatus.CONFIRMED });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(messages).toEqual([status(OrderStatus.PENDING)]);
  });

  it('listens before it reads, so a change in between is not lost', async () => {
    const order: string[] = [];
    const { service, feed } = setup(async () => {
      order.push('read');
      return { status: OrderStatus.PENDING };
    });
    const watch = feed.watch.bind(feed);
    vi.spyOn(feed, 'watch').mockImplementation((id, listener) => {
      order.push('watch');
      return watch(id, listener);
    });

    await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    // read (the check of the owner), then watch, then read again (the first status)
    expect(order).toEqual(['read', 'watch', 'read']);
  });

  it('ends with the error when the first read fails', async () => {
    let calls = 0;
    const broken = new Error('database down');
    const { service, feed } = setup(async () => {
      calls += 1;
      if (calls === 1) return { status: OrderStatus.PENDING };
      throw broken;
    });

    const { state } = await listen(service);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.error).toBe(broken);
    expect(feed.watchers.count(ORDER)).toBe(0);
  });
});
