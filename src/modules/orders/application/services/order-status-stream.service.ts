import { Inject, Injectable } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Observable } from 'rxjs';
import {
  FINAL_STATUSES,
  ORDER_STATUS_FEED,
  type IOrderStatusFeed,
  type Order,
  type OrderStatus,
} from '../../domain/index.js';
import { GetOrderQuery } from '../queries/order.queries.js';

/** A line to keep the connection alive: proxies and browsers close a stream that stays silent. */
export const HEARTBEAT_MS = 20_000;
/** The longest one stream stays open; the browser opens a new one and gets the current status first. */
export const MAX_STREAM_MS = 30 * 60_000;

/**
 * The stream of status messages of one order, for server-sent events.
 *
 * - Somebody else's order (or none) is refused up front with the same error as reading it (ORD-002),
 *   before anything is registered or any connection is kept.
 * - It starts to listen first and reads the current status after, so a change in between is not lost.
 *   A message can still arrive older than the first read: a reader takes a message as "reload the
 *   order", never as the data itself.
 * - It ends by itself when the order reaches a final status, after `MAX_STREAM_MS`, or when the
 *   browser goes away; in every case the listener and the timers are removed.
 */
@Injectable()
export class OrderStatusStreamService {
  constructor(
    private readonly queryBus: QueryBus,
    @Inject(ORDER_STATUS_FEED) private readonly feed: IOrderStatusFeed,
  ) {}

  async open(
    userId: string,
    orderId: string,
  ): Promise<Observable<MessageEvent>> {
    await this.read(userId, orderId); // refuses an order that is not the user's

    return new Observable<MessageEvent>((subscriber) => {
      const send = (status: OrderStatus): void => {
        subscriber.next({ type: 'status', data: { orderId, status } });
        if (FINAL_STATUSES.includes(status)) subscriber.complete();
      };

      const unwatch = this.feed.watch(orderId, (update) => send(update.status));
      const heartbeat = setInterval(
        () => subscriber.next({ type: 'ping', data: {} }),
        HEARTBEAT_MS,
      );
      const lifetime = setTimeout(() => subscriber.complete(), MAX_STREAM_MS);
      heartbeat.unref();
      lifetime.unref();

      this.read(userId, orderId).then(
        (order) => send(order.status),
        (error: Error) => subscriber.error(error),
      );

      // Runs when the stream completes, fails, or the browser disconnects
      return () => {
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unwatch();
      };
    });
  }

  private read(userId: string, orderId: string): Promise<Order> {
    return this.queryBus.execute<GetOrderQuery, Order>(
      new GetOrderQuery(userId, orderId),
    );
  }
}
