import { describe, it, expect } from 'vitest';
import {
  PAYMENT_EXPIRED,
  PAYMENT_FAILED,
  PAYMENT_REFUNDED,
  PAYMENT_SUCCEEDED,
  eventForMove,
  paymentExpiredEvent,
  paymentFailedEvent,
  paymentRefundedEvent,
  paymentSucceededEvent,
} from './payment-events.js';

const PAYMENT = {
  id: 'pay-1',
  orderId: 'order-1',
  amount: 150000,
  paidAmount: null,
};

describe('payment events', () => {
  it('carry the ids and the amount, under the payment as their aggregate', () => {
    expect(paymentSucceededEvent(PAYMENT, 150000)).toMatchObject({
      type: PAYMENT_SUCCEEDED,
      aggregateId: 'pay-1',
      payload: { paymentId: 'pay-1', orderId: 'order-1', amount: 150000 },
    });
    expect(paymentFailedEvent(PAYMENT)).toMatchObject({
      type: PAYMENT_FAILED,
      payload: { amount: 150000 },
    });
    expect(paymentExpiredEvent(PAYMENT)).toMatchObject({
      type: PAYMENT_EXPIRED,
      payload: { amount: 150000 },
    });
    expect(paymentRefundedEvent(PAYMENT, 1000)).toMatchObject({
      type: PAYMENT_REFUNDED,
      payload: { amount: 1000 },
    });
  });

  it('has names that a listener can ask for with payment.*', () => {
    for (const name of [
      PAYMENT_SUCCEEDED,
      PAYMENT_FAILED,
      PAYMENT_EXPIRED,
      PAYMENT_REFUNDED,
    ]) {
      expect(name).toMatch(/^payment\.[a-z_]+$/);
    }
  });

  it('gives each event its own id, so a receiver can tell two apart and drop a repeat of one', () => {
    expect(paymentFailedEvent(PAYMENT).id).not.toBe(
      paymentFailedEvent(PAYMENT).id,
    );
  });

  it('says what was really collected for a success, and what went back for a refund', () => {
    expect(paymentSucceededEvent(PAYMENT, 1000).payload.amount).toBe(1000);
    expect(
      eventForMove({ ...PAYMENT, paidAmount: 1000 }, 'REFUNDED').payload.amount,
    ).toBe(1000);
    expect(eventForMove(PAYMENT, 'REFUNDED').payload.amount).toBe(150000);
    expect(eventForMove(PAYMENT, 'SUCCEEDED', 1000).payload.amount).toBe(1000);
    expect(eventForMove(PAYMENT, 'SUCCEEDED').payload.amount).toBe(150000);
  });

  it('picks the event for a move', () => {
    expect(eventForMove(PAYMENT, 'FAILED').type).toBe(PAYMENT_FAILED);
    expect(eventForMove(PAYMENT, 'EXPIRED').type).toBe(PAYMENT_EXPIRED);
  });

  it('never carry the gateway reference, the payment link, or anything personal', () => {
    const everything = JSON.stringify([
      paymentSucceededEvent(
        {
          ...PAYMENT,
          providerRef: 'secret-ref',
          payUrl: 'https://pay',
        } as never,
        1,
      ),
      paymentFailedEvent({ ...PAYMENT, providerRef: 'secret-ref' } as never),
      paymentExpiredEvent(PAYMENT),
      paymentRefundedEvent(PAYMENT, 1),
    ]);

    expect(everything).not.toContain('secret-ref');
    expect(everything).not.toContain('https://pay');
    expect(Object.keys(paymentFailedEvent(PAYMENT).payload).sort()).toEqual([
      'amount',
      'orderId',
      'paymentId',
    ]);
  });
});
