import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { DomainException, OrderErrorCodes } from '@/core/index.js';
import { ReleaseReservationCommand } from '../../../inventory/application/index.js';
import {
  OrderStatus,
  orderStatusChangedEvent,
  type IOrderRepository,
} from '../../domain/index.js';
import { OrderStockReturner } from '../services/order-stock-returner.service.js';
import { SWEEP_GRACE_SECONDS, sweepInBatches } from '../sweep.js';
import {
  ExpireDueOrdersCommand,
  FinishPendingCodOrdersCommand,
  ReturnStockForCancelledOrdersCommand,
} from './sweep-commands.js';
import type { ConfirmOrderResult } from './confirm-order.handler.js';
import { ConfirmOrderCommand } from './confirm-order.command.js';

/**
 * Online orders that were not paid in time. Whether an order is due is judged by the DATABASE
 * clock. The change is the same conditional update as every other change of status: an order that
 * was paid or cancelled a moment ago is simply not touched. Returns how many it expired.
 */
@CommandHandler(ExpireDueOrdersCommand)
export class ExpireDueOrdersHandler implements ICommandHandler<
  ExpireDueOrdersCommand,
  number
> {
  private readonly logger = new Logger(ExpireDueOrdersHandler.name);

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly commandBus: CommandBus,
  ) {}

  execute(): Promise<number> {
    return sweepInBatches(
      (limit) => this.orders.findDueOnlineIds(limit),
      (orderId) => this.expire(orderId),
      (orderId, error) =>
        this.logger.error(
          `Could not expire order ${orderId}: ${error.message}`,
        ),
    );
  }

  private async expire(orderId: string): Promise<boolean> {
    const order = await this.orders.findById(orderId);
    if (!order || order.status !== OrderStatus.PENDING) return false;
    const expired = await this.orders.transition(
      orderId,
      OrderStatus.PENDING,
      OrderStatus.EXPIRED,
      orderStatusChangedEvent(order, OrderStatus.PENDING, OrderStatus.EXPIRED),
    );
    if (!expired) return false;
    try {
      await this.commandBus.execute(new ReleaseReservationCommand(orderId));
    } catch (error) {
      // The hold expires by itself, and inventory has its own sweep for that
      this.logger.error(
        `Order ${orderId} expired but its held stock could not be given back: ${(error as Error).message}`,
      );
    }
    return true;
  }
}

/**
 * Cash-on-delivery orders left PENDING: the request that placed them died, or the confirm failed,
 * before they were confirmed. Confirming again is safe to repeat. If the held stock was given back
 * in the meantime there is nothing left to confirm, so the order expires (the customer is told by
 * the event). Orders younger than a grace period are left to the request that is still working.
 * Returns how many it finished (confirmed or expired).
 */
@CommandHandler(FinishPendingCodOrdersCommand)
export class FinishPendingCodOrdersHandler implements ICommandHandler<
  FinishPendingCodOrdersCommand,
  number
> {
  private readonly logger = new Logger(FinishPendingCodOrdersHandler.name);

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly commandBus: CommandBus,
  ) {}

  execute(): Promise<number> {
    return sweepInBatches(
      (limit) => this.orders.findPendingCodIds(SWEEP_GRACE_SECONDS, limit),
      (orderId) => this.finish(orderId),
      (orderId, error) =>
        this.logger.error(
          `Could not finish cash-on-delivery order ${orderId}: ${error.message}`,
        ),
    );
  }

  private async finish(orderId: string): Promise<boolean> {
    let result: ConfirmOrderResult;
    try {
      result = await this.commandBus.execute(new ConfirmOrderCommand(orderId));
    } catch (error) {
      // Cancelled or changed by somebody else just now: nothing left for us to finish
      if (
        error instanceof DomainException &&
        error.code === OrderErrorCodes.INVALID_STATE_TRANSITION.code
      ) {
        return false;
      }
      throw error;
    }
    if (result.kind === 'CONFIRMED') return true;

    const order = await this.orders.findById(orderId);
    if (!order) return false;
    const expired = await this.orders.transition(
      orderId,
      OrderStatus.PENDING,
      OrderStatus.EXPIRED,
      orderStatusChangedEvent(order, OrderStatus.PENDING, OrderStatus.EXPIRED),
    );
    return expired !== null;
  }
}

/**
 * Cancelled orders whose stock is still to be put back: the cancel changed the order but the
 * request died, or inventory was out of reach, before the stock was put back. Returns how many
 * orders it put back.
 */
@CommandHandler(ReturnStockForCancelledOrdersCommand)
export class ReturnStockForCancelledOrdersHandler implements ICommandHandler<
  ReturnStockForCancelledOrdersCommand,
  number
> {
  private readonly logger = new Logger(
    ReturnStockForCancelledOrdersHandler.name,
  );

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly returner: OrderStockReturner,
  ) {}

  execute(): Promise<number> {
    return sweepInBatches(
      (limit) =>
        this.orders.findStockReturnPendingIds(SWEEP_GRACE_SECONDS, limit),
      async (orderId) => {
        await this.returner.putBack(orderId);
        return true;
      },
      (orderId, error) =>
        this.logger.error(
          `Could not put back the stock of order ${orderId}: ${error.message}`,
        ),
    );
  }
}
