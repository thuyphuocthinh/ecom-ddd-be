import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import {
  GatewayRejected,
  GatewayUnavailable,
  PAYMENT_GATEWAY,
  PaymentStatus,
  paymentRefundedEvent,
  type IPaymentGateway,
  type IPaymentRepository,
} from '../../domain/index.js';
import { RefundPaymentCommand } from './refund-payment.command.js';

export type RefundResult =
  /** The money went back (now, or it already had). */
  | { kind: 'REFUNDED' }
  /** The gateway could not do it now. The payment stays REFUND_PENDING and the sweep tries again. */
  | { kind: 'RETRY_LATER' }
  /** The gateway refused. Trying again will not help; it stays REFUND_PENDING and is logged loudly. */
  | { kind: 'REFUSED' }
  /** There was nothing to refund: no such payment, or one that is not waiting for a refund. */
  | { kind: 'NOTHING_TO_DO' };

/**
 * The gateway is asked OUTSIDE any transaction (it is slow), and the payment is marked REFUNDED
 * only after the gateway said yes. If the process dies in between, the payment is still
 * REFUND_PENDING and the next try asks again, which is harmless because the gateway refunds a
 * payment once whatever the number of times it is asked. What goes back is what was really
 * collected, which is not always the price of the order.
 */
@CommandHandler(RefundPaymentCommand)
export class RefundPaymentHandler implements ICommandHandler<
  RefundPaymentCommand,
  RefundResult
> {
  private readonly logger = new Logger(RefundPaymentHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
  ) {}

  async execute({
    paymentId,
    options,
  }: RefundPaymentCommand): Promise<RefundResult> {
    let payment = await this.payments.findById(paymentId);
    if (!payment) return { kind: 'NOTHING_TO_DO' };

    if (payment.status === PaymentStatus.REFUNDED) return { kind: 'REFUNDED' };
    if (options.markFirst && payment.status === PaymentStatus.SUCCEEDED) {
      payment =
        (await this.payments.transition(
          paymentId,
          [PaymentStatus.SUCCEEDED],
          PaymentStatus.REFUND_PENDING,
          null,
        )) ?? (await this.payments.findById(paymentId));
      if (!payment) return { kind: 'NOTHING_TO_DO' };
    }
    if (payment.status !== PaymentStatus.REFUND_PENDING) {
      return { kind: 'NOTHING_TO_DO' };
    }
    if (!payment.providerRef) {
      // A payment that never had a charge cannot have collected anything
      this.logger.error(
        `Payment ${payment.id} is waiting for a refund but has no gateway reference`,
      );
      return { kind: 'REFUSED' };
    }

    try {
      await this.gateway.refund({
        paymentId: payment.id,
        providerRef: payment.providerRef,
        amount: payment.refundAmount,
      });
    } catch (error) {
      if (error instanceof GatewayUnavailable) {
        this.logger.warn(
          `Payment ${payment.id}: the gateway could not refund now (${error.message}); the sweep will try again`,
        );
        return { kind: 'RETRY_LATER' };
      }
      if (error instanceof GatewayRejected) {
        this.logger.error(
          `Payment ${payment.id}: the gateway refused the refund of ${payment.refundAmount} (${error.message}); it needs a look`,
        );
        return { kind: 'REFUSED' };
      }
      throw error;
    }

    // Someone else may have marked it already (a repeat of this command): that is fine too
    await this.payments.transition(
      payment.id,
      [PaymentStatus.REFUND_PENDING],
      PaymentStatus.REFUNDED,
      paymentRefundedEvent(payment, payment.refundAmount),
    );
    return { kind: 'REFUNDED' };
  }
}
