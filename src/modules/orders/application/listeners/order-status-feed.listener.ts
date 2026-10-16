import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import {
  EVENT_BUS,
  type IEventBus,
  type IntegrationEvent,
} from '@/core/index.js';
import {
  ORDER_STATUS_CHANGED,
  ORDER_STATUS_FEED,
  OrderStatus,
  type IOrderStatusFeed,
} from '../../domain/index.js';

/** The queue of this consumer on the event bus. Its own queue: it never competes with another consumer. */
export const ORDER_STATUS_FEED_CONSUMER = 'orders.status-feed';

const STATUSES = new Set<string>(Object.values(OrderStatus));

/**
 * A consumer of the event bus that passes "order X is now in status S" on to the order status feed.
 *
 * The bus gives an event to ONE copy of the application; the feed (Redis pub/sub) then gives it to
 * EVERY copy, and the copy that holds the stream of the browser pushes it down. Passing it on twice
 * is harmless (the browser reloads the order), so no inbox is needed. When the feed cannot take the
 * message (Redis is down) the error goes on, and the event ends up in the dead-letter queue; the
 * browser still gets the current status the next time it opens the stream.
 */
@Injectable()
export class OrderStatusFeedListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(ORDER_STATUS_FEED) private readonly feed: IOrderStatusFeed,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(
      { name: ORDER_STATUS_FEED_CONSUMER, pattern: ORDER_STATUS_CHANGED },
      (event) => this.handle(event),
    );
  }

  async handle(event: IntegrationEvent): Promise<void> {
    const { data } = event;
    if (!data || typeof data !== 'object') return;
    const { orderId, to } = data as Record<string, unknown>;
    if (typeof orderId !== 'string' || orderId === '') return;
    if (typeof to !== 'string' || !STATUSES.has(to)) return;

    await this.feed.publish({ orderId, status: to as OrderStatus });
  }
}
