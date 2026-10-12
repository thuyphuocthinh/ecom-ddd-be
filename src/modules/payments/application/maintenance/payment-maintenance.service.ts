import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { CoreErrorCodes, DomainException, LockService } from '@/core/index.js';
import { paymentsConfig, type PaymentsConfig } from '../../payments.config.js';
import {
  FinishPaidPaymentsCommand,
  ReconcilePendingPaymentsCommand,
  RefundPendingPaymentsCommand,
  ReopenStuckOrdersCommand,
} from '../commands/sweep-commands.js';

const LOCK_NAME = 'payment:maintenance';
const LOCK_TTL_MS = 5 * 60_000;

/**
 * Runs the four sweeps on a timer, in this order: ask the gateway about payments that have waited
 * (A), finish paid payments whose order is still waiting (B), send back money that has to go back
 * (C), open orders that are stuck with no payment behind them (D). A comes first because it can
 * produce work for the others. Every copy of the server runs this under a lock that is not waited
 * for: the one that gets it works, the others skip that round. Each sweep is safe to repeat, and
 * one failing does not stop the next.
 *
 * These sweeps are the safety net of the whole payment flow: webhooks and events make it fast, but
 * nothing depends on them arriving. `0` seconds switches it off; tests do that and call `runOnce`.
 */
@Injectable()
export class PaymentMaintenance
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PaymentMaintenance.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly commandBus: CommandBus,
    private readonly locks: LockService,
    @Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig,
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
            new ReconcilePendingPaymentsCommand(),
            new FinishPaidPaymentsCommand(),
            new RefundPendingPaymentsCommand(),
            new ReopenStuckOrdersCommand(),
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
        `Payment maintenance failed: ${(error as Error).message}`,
      );
    }
  }
}
