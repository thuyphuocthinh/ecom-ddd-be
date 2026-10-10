import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ReservationReleaser } from '../services/reservation-releaser.service.js';
import { ReleaseReservationCommand } from './release-reservation.command.js';

/** The order was cancelled: give the units back now. Safe to repeat; an unknown order is a no-op. */
@CommandHandler(ReleaseReservationCommand)
export class ReleaseReservationHandler implements ICommandHandler<ReleaseReservationCommand> {
  constructor(private readonly releaser: ReservationReleaser) {}

  async execute(command: ReleaseReservationCommand): Promise<void> {
    await this.releaser.release(command.orderId, { onlyIfExpired: false });
  }
}
