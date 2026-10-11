import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { InventoryErrorCodes } from '@/core/index.js';
import {
  InventoryDomainException,
  type IAvailabilityStore,
  type IReservationRepository,
} from '../../domain/index.js';
import { ReturnReservationCommand } from './return-reservation.command.js';

/**
 * An order that was already paid (its units left the warehouse stock) is cancelled before
 * delivery: put the units back. Postgres first, in one transaction (the status change that decides
 * who wins, and `onHand` going up again), then the number in Redis. Safe to repeat: a second call
 * finds nothing left to return and changes nothing.
 *
 * An order that was never confirmed has nothing to put back (`INV-008`), and an unknown order is
 * `INV-003`. If Redis cannot take the units after Postgres has already changed, the command still
 * succeeds (a retry would find nothing to do) and says loudly which SKUs to rebuild: Redis shows
 * fewer units than there are, the safe side, until they are rebuilt.
 */
@CommandHandler(ReturnReservationCommand)
export class ReturnReservationHandler implements ICommandHandler<ReturnReservationCommand> {
  private readonly logger = new Logger(ReturnReservationHandler.name);

  constructor(
    @Inject('IReservationRepository')
    private readonly reservationRepo: IReservationRepository,
    @Inject('IAvailabilityStore') private readonly store: IAvailabilityStore,
  ) {}

  async execute(command: ReturnReservationCommand): Promise<void> {
    const result = await this.reservationRepo.returnConfirmed(command.orderId);
    switch (result.kind) {
      case 'RETURNED':
        await this.giveBackInRedis(command.orderId, result.items);
        return;
      case 'ALREADY_RETURNED':
        return;
      case 'NOT_CONFIRMED':
        throw new InventoryDomainException(
          InventoryErrorCodes.RESERVATION_NOT_CONFIRMED,
        );
      case 'NOT_FOUND':
        throw new InventoryDomainException(
          InventoryErrorCodes.RESERVATION_NOT_FOUND,
        );
    }
  }

  private async giveBackInRedis(
    orderId: string,
    items: { skuId: string; qty: number }[],
  ): Promise<void> {
    try {
      await this.store.giveBack(items);
    } catch (error) {
      this.logger.error(
        `Order ${orderId} was returned but Redis could not take the units back (${(error as Error).message}); rebuild: ${items.map((line) => line.skuId).join(', ')}`,
      );
    }
  }
}
