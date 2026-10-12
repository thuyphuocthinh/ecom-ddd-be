import type { IPaymentGateway } from '../../domain/index.js';
import type { PaymentsConfig } from '../../payments.config.js';
import { FakePaymentGateway } from './fake-payment.gateway.js';

/**
 * Picks the adapter named by `PAYMENT_GATEWAY` (validated at boot by `validateEnv`). A real
 * gateway is one more `case` here, with its own adapter class that passes the contract test.
 */
export function createPaymentGateway(config: PaymentsConfig): IPaymentGateway {
  switch (config.gateway) {
    case 'fake':
      return new FakePaymentGateway({
        secret: config.fakeWebhookSecret,
        toleranceSeconds: config.webhookToleranceSeconds,
      });
    default:
      throw new Error(`Unknown PAYMENT_GATEWAY "${config.gateway}"`);
  }
}
