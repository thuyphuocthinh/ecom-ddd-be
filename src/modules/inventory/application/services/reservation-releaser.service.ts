import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  IAvailabilityStore,
  IReservationRepository,
} from '../../domain/index.js';

/**
 * Gives the units of an order back: first in Postgres (the status change that decides who wins),
 * then in Redis. One place for the three ways in (cancel, timer, sweep) so they all behave alike.
 */
@Injectable()
export class ReservationReleaser {
  private readonly logger = new Logger(ReservationReleaser.name);

  constructor(
    @Inject('IReservationRepository')
    private readonly reservationRepo: IReservationRepository,
    @Inject('IAvailabilityStore') private readonly store: IAvailabilityStore,
  ) {}

  /** Returns whether it released anything: false when the order was not RESERVED (or not expired). */
  async release(
    orderId: string,
    options: { onlyIfExpired: boolean },
  ): Promise<boolean> {
    const released = await this.reservationRepo.release(orderId, options);
    if (released.length === 0) return false;

    try {
      await this.store.giveBack(released);
    } catch (error) {
      // Postgres already says RELEASED, so failing here would make a retry find nothing to do and
      // never add the units back. Say so loudly instead: Redis shows fewer units than there are
      // (the safe side) until the SKUs are rebuilt.
      this.logger.error(
        `Order ${orderId} was released but Redis could not take the units back (${(error as Error).message}); rebuild: ${released.map((line) => line.skuId).join(', ')}`,
      );
    }
    return true;
  }
}
