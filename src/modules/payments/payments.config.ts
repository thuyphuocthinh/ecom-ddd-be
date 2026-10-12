import { registerAs, type ConfigType } from '@nestjs/config';

/**
 * Payment settings, parsed once at boot. `validateEnv` has already guaranteed that every value that
 * is set is in range, so nothing downstream re-parses env strings. Tests override this object with
 * small values.
 */
export const paymentsConfig = registerAs('payments', () => ({
  // Which gateway is used (`fake` is the stand-in that runs inside the application).
  gateway: process.env.PAYMENT_GATEWAY ?? 'fake',
  // How long a customer has to pay once they start, in minutes. The stock is held that long.
  windowMinutes: Number(process.env.PAYMENT_WINDOW_MINUTES ?? 15),
  // How often the sweep runs: asks the gateway about lost results, finishes half-done payments,
  // refunds. 0 switches it off.
  maintenanceIntervalSeconds: Number(
    process.env.PAYMENT_MAINTENANCE_INTERVAL_SECONDS ?? 60,
  ),
  // How far from now a webhook may be dated before it is refused as a replay.
  webhookToleranceSeconds: Number(
    process.env.PAYMENT_WEBHOOK_TOLERANCE_SECONDS ?? 300,
  ),
  // The key that signs the webhooks of the fake gateway.
  fakeWebhookSecret: process.env.PAYMENT_FAKE_WEBHOOK_SECRET ?? '',
}));

export type PaymentsConfig = ConfigType<typeof paymentsConfig>;
