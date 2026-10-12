import { registerAs, type ConfigType } from '@nestjs/config';

/**
 * Order settings, parsed once at boot. `validateEnv` has already guaranteed that every value that
 * is set is a whole number in range, so nothing downstream re-parses env strings. Tests override
 * this object with small values.
 */
export const ordersConfig = registerAs('orders', () => ({
  // How often the outbox is read and its events sent to RabbitMQ. 0 switches the publisher off.
  outboxIntervalMs: Number(process.env.ORDER_OUTBOX_INTERVAL_MS ?? 1000),
  // How many events one round sends at most.
  outboxBatchSize: Number(process.env.ORDER_OUTBOX_BATCH_SIZE ?? 50),
  // How often the sweep runs: expired unpaid orders, cash-on-delivery orders left half-done, and
  // stock still to put back after a cancellation. 0 switches it off.
  maintenanceIntervalSeconds: Number(
    process.env.ORDER_MAINTENANCE_INTERVAL_SECONDS ?? 60,
  ),
}));

export type OrdersConfig = ConfigType<typeof ordersConfig>;
