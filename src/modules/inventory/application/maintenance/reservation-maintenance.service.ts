import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { CoreErrorCodes, DomainException, LockService } from '@/core/index.js';
import {
  inventoryConfig,
  type InventoryConfig,
} from '../../inventory.config.js';
import { ReleaseExpiredReservationsCommand } from '../commands/release-expired-reservations.command.js';
import { RepairInFlightHoldsCommand } from '../commands/repair-in-flight-holds.command.js';

const LOCK_NAME = 'inventory:maintenance';
const LOCK_TTL_MS = 5 * 60_000;

/**
 * Runs the two safety nets on a timer: give back holds that expired without their timer firing,
 * and repair holds left half-done by a dead process. Every instance of the server runs this, but
 * under a lock that is not waited for: the one that gets it works, the others skip that round.
 * Both jobs are safe to repeat anyway.
 *
 * Plain `setInterval` (no scheduler package): there are only these two jobs. `0` seconds switches
 * it off, which is what tests do and then call `runOnce` themselves.
 */
@Injectable()
export class ReservationMaintenance
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReservationMaintenance.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly commandBus: CommandBus,
    private readonly locks: LockService,
    @Inject(inventoryConfig.KEY) private readonly config: InventoryConfig,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.maintenanceIntervalSeconds;
    if (seconds <= 0) return;
    this.timer = setInterval(() => void this.runOnce(), seconds * 1000);
    // Never keep the process alive just for this timer
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One round. Never throws: a failed round is logged and the next one tries again. */
  async runOnce(): Promise<void> {
    try {
      await this.locks.run(
        LOCK_NAME,
        async () => {
          await this.commandBus.execute(
            new ReleaseExpiredReservationsCommand(),
          );
          await this.commandBus.execute(new RepairInFlightHoldsCommand());
        },
        { ttlMs: LOCK_TTL_MS, waitMs: 0 },
      );
    } catch (error) {
      if (
        error instanceof DomainException &&
        error.code === CoreErrorCodes.RESOURCE_BUSY.code
      ) {
        return; // another instance is doing this round
      }
      this.logger.error(
        `Inventory maintenance failed: ${(error as Error).message}`,
      );
    }
  }
}
