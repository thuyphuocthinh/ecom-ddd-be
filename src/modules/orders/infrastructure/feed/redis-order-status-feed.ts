import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import {
  isOrderStatus,
  type IOrderStatusFeed,
  type OrderStatusListener,
  type OrderStatusUpdate,
} from '../../domain/index.js';
import { LocalWatchers } from './local-watchers.js';

export const ORDER_STATUS_CHANNEL = 'order-status';

/** The update inside a Redis message, or null when the message is not one (never throws). */
export function parseUpdate(message: string): OrderStatusUpdate | null {
  try {
    const body = JSON.parse(message) as Record<string, unknown> | null;
    if (
      body &&
      typeof body.orderId === 'string' &&
      body.orderId !== '' &&
      isOrderStatus(body.status)
    ) {
      return { orderId: body.orderId, status: body.status };
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Redis pub/sub between the copies of the application. A message published by any copy reaches the
 * listeners of every copy; each copy then gives it to its own listeners for that order.
 *
 * Redis needs a connection of its own for listening (a connection that subscribes can do nothing
 * else), so it is a duplicate of the shared one.
 *
 * The feed is an extra, not a need: the application starts and works when Redis is not there yet.
 * It subscribes each time the connection is ready, so it also recovers after Redis comes back.
 * Meanwhile a client simply does not get pushed messages (it asks now and then instead).
 */
@Injectable()
export class RedisOrderStatusFeed
  implements IOrderStatusFeed, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisOrderStatusFeed.name);
  private readonly watchers = new LocalWatchers();
  private subscriber: Redis | undefined;
  private markSubscribed: () => void = () => undefined;

  /** Resolves when the first subscription is in place (tests wait for it; the application does not). */
  readonly subscribed = new Promise<void>((resolve) => {
    this.markSubscribed = resolve;
  });

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    const subscriber = this.redis.getClient().duplicate();
    this.subscriber = subscriber;

    subscriber.on('message', (_channel, message) => {
      const update = parseUpdate(message);
      if (update) this.watchers.dispatch(update);
    });
    subscriber.on('error', (error: Error) =>
      this.logger.warn(`Order status feed connection: ${error.message}`),
    );
    subscriber.on('ready', () => {
      subscriber.subscribe(ORDER_STATUS_CHANNEL).then(
        () => this.markSubscribed(),
        (error: Error) =>
          this.logger.warn(
            `Order status feed could not subscribe: ${error.message}`,
          ),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
    this.subscriber = undefined;
  }

  async publish(update: OrderStatusUpdate): Promise<void> {
    await this.redis
      .getClient()
      .publish(ORDER_STATUS_CHANNEL, JSON.stringify(update));
  }

  watch(orderId: string, listener: OrderStatusListener): () => void {
    return this.watchers.add(orderId, listener);
  }
}
