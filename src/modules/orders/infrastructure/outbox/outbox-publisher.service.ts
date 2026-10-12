import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from '@/core/index.js';
import type { ClaimResult, IOutboxStore } from '../../domain/index.js';
import { ordersConfig, type OrdersConfig } from '../../orders.config.js';

/**
 * Sends the events waiting in the outbox to the event bus, and marks them sent. It runs on a timer
 * (`ORDER_OUTBOX_INTERVAL_MS`, 0 switches it off) and never overlaps with itself. Several copies of
 * the application can each run one: the outbox store hands each copy different rows.
 *
 * A round that fails (the bus is down) leaves the events unsent and logs one line; the next round
 * tries again. Nothing about an event is logged except its id and name: the payload belongs to
 * the event, not to the log.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject('IOutboxStore') private readonly store: IOutboxStore,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(ordersConfig.KEY) private readonly config: OrdersConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.outboxIntervalMs <= 0) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.config.outboxIntervalMs,
    );
    // The timer alone must not keep the process alive
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  /** One round: send up to a batch of unsent events. Returns how it went. */
  runOnce(): Promise<ClaimResult> {
    return this.store.claimBatch(this.config.outboxBatchSize, (row) =>
      this.bus.publish({
        id: row.id,
        name: row.type,
        occurredAt: row.createdAt,
        data: row.payload,
      }),
    );
  }

  /** A round from the timer: skipped while the previous one is still going, and never throws. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = this.runOnce()
      .then((result) => {
        if (result.failure) {
          this.logger.warn(
            `Outbox round stopped after ${result.sent} event(s): ${result.failure.message}`,
          );
        }
      })
      .catch((error: Error) => {
        this.logger.error(`Outbox round failed: ${error.message}`);
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
  }
}
