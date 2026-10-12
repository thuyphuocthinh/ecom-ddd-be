import { OrderErrorCodes } from '@/core/index.js';
import {
  OrderDomainException,
  OrderStatus,
  orderStatusChangedEvent,
  type IOrderRepository,
  type Order,
  type TransitionOptions,
} from '../domain/index.js';

/**
 * One step of an order's life, for the commands that move an order and do nothing else. The check
 * on the current status is only there to answer early; the real guard is the conditional update
 * inside `transition`, so when this meets another change of the same order (a cancel, a shipment,
 * a second copy of itself) exactly one of them changes the order and the other one gets ORD-006.
 * ORD-002 when there is no such order.
 */
export async function moveOrder(
  orders: IOrderRepository,
  orderId: string,
  to: OrderStatus,
  options?: TransitionOptions,
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
    options,
  );
  if (!moved) {
    throw new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
  }
  return moved;
}
