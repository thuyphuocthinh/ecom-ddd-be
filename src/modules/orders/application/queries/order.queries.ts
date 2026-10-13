import { IQuery } from '@nestjs/cqrs';
import type { OrderListFilters } from '../../domain/index.js';

/** One order of this user. Somebody else's order is the same as no order. */
export class GetOrderQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly orderId: string,
  ) {}
}

/**
 * The orders of this user, newest first, narrowed by `filters` (a status, a time range, the start of
 * the id). `cursor` is the id of the last order of the previous page.
 */
export class ListOrdersQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly limit: number,
    public readonly cursor?: string,
    public readonly filters: OrderListFilters = {},
  ) {}
}

/**
 * How many of this user's orders are in each status, for the tabs of "my orders". The time range
 * and the start of the id narrow what is counted; a status filter has no meaning here.
 */
export class CountOrdersByStatusQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly filters: OrderListFilters = {},
  ) {}
}

/**
 * Online orders that have been in PAYMENT_PROCESSING for more than this many seconds (the ids,
 * oldest first), for the payment module to find the ones whose payment never got written.
 */
export class FindStuckPaymentOrdersQuery implements IQuery {
  constructor(
    public readonly olderThanSeconds: number,
    public readonly limit: number,
  ) {}
}

/**
 * One order by its id, whoever it belongs to. For other modules of the system that act on an order
 * after something happened to it (the payment module, when money comes in); never for an endpoint
 * a customer reaches, which uses `GetOrderQuery` and so can only see its own orders.
 */
export class GetOrderByIdQuery implements IQuery {
  constructor(public readonly orderId: string) {}
}
