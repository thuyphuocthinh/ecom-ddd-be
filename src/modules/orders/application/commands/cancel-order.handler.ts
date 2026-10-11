import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { OrderErrorCodes } from '@/core/index.js';
import { ReleaseReservationCommand } from '../../../inventory/application/index.js';
import {
  OrderDomainException,
  OrderStatus,
  orderStatusChangedEvent,
  type IOrderRepository,
  type Order,
} from '../../domain/index.js';
import { OrderStockReturner } from '../services/order-stock-returner.service.js';
import { CancelOrderCommand } from './cancel-order.command.js';

/**
 * The order is changed FIRST, the stock is dealt with SECOND, and a crash in between only ever
 * leaves goods in the warehouse that are not on sale for a while, never goods sold twice:
 *
 *  - PENDING: the stock is only held, so the hold is given back. If that fails, the hold expires
 *    by itself.
 *  - CONFIRMED: the stock already left the warehouse, so it must be put back, and nothing does
 *    that by itself. The cancel therefore also sets the `stockReturnPending` flag in the same step
 *    (one transaction), and the sweep puts the stock back if this request dies before it does.
 *    Putting the stock back FIRST would leave a moment where the stock is back on sale but the
 *    order is still CONFIRMED and can be shipped.
 *
 * When a cancel and a shipment (or an expiry) reach the order together, the one conditional
 * update lets exactly one through; the other gets ORD-006.
 */
@CommandHandler(CancelOrderCommand)
export class CancelOrderHandler implements ICommandHandler<
  CancelOrderCommand,
  Order
> {
  private readonly logger = new Logger(CancelOrderHandler.name);

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly returner: OrderStockReturner,
    private readonly commandBus: CommandBus,
  ) {}

  async execute({ userId, orderId }: CancelOrderCommand): Promise<Order> {
    // Somebody else's order is the same answer as no order
    const order = await this.orders.findByIdForUser(userId, orderId);
    if (!order) throw new OrderDomainException(OrderErrorCodes.NOT_FOUND);
    if (!order.canMoveTo(OrderStatus.CANCELLED)) {
      throw new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
    }

    const from = order.status;
    const needsStockBack = from === OrderStatus.CONFIRMED;
    const cancelled = await this.orders.transition(
      orderId,
      from,
      OrderStatus.CANCELLED,
      orderStatusChangedEvent(order, from, OrderStatus.CANCELLED),
      needsStockBack ? { stockReturnPending: true } : undefined,
    );
    if (!cancelled) {
      // The order moved under us (shipped, expired, cancelled by another request)
      throw new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
    }

    if (!needsStockBack) {
      await this.giveBackHold(orderId);
      return cancelled;
    }
    return this.putStockBack(orderId, cancelled);
  }

  /** Never throws: the order is cancelled, and an unreleased hold expires by itself. */
  private async giveBackHold(orderId: string): Promise<void> {
    try {
      await this.commandBus.execute(new ReleaseReservationCommand(orderId));
    } catch (error) {
      this.logger.error(
        `Order ${orderId} is cancelled but its held stock could not be given back (it expires by itself): ${(error as Error).message}`,
      );
    }
  }

  /** Never throws: the order is cancelled, and the flag makes the sweep put the stock back. */
  private async putStockBack(
    orderId: string,
    cancelled: Order,
  ): Promise<Order> {
    try {
      await this.returner.putBack(orderId);
    } catch (error) {
      this.logger.error(
        `Order ${orderId} is cancelled but its stock could not be put back yet (the sweep will): ${(error as Error).message}`,
      );
      return cancelled;
    }
    return (await this.orders.findById(orderId)) ?? cancelled;
  }
}
