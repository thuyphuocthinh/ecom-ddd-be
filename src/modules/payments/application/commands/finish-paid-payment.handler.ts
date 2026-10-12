import {
  CommandBus,
  CommandHandler,
  ICommandHandler,
  QueryBus,
} from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { OrderErrorCodes, DomainException } from '@/core/index.js';
import {
  ConfirmOrderCommand,
  ExpireOrderCommand,
  GetOrderByIdQuery,
  ReopenOrderCommand,
  type ConfirmOrderResult,
} from '../../../orders/application/index.js';
import { OrderStatus, type Order } from '../../../orders/domain/index.js';
import {
  Payment,
  PaymentStatus,
  sameAmount,
  type IPaymentRepository,
} from '../../domain/index.js';
import { FinishPaidPaymentCommand } from './finish-paid-payment.command.js';
import { RefundPaymentCommand } from './refund-payment.command.js';

export type FinishPaidResult =
  | { kind: 'CONFIRMED' }
  /** The money is on its way back, and why. */
  | {
      kind: 'REFUNDING';
      reason:
        | 'AMOUNT_MISMATCH'
        | 'HOLD_LOST'
        | 'ORDER_CLOSED'
        | 'ORDER_NOT_WAITING'
        | 'DUPLICATE_PAYMENT';
    }
  /** Nothing to do: no such payment, one that is not SUCCEEDED, or an order already done by this payment. */
  | { kind: 'NOTHING_TO_DO' };

const isMissingOrder = (error: unknown) =>
  error instanceof DomainException &&
  error.code === OrderErrorCodes.NOT_FOUND.code;
const isNotAllowed = (error: unknown) =>
  error instanceof DomainException &&
  error.code === OrderErrorCodes.INVALID_STATE_TRANSITION.code;

/**
 * What to do with money that came in. The rule is that the shop never keeps money without sending
 * the goods: either the order is confirmed (the stock leaves the warehouse FIRST and the order is
 * changed SECOND, as `ConfirmOrder` does it), or the money goes back.
 *
 *  - the amount collected is not the price of the order: the order is NOT confirmed, it is opened
 *    again (so the customer may try again) and what was collected goes back;
 *  - the order is waiting for this payment: confirm it. If the held stock was already given back
 *    (`HOLD_LOST`) the order expires and the money goes back;
 *  - the order is cancelled or expired, or was opened again and is waiting for another try: the
 *    money goes back;
 *  - the order is already confirmed (or further): if ANOTHER payment of the same order became paid
 *    before this one, this one is a second payment for one order and goes back; otherwise it is
 *    this payment that did it and there is nothing left to do.
 */
@CommandHandler(FinishPaidPaymentCommand)
export class FinishPaidPaymentHandler implements ICommandHandler<
  FinishPaidPaymentCommand,
  FinishPaidResult
> {
  private readonly logger = new Logger(FinishPaidPaymentHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  async execute({
    paymentId,
  }: FinishPaidPaymentCommand): Promise<FinishPaidResult> {
    const payment = await this.payments.findById(paymentId);
    if (!payment || payment.status !== PaymentStatus.SUCCEEDED) {
      return { kind: 'NOTHING_TO_DO' };
    }
    return this.decide(payment, true);
  }

  /** `firstLook` is false on the one second look taken when the order moved while we were deciding. */
  private async decide(
    payment: Payment,
    firstLook: boolean,
  ): Promise<FinishPaidResult> {
    let order: Order;
    try {
      order = await this.queryBus.execute<GetOrderByIdQuery, Order>(
        new GetOrderByIdQuery(payment.orderId),
      );
    } catch (error) {
      if (!isMissingOrder(error)) throw error;
      // Cannot happen (a payment cannot exist without its order), but money is never kept for nothing
      return this.refund(payment, 'ORDER_CLOSED');
    }

    // A payment of the wrong amount never confirms an order
    if (!sameAmount(payment.refundAmount, payment.amount)) {
      this.logger.warn(
        `Payment ${payment.id}: ${payment.refundAmount} was collected for an order of ${payment.amount}; not confirming, refunding`,
      );
      if (order.status === OrderStatus.PAYMENT_PROCESSING) {
        await this.tolerate(() =>
          this.commandBus.execute(new ReopenOrderCommand(order.id)),
        );
      }
      return this.refund(payment, 'AMOUNT_MISMATCH');
    }

    switch (order.status) {
      case OrderStatus.PAYMENT_PROCESSING:
        return this.confirm(payment, order, firstLook);
      case OrderStatus.CANCELLED:
      case OrderStatus.EXPIRED:
        return this.refund(payment, 'ORDER_CLOSED');
      case OrderStatus.PENDING:
        // It was opened again (another try, or the sweep) before this money was known
        return this.refund(payment, 'ORDER_NOT_WAITING');
      default:
        // CONFIRMED, SHIPPING, DELIVERED
        return (await this.paidEarlier(payment))
          ? this.refund(payment, 'DUPLICATE_PAYMENT')
          : { kind: 'NOTHING_TO_DO' };
    }
  }

  private async confirm(
    payment: Payment,
    order: Order,
    firstLook: boolean,
  ): Promise<FinishPaidResult> {
    let result: ConfirmOrderResult;
    try {
      result = await this.commandBus.execute(new ConfirmOrderCommand(order.id));
    } catch (error) {
      // The order moved under us (cancelled, expired): look again at where it is now, once
      if (isNotAllowed(error)) {
        return firstLook
          ? this.decide(payment, false)
          : this.refund(payment, 'ORDER_NOT_WAITING');
      }
      throw error;
    }
    if (result.kind === 'CONFIRMED') return { kind: 'CONFIRMED' };

    // The held stock is gone: the order cannot be delivered, so it ends here and the money goes back
    await this.tolerate(() =>
      this.commandBus.execute(new ExpireOrderCommand(order.id)),
    );
    return this.refund(payment, 'HOLD_LOST');
  }

  /**
   * Whether another payment of the same order is paid and became so BEFORE this one: then the order
   * was paid by that one and this is a second payment for one order. Both are SUCCEEDED, so the time
   * each was last changed is the time it became SUCCEEDED. (A payment that already left SUCCEEDED
   * for a refund is not the one that paid the order.)
   */
  private async paidEarlier(payment: Payment): Promise<boolean> {
    const others = await this.payments.listByOrder(payment.orderId);
    return others.some(
      (other) =>
        other.id !== payment.id &&
        other.status === PaymentStatus.SUCCEEDED &&
        (other.updatedAt.getTime() < payment.updatedAt.getTime() ||
          (other.updatedAt.getTime() === payment.updatedAt.getTime() &&
            other.id < payment.id)),
    );
  }

  /** Marks the payment as owing a refund and asks for it. A refund that cannot be done now is the sweep's. */
  private async refund(
    payment: Payment,
    reason: Extract<FinishPaidResult, { kind: 'REFUNDING' }>['reason'],
  ): Promise<FinishPaidResult> {
    await this.payments.transition(
      payment.id,
      [PaymentStatus.SUCCEEDED],
      PaymentStatus.REFUND_PENDING,
      null,
    );
    await this.tolerate(() =>
      this.commandBus.execute(new RefundPaymentCommand(payment.id)),
    );
    return { kind: 'REFUNDING', reason };
  }

  /** Runs a step whose failure must not stop the rest: an order already moved, or a service down. */
  private async tolerate(step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      if (isNotAllowed(error)) return; // the order is not where we thought: nothing to move
      this.logger.error(
        `A step after money came in failed: ${(error as Error).message}`,
      );
    }
  }
}
