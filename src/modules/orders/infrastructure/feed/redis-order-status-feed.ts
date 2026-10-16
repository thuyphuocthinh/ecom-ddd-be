import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '@/core/index.js';
import {
  OrderStatus,
  type IOrderStatusFeed,
  type OrderStatusListener,
  type OrderStatusUpdate,
} from '../../domain/index.js';
import { LocalWatchers } from './local-watchers.js';

export const ORDER_STATUS_CHANNEL = 'order-status';

const STATUSES = new Set<string>(Object.values(OrderStatus));

/** The update inside a Redis message, or null when the message is not one (never throws). */
export function parseUpdate(message: string): OrderStatusUpdate | null {
  try {
    const body = JSON.parse(message) as Record<string, unknown> | null;
    if (
      body &&
      typeof body.orderId === 'string' &&
      body.orderId !== '' &&
      typeof body.status === 'string' &&
      STATUSES.has(body.status)
    ) {
      return { orderId: body.orderId, status: body.status as OrderStatus };
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
 * else), so it is a duplicate of the shared one. It resubscribes by itself after a reconnection.
 */
@Injectable()
export class RedisOrderStatusFeed
  implements IOrderStatusFeed, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisOrderStatusFeed.name);
  private readonly watchers = new LocalWatchers();
  private subscriber: Redis | undefined;

  constructor(private readonly redis: RedisService) {}

  async onModuleInit(): Promise<void> {
    const subscriber = this.redis.getClient().duplicate();
    this.subscriber = subscriber;
    subscriber.on('message', (_channel, message) => {
      const update = parseUpdate(message);
      if (update) this.watchers.dispatch(update);
    });
    subscriber.on('error', (error: Error) =>
      this.logger.warn(`Order status feed connection: ${error.message}`),
    );
    await subscriber.subscribe(ORDER_STATUS_CHANNEL);
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
