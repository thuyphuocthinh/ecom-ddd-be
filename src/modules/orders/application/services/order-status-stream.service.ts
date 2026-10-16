import { Inject, Injectable } from '@nestjs/common';
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

/** What a stream says: the order is in this status, or "still here" to keep the connection alive. */
export type OrderStreamMessage =
  { kind: 'status'; orderId: string; status: OrderStatus } | { kind: 'ping' };

/** A message to keep the connection alive: proxies and browsers close a stream that stays silent. */
export const HEARTBEAT_MS = 20_000;
/** The longest one stream stays open; the browser opens a new one and gets the current status first. */
export const MAX_STREAM_MS = 30 * 60_000;

/**
 * The messages about one order, for a client that keeps a connection open (server-sent events). How
 * a message is written on the wire is the controller's business; this only decides what to say.
 *
 * - Somebody else's order (or none) is refused up front with the same error as reading it (ORD-002),
 *   before anything is registered or any connection is kept.
 * - It starts to listen first and reads the current status after, so a change in between is not lost.
 *   A message can still arrive older than the first read: a reader takes a message as "reload the
 *   order", never as the data itself.
 * - It ends by itself when the order reaches a final status, after `MAX_STREAM_MS`, or when the
 *   client goes away; in every case the listener and the timers are removed.
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
  ): Promise<Observable<OrderStreamMessage>> {
    await this.read(userId, orderId); // refuses an order that is not the user's

    return new Observable<OrderStreamMessage>((subscriber) => {
      const say = (status: OrderStatus): void => {
        subscriber.next({ kind: 'status', orderId, status });
        if (FINAL_STATUSES.includes(status)) subscriber.complete();
      };

      const unwatch = this.feed.watch(orderId, (update) => say(update.status));
      const heartbeat = setInterval(
        () => subscriber.next({ kind: 'ping' }),
        HEARTBEAT_MS,
      );
      const lifetime = setTimeout(() => subscriber.complete(), MAX_STREAM_MS);
      heartbeat.unref();
      lifetime.unref();

      this.read(userId, orderId).then(
        (order) => say(order.status),
        (error: Error) => subscriber.error(error),
      );

      // Runs when the stream completes, fails, or the client disconnects
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
