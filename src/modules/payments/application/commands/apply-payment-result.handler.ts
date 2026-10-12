import { CommandBus, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { ReopenOrderCommand } from '../../../orders/application/index.js';
import {
  Payment,
  PaymentStatus,
  paymentFailedEvent,
  paymentSucceededEvent,
  statusesBefore,
  type IInboxStore,
  type IPaymentRepository,
} from '../../domain/index.js';
import { ApplyPaymentResultCommand } from './apply-payment-result.command.js';
import { FinishPaidPaymentCommand } from './finish-paid-payment.command.js';

export type ApplyResult =
  /** The payment changed (money came in, or it failed). */
  | 'APPLIED'
  /** A message with this id was handled before. */
  | 'DUPLICATE'
  /** The gateway talks about a charge that is not ours. */
  | 'UNKNOWN_PAYMENT'
  /** The payment is already past this (a late or repeated report): nothing changed. */
  | 'IGNORED';

/**
 * One way in for what a gateway says. The conditional update on the payment is what keeps it safe
 * whatever arrives, however often and in whatever order:
 *
 *  - PAID moves INITIATED, FAILED or EXPIRED to SUCCEEDED: the money is real, so it wins over a
 *    failure or a timeout we had decided on. A second PAID finds SUCCEEDED and changes nothing.
 *  - FAILED moves only INITIATED to FAILED: a failure reported after the money came in changes
 *    nothing.
 *
 * Only the one that changed the payment goes on to the order. If it dies after changing the payment
 * and before the order, the sweep finishes it (a SUCCEEDED payment whose order is still waiting).
 *
 * A message with an id is noted first, so one delivered twice is handled once. If handling fails,
 * the note is taken back and the error goes on: the gateway will send the message again and it must
 * be handled then, not dropped as "seen". A process that dies leaves the note behind; the sweep asks
 * the gateway about every payment that is still waiting, so nothing is lost.
 */
@CommandHandler(ApplyPaymentResultCommand)
export class ApplyPaymentResultHandler implements ICommandHandler<
  ApplyPaymentResultCommand,
  ApplyResult
> {
  private readonly logger = new Logger(ApplyPaymentResultHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    @Inject('IInboxStore') private readonly inbox: IInboxStore,
    private readonly commandBus: CommandBus,
  ) {}

  async execute(command: ApplyPaymentResultCommand): Promise<ApplyResult> {
    const source = `webhook:${command.provider}`;
    if (command.eventId !== undefined) {
      if (!(await this.inbox.record(source, command.eventId))) {
        return 'DUPLICATE';
      }
    }
    try {
      return await this.apply(command);
    } catch (error) {
      if (command.eventId !== undefined) {
        await this.inbox
          .forget(source, command.eventId)
          .catch((forgetError: Error) =>
            this.logger.error(
              `Could not take message ${command.eventId} back out of the inbox: ${forgetError.message}`,
            ),
          );
      }
      throw error;
    }
  }

  private async apply(
    command: ApplyPaymentResultCommand,
  ): Promise<ApplyResult> {
    const payment = await this.payments.findByProviderRef(
      command.provider,
      command.providerRef,
    );
    if (!payment) {
      // Not ours: nothing to change, and the gateway must stop sending it
      this.logger.warn(
        `A report from ${command.provider} about a charge we do not know (${command.status})`,
      );
      return 'UNKNOWN_PAYMENT';
    }
    return command.status === 'PAID'
      ? this.paid(payment, command.amount)
      : this.failed(payment);
  }

  private async paid(
    payment: Payment,
    collected: number,
  ): Promise<ApplyResult> {
    if (!(collected > 0)) {
      this.logger.error(
        `Payment ${payment.id}: the gateway says it was paid but took ${collected}; ignored`,
      );
      return 'IGNORED';
    }
    const moved = await this.payments.transition(
      payment.id,
      statusesBefore(PaymentStatus.SUCCEEDED),
      PaymentStatus.SUCCEEDED,
      paymentSucceededEvent(payment, collected),
      { paidAmount: collected },
    );
    if (!moved) return 'IGNORED';

    // The order is the next step; if it fails the sweep finishes it
    try {
      await this.commandBus.execute(new FinishPaidPaymentCommand(moved.id));
    } catch (error) {
      this.logger.error(
        `Payment ${moved.id} is paid but finishing it failed (${(error as Error).message}); the sweep will`,
      );
    }
    return 'APPLIED';
  }

  private async failed(payment: Payment): Promise<ApplyResult> {
    const moved = await this.payments.transition(
      payment.id,
      [PaymentStatus.INITIATED],
      PaymentStatus.FAILED,
      paymentFailedEvent(payment),
    );
    if (!moved) return 'IGNORED';

    // The customer may try again: the order goes back to PENDING (it may not be waiting any more)
    try {
      await this.commandBus.execute(new ReopenOrderCommand(payment.orderId));
    } catch (error) {
      this.logger.warn(
        `Order ${payment.orderId} was not opened again after payment ${payment.id} failed (${(error as Error).message})`,
      );
    }
    return 'APPLIED';
  }
}
