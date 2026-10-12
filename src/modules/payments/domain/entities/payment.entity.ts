import { PaymentErrorCodes } from '@/core/index.js';
// Pure helpers of the order module: the same key rule and the same money rule, written once
import {
  isValidIdempotencyKey,
  toCents,
} from '../../../orders/domain/index.js';
import { PaymentDomainException } from '../exceptions/payment.exception.js';
import { PaymentStatus, canTransition } from '../payment-status.js';
import { derivePaymentId } from '../services/payment-identity.js';

/** How many times a customer may try to pay one order (each try that is not a replay counts). */
export const MAX_ATTEMPTS_PER_ORDER = 3;
/** The most the amount column can hold: Decimal(12,2). */
export const MAX_PAYMENT_AMOUNT = 9_999_999_999.99;

const refuse = (reason: string): never => {
  throw new PaymentDomainException(PaymentErrorCodes.DOMAIN_EXCEPTION, {
    reason,
  });
};

/**
 * One attempt to pay an online order. Changing the status does NOT happen here: it is one
 * conditional SQL update in the repository (`WHERE status = <old status>`), so that when two
 * things reach the same payment together (a webhook and the sweep, say) exactly one of them wins.
 */
export class Payment {
  private constructor(
    public readonly id: string,
    public readonly orderId: string,
    public readonly idempotencyKey: string,
    public readonly provider: string,
    public readonly status: PaymentStatus,
    public readonly version: number,
    /** What the order costs. */
    public readonly amount: number,
    /** What the gateway says it really took; null until money comes in. A refund is of this. */
    public readonly paidAmount: number | null,
    /** The gateway's own id for the charge; null until the gateway has answered. */
    public readonly providerRef: string | null,
    /** Where the customer pays; null until the gateway has answered. */
    public readonly payUrl: string | null,
    /** When the time to pay runs out. */
    public readonly expiresAt: Date,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  /**
   * A new INITIATED payment. Its id comes from the order and the Idempotency-Key. Throws
   * `PAY-001` for a key that is not acceptable and `PAY-000` for anything else that is wrong (a
   * mistake in the caller: the amount comes from an order that was checked).
   */
  static create(params: {
    orderId: string;
    idempotencyKey: string;
    provider: string;
    amount: number;
    expiresAt: Date;
    now?: Date;
  }): Payment {
    if (!isValidIdempotencyKey(params.idempotencyKey)) {
      throw new PaymentDomainException(
        PaymentErrorCodes.INVALID_IDEMPOTENCY_KEY,
      );
    }
    if (typeof params.orderId !== 'string' || params.orderId === '') {
      refuse('A payment needs an order');
    }
    if (
      typeof params.provider !== 'string' ||
      params.provider === '' ||
      params.provider.length > 30
    ) {
      refuse('A payment needs the name of its gateway (at most 30 characters)');
    }
    if (
      !Number.isFinite(params.amount) ||
      params.amount <= 0 ||
      params.amount > MAX_PAYMENT_AMOUNT
    ) {
      refuse('The amount must be more than 0 and fit the database');
    }
    if (
      !(params.expiresAt instanceof Date) ||
      Number.isNaN(params.expiresAt.getTime())
    ) {
      refuse('Invalid time to pay');
    }

    const now = params.now ?? new Date();
    return new Payment(
      derivePaymentId(params.orderId, params.idempotencyKey),
      params.orderId,
      params.idempotencyKey,
      params.provider,
      PaymentStatus.INITIATED,
      1,
      toCents(params.amount) / 100,
      null,
      null,
      null,
      params.expiresAt,
      now,
      now,
    );
  }

  /** Rebuilds a payment read from the database (nothing is checked again). */
  static restore(data: {
    id: string;
    orderId: string;
    idempotencyKey: string;
    provider: string;
    status: PaymentStatus;
    version: number;
    amount: number;
    paidAmount: number | null;
    providerRef: string | null;
    payUrl: string | null;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }): Payment {
    return new Payment(
      data.id,
      data.orderId,
      data.idempotencyKey,
      data.provider,
      data.status,
      data.version,
      data.amount,
      data.paidAmount,
      data.providerRef,
      data.payUrl,
      data.expiresAt,
      data.createdAt,
      data.updatedAt,
    );
  }

  /** Whether this payment may move to `to` from where it is now. */
  canMoveTo(to: PaymentStatus): boolean {
    return canTransition(this.status, to);
  }

  /** The gateway has been asked to create the charge and answered. */
  get hasCharge(): boolean {
    return this.providerRef !== null;
  }

  /** What goes back to the customer on a refund: what was really collected. */
  get refundAmount(): number {
    return this.paidAmount ?? this.amount;
  }
}
