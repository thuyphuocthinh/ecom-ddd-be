import {
  CommandBus,
  CommandHandler,
  ICommandHandler,
  QueryBus,
} from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { DomainException, OrderErrorCodes } from '@/core/index.js';
import {
  ExpireOrderCommand,
  FindStuckPaymentOrdersQuery,
  ReopenOrderCommand,
  sweepInBatches,
} from '../../../orders/application/index.js';
import {
  GatewayRejected,
  GatewayUnavailable,
  PAYMENT_GATEWAY,
  Payment,
  PaymentStatus,
  paymentExpiredEvent,
  type ChargeStatusResult,
  type IPaymentGateway,
  type IPaymentRepository,
} from '../../domain/index.js';
import { ApplyPaymentResultCommand } from './apply-payment-result.command.js';
import type { ApplyResult } from './apply-payment-result.handler.js';
import { FinishPaidPaymentCommand } from './finish-paid-payment.command.js';
import type { FinishPaidResult } from './finish-paid-payment.handler.js';
import { RefundPaymentCommand } from './refund-payment.command.js';
import type { RefundResult } from './refund-payment.handler.js';
import {
  FinishPaidPaymentsCommand,
  ReconcilePendingPaymentsCommand,
  RefundPendingPaymentsCommand,
  ReopenStuckOrdersCommand,
} from './sweep-commands.js';

// A request that is still working on a payment must not be stepped on, so the sweeps only look at
// what has been waiting for at least this long
export const RECONCILE_GRACE_SECONDS = 60;
export const PAID_GRACE_SECONDS = 30;
export const STUCK_ORDER_GRACE_SECONDS = 60;

const isNotAllowed = (error: unknown) =>
  error instanceof DomainException &&
  error.code === OrderErrorCodes.INVALID_STATE_TRANSITION.code;

/**
 * Sweep A. A webhook can be lost, so a payment that has been waiting for a while is not left to
 * chance: the gateway is asked how it went, and the answer goes through the SAME command a webhook
 * does (`ApplyPaymentResult`), so there is one way in whatever told us. The gateway is asked even
 * when the time to pay has run out, so that a payment that was paid at the last moment is not
 * expired on top of paid money. Only when the gateway still says "pending" (or does not know the
 * charge) and the time is over, the payment expires and the order with it.
 *
 * A gateway that cannot be reached leaves the payment as it is for the next round.
 */
@CommandHandler(ReconcilePendingPaymentsCommand)
export class ReconcilePendingPaymentsHandler implements ICommandHandler<
  ReconcilePendingPaymentsCommand,
  number
> {
  private readonly logger = new Logger(ReconcilePendingPaymentsHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
    private readonly commandBus: CommandBus,
  ) {}

  execute(): Promise<number> {
    const pastDeadline = new Map<string, boolean>();
    return sweepInBatches(
      async (limit) => {
        const found = await this.payments.findInitiatedForReconcile(
          RECONCILE_GRACE_SECONDS,
          limit,
        );
        for (const { id, pastDeadline: over } of found)
          pastDeadline.set(id, over);
        return found.map((payment) => payment.id);
      },
      (paymentId) =>
        this.reconcile(paymentId, pastDeadline.get(paymentId) ?? false),
      (paymentId, error) =>
        this.logger.error(
          `Could not reconcile payment ${paymentId}: ${error.message}`,
        ),
    );
  }

  private async reconcile(paymentId: string, over: boolean): Promise<boolean> {
    const payment = await this.payments.findById(paymentId);
    if (!payment || payment.status !== PaymentStatus.INITIATED) return false;

    const report = await this.askGateway(payment);
    if (report === 'UNREACHABLE') return false;

    if (report && report.status !== 'PENDING' && payment.providerRef) {
      const applied = await this.commandBus.execute<
        ApplyPaymentResultCommand,
        ApplyResult
      >(
        new ApplyPaymentResultCommand(
          payment.provider,
          payment.providerRef,
          report.status,
          report.amount,
        ),
      );
      return applied === 'APPLIED';
    }
    return over ? this.expire(payment) : false;
  }

  /** null when the gateway does not know the charge (or there was no charge yet). */
  private async askGateway(
    payment: Payment,
  ): Promise<ChargeStatusResult | null | 'UNREACHABLE'> {
    if (!payment.providerRef) return null;
    try {
      return await this.gateway.queryCharge(payment.providerRef);
    } catch (error) {
      if (error instanceof GatewayRejected) return null;
      if (error instanceof GatewayUnavailable) {
        this.logger.warn(
          `Payment ${payment.id}: the gateway could not be asked now (${error.message}); next round`,
        );
        return 'UNREACHABLE';
      }
      throw error;
    }
  }

  private async expire(payment: Payment): Promise<boolean> {
    const expired = await this.payments.transition(
      payment.id,
      [PaymentStatus.INITIATED],
      PaymentStatus.EXPIRED,
      paymentExpiredEvent(payment),
    );
    if (!expired) return false;
    // The time to pay is over, so the order is over with it. (If another payment already paid the
    // order, it is no longer waiting and this is refused: nothing to move.)
    try {
      await this.commandBus.execute(new ExpireOrderCommand(payment.orderId));
    } catch (error) {
      if (!isNotAllowed(error)) {
        this.logger.error(
          `Payment ${payment.id} expired but order ${payment.orderId} could not be expired: ${(error as Error).message}`,
        );
      }
    }
    return true;
  }
}

/** Sweep B. */
@CommandHandler(FinishPaidPaymentsCommand)
export class FinishPaidPaymentsHandler implements ICommandHandler<
  FinishPaidPaymentsCommand,
  number
> {
  private readonly logger = new Logger(FinishPaidPaymentsHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    private readonly commandBus: CommandBus,
  ) {}

  execute(): Promise<number> {
    return sweepInBatches(
      (limit) =>
        this.payments.findPaidButOrderStillPayingIds(PAID_GRACE_SECONDS, limit),
      async (paymentId) => {
        const result = await this.commandBus.execute<
          FinishPaidPaymentCommand,
          FinishPaidResult
        >(new FinishPaidPaymentCommand(paymentId));
        return result.kind !== 'NOTHING_TO_DO';
      },
      (paymentId, error) =>
        this.logger.error(
          `Could not finish paid payment ${paymentId}: ${error.message}`,
        ),
    );
  }
}

/** Sweep C. */
@CommandHandler(RefundPendingPaymentsCommand)
export class RefundPendingPaymentsHandler implements ICommandHandler<
  RefundPendingPaymentsCommand,
  number
> {
  private readonly logger = new Logger(RefundPendingPaymentsHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    private readonly commandBus: CommandBus,
  ) {}

  execute(): Promise<number> {
    return sweepInBatches(
      (limit) => this.payments.findRefundableIds(limit),
      async (paymentId) => {
        // The finder only returns payments whose money has to go back (REFUND_PENDING, or paid ones
        // of an order that is cancelled or expired), so a paid payment of a live order is never here
        const result = await this.commandBus.execute<
          RefundPaymentCommand,
          RefundResult
        >(new RefundPaymentCommand(paymentId, { markFirst: true }));
        return result.kind === 'REFUNDED';
      },
      (paymentId, error) =>
        this.logger.error(
          `Could not refund payment ${paymentId}: ${error.message}`,
        ),
    );
  }
}

/** Sweep D. */
@CommandHandler(ReopenStuckOrdersCommand)
export class ReopenStuckOrdersHandler implements ICommandHandler<
  ReopenStuckOrdersCommand,
  number
> {
  private readonly logger = new Logger(ReopenStuckOrdersHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  execute(): Promise<number> {
    return sweepInBatches(
      (limit) =>
        this.queryBus.execute<FindStuckPaymentOrdersQuery, string[]>(
          new FindStuckPaymentOrdersQuery(STUCK_ORDER_GRACE_SECONDS, limit),
        ),
      async (orderId) => {
        // An order with a payment that is waiting, or paid, is not stuck: that payment will finish it
        if (await this.payments.hasLivePayment(orderId)) return false;
        try {
          await this.commandBus.execute(new ReopenOrderCommand(orderId));
          return true;
        } catch (error) {
          if (isNotAllowed(error)) return false; // it moved on its own meanwhile
          throw error;
        }
      },
      (orderId, error) =>
        this.logger.error(
          `Could not open order ${orderId} again: ${error.message}`,
        ),
    );
  }
}
