import {
  CommandBus,
  CommandHandler,
  ICommandHandler,
  QueryBus,
} from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import {
  DomainException,
  InventoryErrorCodes,
  LockService,
  OrderErrorCodes,
  PaymentErrorCodes,
} from '@/core/index.js';
import { ExtendReservationCommand } from '../../../inventory/application/index.js';
import {
  GetOrderQuery,
  ReopenOrderCommand,
  StartOrderPaymentCommand,
} from '../../../orders/application/index.js';
import {
  PaymentMethod,
  isValidIdempotencyKey,
  OrderStatus,
  type Order,
} from '../../../orders/domain/index.js';
import {
  GatewayRejected,
  GatewayUnavailable,
  MAX_ATTEMPTS_PER_ORDER,
  PAYMENT_GATEWAY,
  Payment,
  PaymentAlreadyExistsError,
  PaymentDomainException,
  PaymentInProgressError,
  PaymentStatus,
  derivePaymentId,
  paymentFailedEvent,
  type IPaymentGateway,
  type IPaymentRepository,
} from '../../domain/index.js';
import { paymentsConfig, type PaymentsConfig } from '../../payments.config.js';
import { StartPaymentCommand } from './start-payment.command.js';

export interface StartPaymentResult {
  payment: Payment;
  /** True when this is the payment of an earlier request with the same key. */
  replayed: boolean;
}

// The lock must outlive the work (a few Postgres calls and one call to the gateway); if the
// process dies holding it, the lock lets go by itself after this long
const LOCK_TTL_MS = 30_000;

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof DomainException && error.code === code;

/**
 * The customer starts paying. The order of the steps is what makes it safe to cut short at any
 * point (the table of "what is left if it dies here" is in the spec):
 *
 *  1. Everything that can say "no" comes first and changes nothing: the key, the order (it must be
 *     the customer's own, online, PENDING, with attempts left).
 *  2. The held stock is made to last for the time to pay.
 *  3. The order moves from PENDING to PAYMENT_PROCESSING. This is the step that decides between
 *     this payment and a cancel or an expiry that arrive together: only one of them wins.
 *  4. The payment is written (INITIATED), in one short transaction that touches only Postgres.
 *  5. The gateway is asked to create the charge. This is the slow step and it is OUTSIDE any
 *     transaction, so no database connection is held while the gateway answers.
 *  6. What the gateway answered is stored, and the customer gets the link.
 *
 * A request sent again with the same key meets the payment it already made (the id comes from the
 * order and the key; the gateway recognises it by the same id): if that payment never got its
 * charge (the process died after step 4) the repeat finishes steps 5 and 6. The whole thing runs
 * under a lock per order, so two requests for one order take turns; the database, not the lock, is
 * what really guarantees there is one payment in progress per order.
 */
@CommandHandler(StartPaymentCommand)
export class StartPaymentHandler implements ICommandHandler<
  StartPaymentCommand,
  StartPaymentResult
> {
  private readonly logger = new Logger(StartPaymentHandler.name);

  constructor(
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
    private readonly lock: LockService,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @Inject(paymentsConfig.KEY) private readonly config: PaymentsConfig,
  ) {}

  async execute(command: StartPaymentCommand): Promise<StartPaymentResult> {
    if (!isValidIdempotencyKey(command.idempotencyKey)) {
      throw new PaymentDomainException(
        PaymentErrorCodes.INVALID_IDEMPOTENCY_KEY,
      );
    }
    return this.lock.run(
      `payment:start:${command.orderId}`,
      () => this.start(command),
      { ttlMs: LOCK_TTL_MS },
    );
  }

  private async start({
    userId,
    orderId,
    idempotencyKey,
  }: StartPaymentCommand): Promise<StartPaymentResult> {
    // 1. Somebody else's order is the same answer as no order (ORD-002)
    const order = await this.queryBus.execute<GetOrderQuery, Order>(
      new GetOrderQuery(userId, orderId),
    );

    // A request sent again gets its own payment back (and the charge it still lacks)
    const paymentId = derivePaymentId(orderId, idempotencyKey);
    const existing = await this.payments.findById(paymentId);
    if (existing) {
      return { payment: await this.completeCharge(existing), replayed: true };
    }

    if (order.paymentMethod !== PaymentMethod.ONLINE) {
      throw new PaymentDomainException(PaymentErrorCodes.NOT_ONLINE);
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new PaymentDomainException(PaymentErrorCodes.NOT_PAYABLE);
    }
    if ((await this.payments.countByOrder(orderId)) >= MAX_ATTEMPTS_PER_ORDER) {
      throw new PaymentDomainException(PaymentErrorCodes.TOO_MANY_ATTEMPTS);
    }

    // 2. The held stock lasts as long as the time to pay
    const expiresAt = await this.extendHold(orderId);

    // 3. The order starts being paid: the step that settles a race with a cancel or an expiry
    try {
      await this.commandBus.execute(
        new StartOrderPaymentCommand(orderId, expiresAt),
      );
    } catch (error) {
      if (hasCode(error, OrderErrorCodes.INVALID_STATE_TRANSITION.code)) {
        throw new PaymentDomainException(PaymentErrorCodes.NOT_PAYABLE);
      }
      throw error;
    }

    // 4. The payment, in one short transaction
    const payment = Payment.create({
      orderId,
      idempotencyKey,
      provider: this.gateway.name,
      amount: order.total,
      expiresAt,
    });
    try {
      await this.payments.create(payment);
    } catch (error) {
      return this.afterFailedCreate(error, payment);
    }

    // 5 and 6. The gateway, then what it answered
    return { payment: await this.completeCharge(payment), replayed: false };
  }

  /** Makes the hold last for the time to pay. A hold that is gone cannot be brought back. */
  private async extendHold(orderId: string): Promise<Date> {
    try {
      const extended = await this.commandBus.execute<
        ExtendReservationCommand,
        { expiresAt: Date }
      >(new ExtendReservationCommand(orderId, this.config.windowMinutes * 60));
      return extended.expiresAt;
    } catch (error) {
      if (
        hasCode(error, InventoryErrorCodes.EXTEND_NOT_ALLOWED.code) ||
        hasCode(error, InventoryErrorCodes.RESERVATION_NOT_FOUND.code)
      ) {
        throw new PaymentDomainException(PaymentErrorCodes.TIME_RAN_OUT);
      }
      throw error;
    }
  }

  /**
   * The payment could not be written. The order already moved to PAYMENT_PROCESSING, so it is put
   * back (best effort: the sweep reopens an order that has no payment in progress). If the cause
   * is another copy of the same request that wrote it first, that payment is the answer.
   */
  private async afterFailedCreate(
    error: unknown,
    payment: Payment,
  ): Promise<StartPaymentResult> {
    if (
      error instanceof PaymentAlreadyExistsError ||
      error instanceof PaymentInProgressError
    ) {
      const saved = await this.payments.findById(payment.id);
      if (saved) {
        return { payment: await this.completeCharge(saved), replayed: true };
      }
      await this.reopen(payment.orderId);
      throw new PaymentDomainException(PaymentErrorCodes.NOT_PAYABLE);
    }
    await this.reopen(payment.orderId);
    throw error;
  }

  /**
   * Asks the gateway for the charge and stores the answer. Safe to repeat (the gateway gives the
   * same charge for the same payment id). A payment that already has its charge, or is no longer
   * waiting for one, is returned as it is. A gateway that cannot be reached fails the payment and
   * opens the order again, so the customer can try with a new key.
   */
  private async completeCharge(payment: Payment): Promise<Payment> {
    if (payment.status !== PaymentStatus.INITIATED || payment.hasCharge) {
      return payment;
    }
    let charge;
    try {
      charge = await this.gateway.createCharge({
        paymentId: payment.id,
        orderId: payment.orderId,
        amount: payment.amount,
      });
    } catch (error) {
      if (
        error instanceof GatewayUnavailable ||
        error instanceof GatewayRejected
      ) {
        await this.failBecauseOfGateway(payment, error);
        throw new PaymentDomainException(PaymentErrorCodes.GATEWAY_UNAVAILABLE);
      }
      throw error;
    }

    await this.payments.attachCharge(
      payment.id,
      charge.providerRef,
      charge.payUrl,
    );
    return (await this.payments.findById(payment.id)) ?? payment;
  }

  private async failBecauseOfGateway(
    payment: Payment,
    cause: Error,
  ): Promise<void> {
    this.logger.warn(
      `Payment ${payment.id}: the gateway did not create the charge (${cause.message}); the payment is failed and the order opened again`,
    );
    try {
      const failed = await this.payments.transition(
        payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.FAILED,
        paymentFailedEvent(payment),
      );
      // Only the one that failed the payment opens the order again
      if (failed) await this.reopen(payment.orderId);
    } catch (error) {
      // The sweep expires a payment that is left INITIATED, and reopens the order after it
      this.logger.error(
        `Payment ${payment.id}: could not mark it failed (${(error as Error).message}); the sweep will deal with it`,
      );
    }
  }

  /** Never throws: an order left in PAYMENT_PROCESSING without a payment is reopened by the sweep. */
  private async reopen(orderId: string): Promise<void> {
    try {
      await this.commandBus.execute(new ReopenOrderCommand(orderId));
    } catch (error) {
      this.logger.error(
        `Order ${orderId} could not be opened again (${(error as Error).message}); the sweep will do it`,
      );
    }
  }
}
