import type { OutboxEventDraft } from '../../../orders/domain/index.js';
import type { Payment } from '../entities/payment.entity.js';
import type { PaymentStatus } from '../payment-status.js';

/** Thrown by `create` when a payment with this id (or this order and key) already exists. */
export class PaymentAlreadyExistsError extends Error {
  constructor(paymentId: string) {
    super(`Payment ${paymentId} already exists`);
    this.name = 'PaymentAlreadyExistsError';
  }
}

/** Thrown by `create` when the order already has a payment waiting for the gateway. */
export class PaymentInProgressError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} already has a payment in progress`);
    this.name = 'PaymentInProgressError';
  }
}

/** A payment still waiting for the gateway, as the sweep that asks the gateway about it sees it. */
export interface InitiatedPayment {
  id: string;
  /** Its time to pay has run out. */
  pastDeadline: boolean;
}

export interface PaymentMove {
  /** What was really collected, when the move is to SUCCEEDED. */
  paidAmount?: number;
}

/**
 * Payments in Postgres. Everything that writes is ONE short transaction that touches Postgres and
 * nothing else (no gateway, no other module), so a connection is held only for a few statements.
 * Every change of status is one conditional UPDATE (`WHERE status IN (<old statuses>)`) together
 * with its event in the outbox: when two changes reach the same payment together, one of them
 * changes the row and the other finds nothing left to change.
 */
export interface IPaymentRepository {
  findById(paymentId: string): Promise<Payment | null>;

  findByProviderRef(
    provider: string,
    providerRef: string,
  ): Promise<Payment | null>;

  /** The payments of an order, newest first. */
  listByOrder(orderId: string): Promise<Payment[]>;

  /** How many payments the order has had, in any status. */
  countByOrder(orderId: string): Promise<number>;

  /**
   * Writes a new INITIATED payment. Throws `PaymentAlreadyExistsError` when the id (or the order
   * and key) is taken, and `PaymentInProgressError` when the order already has an INITIATED one:
   * the database refuses a second one.
   */
  create(payment: Payment): Promise<void>;

  /**
   * Records what the gateway answered to `createCharge`. Only while the payment is INITIATED and
   * has no charge yet; returns whether it did. Safe to repeat.
   */
  attachCharge(
    paymentId: string,
    providerRef: string,
    payUrl: string,
  ): Promise<boolean>;

  /**
   * Moves the payment to `to` and writes the event, in one transaction, only if it is still in one
   * of the statuses `from`. Returns the payment as it is now, or null when it was in none of them
   * (or does not exist).
   */
  transition(
    paymentId: string,
    from: readonly PaymentStatus[],
    to: PaymentStatus,
    event: OutboxEventDraft | null,
    move?: PaymentMove,
  ): Promise<Payment | null>;

  // ── what the sweeps look for (all by the database clock) ──────────────────

  /**
   * Payments still INITIATED that were created more than this many seconds ago, oldest first, each
   * with whether its time to pay has run out (the database clock decides, not this machine's).
   */
  findInitiatedForReconcile(
    olderThanSeconds: number,
    limit: number,
  ): Promise<InitiatedPayment[]>;

  /**
   * SUCCEEDED payments whose order is still PAYMENT_PROCESSING, last changed more than this many
   * seconds ago: the confirmation of the order was cut short.
   */
  findPaidButOrderStillPayingIds(
    olderThanSeconds: number,
    limit: number,
  ): Promise<string[]>;

  /**
   * Payments whose money has to go back: REFUND_PENDING, and SUCCEEDED ones whose order is
   * CANCELLED or EXPIRED.
   */
  findRefundableIds(limit: number): Promise<string[]>;

  /** Whether the order has a payment that is INITIATED or SUCCEEDED (one that is, or was, alive). */
  hasLivePayment(orderId: string): Promise<boolean>;
}

/** Messages this system has already handled, so that one delivered twice is handled once. */
export interface IInboxStore {
  /**
   * Notes that `messageId` from `source` is being handled. Returns false when it was already
   * noted (a repeat), true when this is the first time.
   */
  record(source: string, messageId: string): Promise<boolean>;

  /**
   * Takes a message back out, for a handler that failed after noting it: the sender will send it
   * again, and the repeat must be handled, not thrown away as "already seen".
   */
  forget(source: string, messageId: string): Promise<void>;
}
