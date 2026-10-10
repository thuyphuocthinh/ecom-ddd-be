import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import type { IReservationRepository } from '../../domain/index.js';
import { ReservationReleaser } from '../services/reservation-releaser.service.js';
import { ReleaseExpiredReservationsCommand } from './release-expired-reservations.command.js';

const BATCH_SIZE = 100;
// A run never loops for long, even if some order keeps failing: the next run continues
const MAX_BATCHES = 10;

/**
 * The safety net behind the timers: a timer can be lost (the broker was down when the stock was
 * held), and then nothing would ever give the units back. Postgres is the source of truth, so
 * this looks there for holds past their expiry and releases them.
 */
@CommandHandler(ReleaseExpiredReservationsCommand)
export class ReleaseExpiredReservationsHandler implements ICommandHandler<ReleaseExpiredReservationsCommand> {
  private readonly logger = new Logger(ReleaseExpiredReservationsHandler.name);

  constructor(
    @Inject('IReservationRepository')
    private readonly reservationRepo: IReservationRepository,
    private readonly releaser: ReservationReleaser,
  ) {}

  /** Returns how many orders it released. */
  async execute(): Promise<number> {
    let released = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const orderIds =
        await this.reservationRepo.findExpiredOrderIds(BATCH_SIZE);
      for (const orderId of orderIds) {
        try {
          if (await this.releaser.release(orderId, { onlyIfExpired: true })) {
            released++;
          }
        } catch (error) {
          this.logger.error(
            `Could not release expired order ${orderId}: ${(error as Error).message}`,
          );
        }
      }
      if (orderIds.length < BATCH_SIZE) break;
    }
    return released;
  }
}
