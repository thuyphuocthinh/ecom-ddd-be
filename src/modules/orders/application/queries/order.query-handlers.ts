import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { OrderErrorCodes, type PaginatedResult } from '@/core/index.js';
import {
  OrderDomainException,
  type IOrderRepository,
  type Order,
} from '../../domain/index.js';
import { GetOrderQuery, ListOrdersQuery } from './order.queries.js';

export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 50;

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
    const page = await this.orders.listByUser(userId, limit, cursor);
    // A cursor that is not one of this user's orders: refused, never answered with someone else's data
    if (!page) {
      throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, {
        reason: 'Invalid cursor',
      });
    }
    return page;
  }
}
