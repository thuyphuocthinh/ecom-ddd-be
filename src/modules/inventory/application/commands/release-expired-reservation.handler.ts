import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ReservationReleaser } from '../services/reservation-releaser.service.js';
import { ReleaseExpiredReservationCommand } from './release-expired-reservation.command.js';

/**
 * The timer of an order went off. Gives the units back only if the order is still RESERVED and
 * really past its expiry; a paid order, a cancelled one, or a timer that came early does nothing.
 */
@CommandHandler(ReleaseExpiredReservationCommand)
export class ReleaseExpiredReservationHandler implements ICommandHandler<ReleaseExpiredReservationCommand> {
  constructor(private readonly releaser: ReservationReleaser) {}

  async execute(command: ReleaseExpiredReservationCommand): Promise<void> {
    await this.releaser.release(command.orderId, { onlyIfExpired: true });
  }
}
