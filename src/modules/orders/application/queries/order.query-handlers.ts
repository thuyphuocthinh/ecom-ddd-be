import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { OrderErrorCodes, type PaginatedResult } from '@/core/index.js';
import {
  ALL_ORDER_STATUSES,
  OrderDomainException,
  isValidOrderCode,
  type IOrderRepository,
  type Order,
  type OrderListFilters,
  type OrderStatusCounts,
} from '../../domain/index.js';
import {
  CountOrdersByStatusQuery,
  FindStuckPaymentOrdersQuery,
  GetOrderByIdQuery,
  GetOrderQuery,
  ListOrdersQuery,
} from './order.queries.js';

export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 50;

const refuse = (reason: string): never => {
  throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, { reason });
};

/**
 * The filters are checked at the door (the DTO) and again here, so a caller that is not the
 * controller cannot slip a bad value into a query.
 */
function checkFilters(filters: OrderListFilters): void {
  const { statuses, createdFrom, createdTo, code } = filters;
  if (statuses !== undefined) {
    if (
      statuses.length === 0 ||
      statuses.length > ALL_ORDER_STATUSES.length ||
      statuses.some((status) => !ALL_ORDER_STATUSES.includes(status))
    ) {
      refuse('status must be a list of known order statuses');
    }
  }
  for (const [name, value] of [
    ['createdFrom', createdFrom],
    ['createdTo', createdTo],
  ] as const) {
    if (value !== undefined && Number.isNaN(value.getTime())) {
      refuse(`${name} is not a valid time`);
    }
  }
  if (createdFrom && createdTo && createdFrom > createdTo) {
    refuse('createdFrom must not be after createdTo');
  }
  if (code !== undefined && !isValidOrderCode(code)) {
    refuse('q must be 6 to 36 characters from 0-9, a-f and -');
  }
}

@QueryHandler(GetOrderQuery)
export class GetOrderHandler implements IQueryHandler<GetOrderQuery, Order> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  async execute({ userId, orderId }: GetOrderQuery): Promise<Order> {
    const order = await this.orders.findByIdForUser(userId, orderId);
    // The same answer for an order of another user as for one that does not exist
    if (!order) throw new OrderDomainException(OrderErrorCodes.NOT_FOUND);
    return order;
  }
}

@QueryHandler(ListOrdersQuery)
export class ListOrdersHandler implements IQueryHandler<
  ListOrdersQuery,
  PaginatedResult<Order>
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  async execute({
    userId,
    limit,
    cursor,
    filters,
  }: ListOrdersQuery): Promise<PaginatedResult<Order>> {
    if (
      !Number.isInteger(limit) ||
      limit < MIN_PAGE_SIZE ||
      limit > MAX_PAGE_SIZE
    ) {
      throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, {
        reason: `limit must be a whole number from ${MIN_PAGE_SIZE} to ${MAX_PAGE_SIZE}`,
      });
    }
    checkFilters(filters);
    const page = await this.orders.listByUser(userId, limit, cursor, filters);
    // A cursor that is not one of this user's orders: refused, never answered with someone else's data
    if (!page) {
      throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, {
        reason: 'Invalid cursor',
      });
    }
    return page;
  }
}

@QueryHandler(CountOrdersByStatusQuery)
export class CountOrdersByStatusHandler implements IQueryHandler<
  CountOrdersByStatusQuery,
  OrderStatusCounts
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  execute({
    userId,
    filters,
  }: CountOrdersByStatusQuery): Promise<OrderStatusCounts> {
    if (filters.statuses !== undefined) {
      refuse('status cannot be used to count orders by status');
    }
    checkFilters(filters);
    return this.orders.countByStatus(userId, filters);
  }
}

@QueryHandler(FindStuckPaymentOrdersQuery)
export class FindStuckPaymentOrdersHandler implements IQueryHandler<
  FindStuckPaymentOrdersQuery,
  string[]
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  execute({
    olderThanSeconds,
    limit,
  }: FindStuckPaymentOrdersQuery): Promise<string[]> {
    if (
      !Number.isInteger(olderThanSeconds) ||
      olderThanSeconds < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, {
        reason:
          'A whole number of seconds and a limit from 1 to 1000 are needed',
      });
    }
    return this.orders.findStuckPaymentOrderIds(olderThanSeconds, limit);
  }
}

@QueryHandler(GetOrderByIdQuery)
export class GetOrderByIdHandler implements IQueryHandler<
  GetOrderByIdQuery,
  Order
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  async execute({ orderId }: GetOrderByIdQuery): Promise<Order> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new OrderDomainException(OrderErrorCodes.NOT_FOUND);
    return order;
  }
}
