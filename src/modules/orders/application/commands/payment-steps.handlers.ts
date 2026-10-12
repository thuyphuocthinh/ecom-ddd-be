import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { OrderErrorCodes } from '@/core/index.js';
import { ReleaseReservationCommand } from '../../../inventory/application/index.js';
import {
  OrderDomainException,
  OrderStatus,
  type IOrderRepository,
  type Order,
} from '../../domain/index.js';
import { moveOrder } from '../order-move.js';
import {
  ExpireOrderCommand,
  ReopenOrderCommand,
  StartOrderPaymentCommand,
} from './payment-steps.commands.js';

/**
 * The steps of an online payment that change the order. The payment module calls them through the
 * command bus; each is the same conditional update as every other change of status (one wins when
 * several reach the order together) and writes its `order.status_changed` event in the same
 * transaction.
 */
@CommandHandler(StartOrderPaymentCommand)
export class StartOrderPaymentHandler implements ICommandHandler<
  StartOrderPaymentCommand,
  Order
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  execute({ orderId, expiresAt }: StartOrderPaymentCommand): Promise<Order> {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new OrderDomainException(OrderErrorCodes.DOMAIN_EXCEPTION, {
        reason: 'The time to pay is not a valid time',
      });
    }
    return moveOrder(this.orders, orderId, OrderStatus.PAYMENT_PROCESSING, {
      expiresAt,
    });
  }
}

@CommandHandler(ReopenOrderCommand)
export class ReopenOrderHandler implements ICommandHandler<
  ReopenOrderCommand,
  Order
> {
  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
  ) {}

  execute({ orderId }: ReopenOrderCommand): Promise<Order> {
    return moveOrder(this.orders, orderId, OrderStatus.PENDING);
  }
}

/** The order is changed FIRST and the stock given back SECOND, as everywhere else. */
@CommandHandler(ExpireOrderCommand)
export class ExpireOrderHandler implements ICommandHandler<
  ExpireOrderCommand,
  Order
> {
  private readonly logger = new Logger(ExpireOrderHandler.name);

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly commandBus: CommandBus,
  ) {}

  async execute({ orderId }: ExpireOrderCommand): Promise<Order> {
    const expired = await moveOrder(this.orders, orderId, OrderStatus.EXPIRED);
    try {
      await this.commandBus.execute(new ReleaseReservationCommand(orderId));
    } catch (error) {
      // The hold runs out by itself, and inventory has its own sweep for that
      this.logger.error(
        `Order ${orderId} expired but its held stock could not be given back: ${(error as Error).message}`,
      );
    }
    return expired;
  }
}
