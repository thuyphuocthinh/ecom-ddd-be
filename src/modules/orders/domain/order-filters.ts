import { OrderStatus } from './order-status.js';

/** Every status, in the order the customer meets them. */
export const ALL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAYMENT_PROCESSING,
  OrderStatus.CONFIRMED,
  OrderStatus.SHIPPING,
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.EXPIRED,
];

/** The code a customer sees is the first 8 characters of the id, and a search needs at least 6. */
export const MIN_ORDER_CODE_LENGTH = 6;
export const MAX_ORDER_CODE_LENGTH = 36;
const CODE_PATTERN = /^[0-9a-f-]+$/;

/** Narrows a list of the customer's orders. Every part is optional; all that are given must hold. */
export interface OrderListFilters {
  /** The order is in one of these statuses. */
  statuses?: readonly OrderStatus[];
  /** The order was placed at or after this moment. */
  createdFrom?: Date;
  /** The order was placed at or before this moment. */
  createdTo?: Date;
  /** The id of the order starts with this (lower case). */
  code?: string;
}

export const isValidOrderCode = (code: unknown): code is string =>
  typeof code === 'string' &&
  code.length >= MIN_ORDER_CODE_LENGTH &&
  code.length <= MAX_ORDER_CODE_LENGTH &&
  CODE_PATTERN.test(code);

/** The number of orders in each status. Every status is there, 0 when there are none. */
export type OrderStatusCounts = Record<OrderStatus, number>;
