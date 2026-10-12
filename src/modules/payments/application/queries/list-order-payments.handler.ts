import { IQueryHandler, QueryBus, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetOrderQuery } from '../../../orders/application/index.js';
import type { Payment, IPaymentRepository } from '../../domain/index.js';
import { ListOrderPaymentsQuery } from './list-order-payments.query.js';

@QueryHandler(ListOrderPaymentsQuery)
export class ListOrderPaymentsHandler implements IQueryHandler<
  ListOrderPaymentsQuery,
  Payment[]
> {
  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    private readonly queryBus: QueryBus,
  ) {}

  async execute({
    userId,
    orderId,
  }: ListOrderPaymentsQuery): Promise<Payment[]> {
    // The order comes first: somebody else's order, or none, is a 404 (ORD-002) before anything else
    await this.queryBus.execute(new GetOrderQuery(userId, orderId));
    return this.payments.listByOrder(orderId);
  }
}
