import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import {
  OrderStatus,
  type IOrderRepository,
  type Order,
} from '../../domain/index.js';
import { moveOrder } from '../order-move.js';
import { DeliverOrderCommand, ShipOrderCommand } from './shipping-commands.js';

@CommandHandler(ShipOrderCommand)
export class ShipOrderHandler implements ICommandHandler<
  ShipOrderCommand,
  Order
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  execute({ orderId }: ShipOrderCommand): Promise<Order> {
    return moveOrder(this.orders, orderId, OrderStatus.SHIPPING);
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
    return moveOrder(this.orders, orderId, OrderStatus.DELIVERED);
  }
}
