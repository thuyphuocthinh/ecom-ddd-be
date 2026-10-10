import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { InventoryErrorCodes } from '@/core/index.js';
import {
  InventoryDomainException,
  type IReservationRepository,
} from '../../domain/index.js';
import { ConfirmReservationCommand } from './confirm-reservation.command.js';

/**
 * The order was paid. Moves RESERVED to CONFIRMED and takes the units out of the warehouse stock
 * in one transaction. Doing it twice is fine; doing it for an order whose hold was already given
 * back is refused. Redis is not touched: `available` is the same before and after (the units
 * stop being "held" and start being "gone").
 */
@CommandHandler(ConfirmReservationCommand)
export class ConfirmReservationHandler implements ICommandHandler<ConfirmReservationCommand> {
  constructor(
    @Inject('IReservationRepository')
    private readonly reservationRepo: IReservationRepository,
  ) {}

  async execute(command: ConfirmReservationCommand): Promise<void> {
    const outcome = await this.reservationRepo.confirm(command.orderId);
    switch (outcome) {
      case 'CONFIRMED':
      case 'ALREADY_CONFIRMED':
        return;
      case 'RELEASED':
        throw new InventoryDomainException(
          InventoryErrorCodes.RESERVATION_RELEASED,
        );
      case 'NOT_FOUND':
        throw new InventoryDomainException(
          InventoryErrorCodes.RESERVATION_NOT_FOUND,
        );
    }
  }
}
