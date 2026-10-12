import { randomUUID } from 'crypto';
import type { OutboxEventDraft } from '../../../orders/domain/index.js';
import type { Payment } from '../entities/payment.entity.js';

/**
 * Events written to the outbox in the same transaction as the change they report (the same table
 * the order module uses; the publisher sends them all). They carry the ids and the amount and nothing
 * else: no gateway reference, no payment link, no personal data, because an event is copied to
 * every listener.
 */
export const PAYMENT_SUCCEEDED = 'payment.succeeded';
export const PAYMENT_FAILED = 'payment.failed';
export const PAYMENT_EXPIRED = 'payment.expired';
export const PAYMENT_REFUNDED = 'payment.refunded';

const draft = (
  type: string,
  payment: Pick<Payment, 'id' | 'orderId'>,
  amount: number,
): OutboxEventDraft => ({
  id: randomUUID(),
  type,
  aggregateId: payment.id,
  payload: { paymentId: payment.id, orderId: payment.orderId, amount },
});

/** `amount` is what was really collected. */
export const paymentSucceededEvent = (
  payment: Pick<Payment, 'id' | 'orderId'>,
  collected: number,
) => draft(PAYMENT_SUCCEEDED, payment, collected);

export const paymentFailedEvent = (
  payment: Pick<Payment, 'id' | 'orderId' | 'amount'>,
) => draft(PAYMENT_FAILED, payment, payment.amount);

export const paymentExpiredEvent = (
  payment: Pick<Payment, 'id' | 'orderId' | 'amount'>,
) => draft(PAYMENT_EXPIRED, payment, payment.amount);

/** `amount` is what went back to the customer. */
export const paymentRefundedEvent = (
  payment: Pick<Payment, 'id' | 'orderId'>,
  refunded: number,
) => draft(PAYMENT_REFUNDED, payment, refunded);

/**
 * The event that goes with a move to `to`. A move to REFUND_PENDING reports nothing (the refund is
 * not done yet): the order has its own event and the refund has its own at the end.
 */
export function eventForMove(
  payment: Pick<Payment, 'id' | 'orderId' | 'amount' | 'paidAmount'>,
  to: 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'REFUNDED',
  collected?: number,
): OutboxEventDraft {
  switch (to) {
    case 'SUCCEEDED':
      return paymentSucceededEvent(payment, collected ?? payment.amount);
    case 'FAILED':
      return paymentFailedEvent(payment);
    case 'EXPIRED':
      return paymentExpiredEvent(payment);
    case 'REFUNDED':
      return paymentRefundedEvent(
        payment,
        payment.paidAmount ?? payment.amount,
      );
  }
}
