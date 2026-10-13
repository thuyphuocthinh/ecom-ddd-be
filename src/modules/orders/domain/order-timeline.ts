import { OrderStatus } from './order-status.js';

/**
 * When the order reached each status, by the database clock. A time is written in the same UPDATE
 * that moves the status, so it can never disagree with the status. Empty (`null`) until it
 * happens, and for orders that are older than these columns.
 */
export interface OrderTimeline {
  confirmedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  expiredAt: Date | null;
}

export const emptyTimeline = (): OrderTimeline => ({
  confirmedAt: null,
  shippedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  expiredAt: null,
});

/**
 * The column that records the time of a move TO each status. A fixed table, so the name of a
 * column in SQL never comes from anything a user sent. Statuses that are not listed (PENDING,
 * PAYMENT_PROCESSING) record no time.
 */
export const TIMELINE_COLUMN: Readonly<
  Partial<Record<OrderStatus, keyof OrderTimeline>>
> = {
  [OrderStatus.CONFIRMED]: 'confirmedAt',
  [OrderStatus.SHIPPING]: 'shippedAt',
  [OrderStatus.DELIVERED]: 'deliveredAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
  [OrderStatus.EXPIRED]: 'expiredAt',
};
