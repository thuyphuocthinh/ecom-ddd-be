import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { OrderErrorCodes } from '@/core/index.js';
import {
  OrderDomainException,
  OrderStatus,
  orderStatusChangedEvent,
  type IOrderRepository,
  type Order,
} from '../../domain/index.js';
import { DeliverOrderCommand, ShipOrderCommand } from './shipping-commands.js';

/**
 * One step of the (simulated) delivery. The check on the current status is only there to answer
 * early; the real guard is the conditional update inside `transition`, so when this meets a
 * cancel (or a second copy of itself) at the same moment, exactly one of them changes the order
 * and the other one gets ORD-006.
 */
async function move(
  orders: IOrderRepository,
  orderId: string,
  to: OrderStatus,
): Promise<Order> {
  const order = await orders.findById(orderId);
  if (!order) throw new OrderDomainException(OrderErrorCodes.NOT_FOUND);
  if (!order.canMoveTo(to)) {
    throw new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
  }
  const moved = await orders.transition(
    orderId,
    order.status,
    to,
    orderStatusChangedEvent(order, order.status, to),
  );
  if (!moved) {
    throw new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
  }
  return moved;
}

@CommandHandler(ShipOrderCommand)
export class ShipOrderHandler implements ICommandHandler<
  ShipOrderCommand,
  Order
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  execute({ orderId }: ShipOrderCommand): Promise<Order> {
    return move(this.orders, orderId, OrderStatus.SHIPPING);
  }
}

@CommandHandler(DeliverOrderCommand)
export class DeliverOrderHandler implements ICommandHandler<
  DeliverOrderCommand,
  Order
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  execute({ orderId }: DeliverOrderCommand): Promise<Order> {
    return move(this.orders, orderId, OrderStatus.DELIVERED);
  }
}
