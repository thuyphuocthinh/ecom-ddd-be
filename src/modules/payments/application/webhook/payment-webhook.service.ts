import { CommandBus } from '@nestjs/cqrs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InvalidWebhookPayload,
  InvalidWebhookSignature,
  PAYMENT_GATEWAY,
  type IPaymentGateway,
  type WebhookReply,
  type WebhookRequest,
} from '../../domain/index.js';
import { ApplyPaymentResultCommand } from '../commands/apply-payment-result.command.js';
import type { ApplyResult } from '../commands/apply-payment-result.handler.js';

/**
 * What happens to a webhook once it has reached the server, the same for every gateway: the
 * adapter checks and reads it, the result goes through `ApplyPaymentResult` (the one way in), and
 * the answer is the one the adapter says the gateway expects. The HTTP endpoint and the dev
 * endpoints of the fake gateway both end up here, so a webhook is treated the same however it came.
 *
 * Nothing here trusts the request: until the adapter has verified the signature, nothing is read
 * or written. A message we cannot handle ourselves gets the "try again" answer, so the gateway
 * sends it again later.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
    private readonly commandBus: CommandBus,
  ) {}

  /** True when `provider` (from the URL) is the gateway this server is set up with. */
  isConfigured(provider: string): boolean {
    return provider === this.gateway.name;
  }

  async handle(request: WebhookRequest): Promise<WebhookReply> {
    let notice;
    try {
      notice = this.gateway.verifyWebhook(request);
    } catch (error) {
      if (error instanceof InvalidWebhookSignature) {
        this.logger.warn(`Webhook refused: ${error.message}`);
        return this.gateway.webhookReply('INVALID_SIGNATURE');
      }
      if (error instanceof InvalidWebhookPayload) {
        this.logger.warn(`Webhook refused: ${error.message}`);
        return this.gateway.webhookReply('BAD_REQUEST');
      }
      this.logger.error(
        `Webhook could not be read: ${(error as Error).message}`,
      );
      return this.gateway.webhookReply('ERROR');
    }

    try {
      const result = await this.commandBus.execute<
        ApplyPaymentResultCommand,
        ApplyResult
      >(
        new ApplyPaymentResultCommand(
          this.gateway.name,
          notice.providerRef,
          notice.status,
          notice.amount,
          notice.eventId,
        ),
      );
      if (result === 'UNKNOWN_PAYMENT') {
        // Answered "received" so the gateway stops sending it; worth a look by a person
        this.logger.warn(
          `Webhook ${notice.eventId} is about a charge we do not have`,
        );
      }
      return this.gateway.webhookReply('RECEIVED');
    } catch (error) {
      this.logger.error(
        `Webhook ${notice.eventId} could not be applied: ${(error as Error).message}`,
      );
      return this.gateway.webhookReply('ERROR');
    }
  }
}
