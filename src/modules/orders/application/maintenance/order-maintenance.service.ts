import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { CoreErrorCodes, DomainException, LockService } from '@/core/index.js';
import { ordersConfig, type OrdersConfig } from '../../orders.config.js';
import {
  ExpireDueOrdersCommand,
  FinishPendingCodOrdersCommand,
  ReturnStockForCancelledOrdersCommand,
} from '../commands/sweep-commands.js';

const LOCK_NAME = 'order:maintenance';
const LOCK_TTL_MS = 5 * 60_000;

/**
 * Runs the three sweeps on a timer: expire unpaid online orders, finish cash-on-delivery orders
 * left half-done, and put back the stock of cancelled orders. Every copy of the server runs this
 * under a lock that is not waited for: the one that gets it works, the others skip that round.
 * Each sweep is safe to repeat, and one failing does not stop the next.
 *
 * `0` seconds switches it off; tests do that and call `runOnce` themselves.
 */
@Injectable()
export class OrderMaintenance
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OrderMaintenance.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly commandBus: CommandBus,
    private readonly locks: LockService,
    @Inject(ordersConfig.KEY) private readonly config: OrdersConfig,
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

  /** One round. Never throws: a failed sweep is logged and the next round tries again. */
  async runOnce(): Promise<void> {
    try {
      await this.locks.run(
        LOCK_NAME,
        async () => {
          for (const command of [
            new ExpireDueOrdersCommand(),
            new FinishPendingCodOrdersCommand(),
            new ReturnStockForCancelledOrdersCommand(),
          ]) {
            try {
              await this.commandBus.execute(command);
            } catch (error) {
              this.logger.error(
                `${command.constructor.name} failed: ${(error as Error).message}`,
              );
            }
          }
        },
        { ttlMs: LOCK_TTL_MS, waitMs: 0 },
      );
    } catch (error) {
      if (
        error instanceof DomainException &&
        error.code === CoreErrorCodes.RESOURCE_BUSY.code
      ) {
        return; // another copy is doing this round
      }
      this.logger.error(
        `Order maintenance failed: ${(error as Error).message}`,
      );
    }
  }
}
