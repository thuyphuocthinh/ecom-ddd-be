import type { IEventBus, IntegrationEvent } from '@/core/index.js';
import { OrderStatus } from '../../domain/index.js';
import { InMemoryOrderStatusFeed } from '../../infrastructure/feed/in-memory-order-status-feed.js';
import {
  ORDER_STATUS_FEED_CONSUMER,
  OrderStatusFeedListener,
} from './order-status-feed.listener.js';

const event = (data: unknown): IntegrationEvent => ({
  id: 'evt-1',
  name: 'order.status_changed',
  occurredAt: new Date(),
  data,
});

function setup() {
  const feed = new InMemoryOrderStatusFeed();
  const publish = vi.spyOn(feed, 'publish');
  const subscribe = vi.fn();
  const listener = new OrderStatusFeedListener(
    { subscribe } as unknown as IEventBus,
    feed,
  );
  return { listener, feed, publish, subscribe };
}

describe('OrderStatusFeedListener (AC-9)', () => {
  it('subscribes to order.status_changed under its own name', () => {
    const { listener, subscribe } = setup();

    listener.onModuleInit();

    expect(subscribe).toHaveBeenCalledWith(
      { name: ORDER_STATUS_FEED_CONSUMER, pattern: 'order.status_changed' },
      expect.any(Function),
    );
    expect(ORDER_STATUS_FEED_CONSUMER).toBe('orders.status-feed');
  });

  it('publishes the new status of the order and nothing else', async () => {
    const { listener, publish } = setup();

    await listener.handle(
      event({
        orderId: 'order-1',
        userId: 'user-1',
        from: OrderStatus.PAYMENT_PROCESSING,
        to: OrderStatus.CONFIRMED,
      }),
    );

    expect(publish).toHaveBeenCalledWith({
      orderId: 'order-1',
      status: OrderStatus.CONFIRMED,
    });
  });

  it('reaches a listener watching that order', async () => {
    const { listener, feed } = setup();
    const watching = vi.fn();
    feed.watch('order-1', watching);

    await listener.handle(
      event({ orderId: 'order-1', to: OrderStatus.EXPIRED }),
    );

    expect(watching).toHaveBeenCalledWith({
      orderId: 'order-1',
      status: OrderStatus.EXPIRED,
    });
  });

  it.each([
    ['no data', undefined],
    ['data that is not an object', 'text'],
    ['no order id', { to: OrderStatus.CONFIRMED }],
    ['an empty order id', { orderId: '', to: OrderStatus.CONFIRMED }],
    ['no new status', { orderId: 'order-1' }],
    [
      'a status that does not exist',
      { orderId: 'order-1', to: 'SHIPPED_TO_MARS' },
    ],
  ])('ignores an event with %s, without failing', async (_name, data) => {
    const { listener, publish } = setup();

    await expect(listener.handle(event(data))).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
  });

  it('lets the error go on when the feed cannot take the message', async () => {
    const { listener, publish } = setup();
    const redisDown = new Error('redis down');
    publish.mockRejectedValueOnce(redisDown);

    await expect(
      listener.handle(event({ orderId: 'order-1', to: OrderStatus.CONFIRMED })),
    ).rejects.toBe(redisDown);
  });
});
