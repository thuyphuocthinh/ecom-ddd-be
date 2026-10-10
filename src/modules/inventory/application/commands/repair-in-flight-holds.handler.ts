import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import type {
  IAvailabilityStore,
  IReservationRepository,
} from '../../domain/index.js';
import {
  inventoryConfig,
  type InventoryConfig,
} from '../../inventory.config.js';
import { RepairInFlightHoldsCommand } from './repair-in-flight-holds.command.js';

const BATCH_SIZE = 100;

/**
 * Repairs holds left half-done. A hold writes a "being held" record in Redis and removes it once
 * Postgres has the lines. A record that is still there after the grace period means the process
 * died in between. Postgres decides which of the two ways it died:
 *
 *  - the lines are in Postgres: only the record was left behind, so just clear it;
 *  - there are no lines: the units were taken in Redis for an order that does not exist, so give
 *    them back (this is the leak that would otherwise lose that stock for good).
 */
@CommandHandler(RepairInFlightHoldsCommand)
export class RepairInFlightHoldsHandler implements ICommandHandler<RepairInFlightHoldsCommand> {
  private readonly logger = new Logger(RepairInFlightHoldsHandler.name);

  constructor(
    @Inject('IReservationRepository')
    private readonly reservationRepo: IReservationRepository,
    @Inject('IAvailabilityStore') private readonly store: IAvailabilityStore,
    @Inject(inventoryConfig.KEY) private readonly config: InventoryConfig,
  ) {}

  async execute(): Promise<{ cleared: number; returned: number }> {
    const stale = await this.store.listStaleInflight(
      this.config.inflightGraceSeconds * 1000,
      BATCH_SIZE,
    );
    let cleared = 0;
    let returned = 0;

    for (const orderId of stale) {
      try {
        if (await this.reservationRepo.existsForOrder(orderId)) {
          await this.store.finishHold(orderId);
          cleared++;
          continue;
        }
        const items = await this.store.readInflight(orderId);
        if (!items) {
          await this.store.finishHold(orderId); // only the index entry was left
          cleared++;
        } else if (await this.store.undoHold(orderId, items)) {
          returned++;
          this.logger.warn(
            `Order ${orderId} had no reservation in Postgres; its units were given back in Redis`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Could not repair the hold of order ${orderId}: ${(error as Error).message}`,
        );
      }
    }
    return { cleared, returned };
  }
}
