import type { PaginatedResult } from '@/core/index.js';
import type { Order } from '../entities/order.entity.js';
import type { OutboxEventDraft } from '../events/order-events.js';
import type { OrderListFilters, OrderStatusCounts } from '../order-filters.js';
import type { OrderStatus } from '../order-status.js';

/** Thrown by `create` when an order with this id, or this user and key, already exists. */
export class OrderAlreadyExistsError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} already exists`);
    this.name = 'OrderAlreadyExistsError';
  }
}

export interface TransitionOptions {
  /** Also set the "stock still to put back" flag in the same step (cancelling a paid order). */
  stockReturnPending?: boolean;
  /** Also set the new time to pay, in the same step (an order that starts being paid). */
  expiresAt?: Date;
}

/**
 * Orders in Postgres. Everything that writes is ONE short transaction that touches Postgres and
 * nothing else (no Redis, no RabbitMQ, no other module), so a connection is held only for a few
 * statements even when hundreds of orders arrive together.
 */
export interface IOrderRepository {
  findById(orderId: string): Promise<Order | null>;

  /** Only an order of this user; someone else's order is the same as no order. */
  findByIdForUser(userId: string, orderId: string): Promise<Order | null>;

  /**
   * The user's orders, newest first, narrowed by `filters` (all that are given must hold; only
   * ever this user's orders). `cursor` is the id of the last order of the previous page and must
   * be an order of this user (otherwise `null` is returned for the page, see below); it is only a
   * position, so the filters may differ from one page to the next.
   */
  listByUser(
    userId: string,
    limit: number,
    cursor?: string,
    filters?: OrderListFilters,
  ): Promise<PaginatedResult<Order> | null>;

  /**
   * How many of the user's orders are in each status. `filters.statuses` is ignored (the point is
   * to count every status); the dates and the code narrow what is counted.
   */
  countByStatus(
    userId: string,
    filters?: OrderListFilters,
  ): Promise<OrderStatusCounts>;

  /**
   * Writes the order, its items and its event in one transaction: all three or none. Throws
   * `OrderAlreadyExistsError` when the id (or the user and key) is taken.
   */
  create(order: Order, event: OutboxEventDraft): Promise<void>;

  /**
   * Moves the order from one status to another and writes the event, in one transaction. The
   * move is conditional on the order still being in `from`, so when two moves reach the same order
   * together one of them finds nothing to change. Returns the order as it is now, or null when it
   * was no longer in `from` (or does not exist).
   */
  transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    event: OutboxEventDraft,
    options?: TransitionOptions,
  ): Promise<Order | null>;

  /** Online orders still PENDING and past their expiry (database clock), oldest first. */
  findDueOnlineIds(limit: number): Promise<string[]>;

  /**
   * Online orders in PAYMENT_PROCESSING that were last changed more than this many seconds ago
   * (database clock), oldest first. The payment module looks at them to find the ones whose
   * payment never got written.
   */
  findStuckPaymentOrderIds(
    olderThanSeconds: number,
    limit: number,
  ): Promise<string[]>;

  /** Cash on delivery orders still PENDING that were created more than this many seconds ago. */
  findPendingCodIds(olderThanSeconds: number, limit: number): Promise<string[]>;

  /** Cancelled orders whose stock is still to be put back, last changed more than this long ago. */
  findStockReturnPendingIds(
    olderThanSeconds: number,
    limit: number,
  ): Promise<string[]>;

  /** The stock of this order is back: clear the flag. */
  clearStockReturnPending(orderId: string): Promise<void>;
}
