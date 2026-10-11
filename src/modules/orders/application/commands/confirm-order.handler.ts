import { CommandHandler, CommandBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import {
  DomainException,
  InventoryErrorCodes,
  OrderErrorCodes,
} from '@/core/index.js';
import {
  ConfirmReservationCommand,
  ReturnReservationCommand,
} from '../../../inventory/application/index.js';
import {
  OrderDomainException,
  OrderStatus,
  orderStatusChangedEvent,
  type IOrderRepository,
  type Order,
} from '../../domain/index.js';
import { ConfirmOrderCommand } from './confirm-order.command.js';

export type ConfirmOrderResult =
  | { kind: 'CONFIRMED'; order: Order }
  /** The stock held for this order was already given back: it cannot be confirmed any more. */
  | { kind: 'HOLD_LOST' };

/**
 * The stock is taken out of the warehouse FIRST, the order is moved to CONFIRMED SECOND. Taking
 * the stock out is safe to repeat, so a crash between the two leaves an order that is still
 * PENDING and can simply be confirmed again. The other way round could leave a CONFIRMED order
 * whose stock was given back, which is a sale of goods that are not there.
 *
 * Confirming twice is fine: an order that is already CONFIRMED is answered as confirmed.
 */
@CommandHandler(ConfirmOrderCommand)
export class ConfirmOrderHandler implements ICommandHandler<
  ConfirmOrderCommand,
  ConfirmOrderResult
> {
  private readonly logger = new Logger(ConfirmOrderHandler.name);

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly commandBus: CommandBus,
  ) {}

  async execute({ orderId }: ConfirmOrderCommand): Promise<ConfirmOrderResult> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new OrderDomainException(OrderErrorCodes.NOT_FOUND);
    if (order.status === OrderStatus.CONFIRMED) {
      return { kind: 'CONFIRMED', order };
    }
    if (!order.canMoveTo(OrderStatus.CONFIRMED)) {
      throw new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
    }

    try {
      await this.commandBus.execute(new ConfirmReservationCommand(orderId));
    } catch (error) {
      if (
        error instanceof DomainException &&
        error.code === InventoryErrorCodes.RESERVATION_RELEASED.code
      ) {
        return { kind: 'HOLD_LOST' };
      }
      throw error;
    }

    const confirmed = await this.orders.transition(
      orderId,
      order.status,
      OrderStatus.CONFIRMED,
      orderStatusChangedEvent(order, order.status, OrderStatus.CONFIRMED),
    );
    if (confirmed) return { kind: 'CONFIRMED', order: confirmed };

    // Somebody else moved the order first. If it was a second confirm, we are done.
    const now = await this.orders.findById(orderId);
    if (now?.status === OrderStatus.CONFIRMED) {
      return { kind: 'CONFIRMED', order: now };
    }
    // It was cancelled or expired just after we took the stock out: put the stock back, or it
    // would be gone for an order that will never be delivered
    await this.putStockBack(orderId);
    throw new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
  }

  private async putStockBack(orderId: string): Promise<void> {
    try {
      await this.commandBus.execute(new ReturnReservationCommand(orderId));
    } catch (error) {
      this.logger.error(
        `Order ${orderId} was closed while it was being confirmed and its stock could not be put back: ${(error as Error).message}`,
      );
    }
  }
}
