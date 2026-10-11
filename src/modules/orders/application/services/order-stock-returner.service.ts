import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { DomainException, InventoryErrorCodes } from '@/core/index.js';
import { ReturnReservationCommand } from '../../../inventory/application/index.js';
import type { IOrderRepository } from '../../domain/index.js';

/**
 * Puts the stock of a cancelled order back in the warehouse (it was taken out when the order was
 * confirmed) and then takes the "stock still to put back" flag off the order. The order was
 * changed FIRST (the flag was set in the same step as the cancel), so a crash anywhere in here
 * leaves the flag on and the sweep calls this again. Putting stock back twice is impossible:
 * inventory finds nothing left to return the second time.
 *
 * Throws when inventory cannot be reached, with the flag still on.
 */
@Injectable()
export class OrderStockReturner {
  private readonly logger = new Logger(OrderStockReturner.name);

  constructor(
    @Inject('IOrderRepository') private readonly orders: IOrderRepository,
    private readonly commandBus: CommandBus,
  ) {}

  async putBack(orderId: string): Promise<void> {
    try {
      await this.commandBus.execute(new ReturnReservationCommand(orderId));
    } catch (error) {
      if (!this.hasNothingToReturn(error)) throw error;
      // The stock was never taken out (or there is no record of it): there is nothing to wait for
      this.logger.warn(
        `Order ${orderId}: nothing to put back (${(error as DomainException).code}); clearing the flag`,
      );
    }
    await this.orders.clearStockReturnPending(orderId);
  }

  private hasNothingToReturn(error: unknown): boolean {
    return (
      error instanceof DomainException &&
      (error.code === InventoryErrorCodes.RESERVATION_NOT_CONFIRMED.code ||
        error.code === InventoryErrorCodes.RESERVATION_NOT_FOUND.code)
    );
  }
}
