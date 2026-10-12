import { describe, it, expect } from 'vitest';
import { PaymentErrorCodes } from '@/core/index.js';
import { PaymentStatus } from '../payment-status.js';
import { derivePaymentId } from '../services/payment-identity.js';
import {
  MAX_ATTEMPTS_PER_ORDER,
  MAX_PAYMENT_AMOUNT,
  Payment,
} from './payment.entity.js';

const EXPIRES = new Date('2026-10-12T10:15:00.000Z');
const make = (overrides: Partial<Parameters<typeof Payment.create>[0]> = {}) =>
  Payment.create({
    orderId: 'order-1',
    idempotencyKey: 'pay-attempt-0001',
    provider: 'fake',
    amount: 3990000,
    expiresAt: EXPIRES,
    ...overrides,
  });
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error: any) {
    return error.code as string;
  }
  throw new Error('should have thrown');
};

describe('Payment.create', () => {
  it('starts INITIATED at version 1, with no charge and nothing collected', () => {
    const now = new Date('2026-10-12T10:00:00.000Z');

    const payment = make({ now });

    expect(payment).toMatchObject({
      id: derivePaymentId('order-1', 'pay-attempt-0001'),
      orderId: 'order-1',
      idempotencyKey: 'pay-attempt-0001',
      provider: 'fake',
      status: PaymentStatus.INITIATED,
      version: 1,
      amount: 3990000,
      paidAmount: null,
      providerRef: null,
      payUrl: null,
      expiresAt: EXPIRES,
      createdAt: now,
      updatedAt: now,
    });
    expect(payment.hasCharge).toBe(false);
  });

  it('gives the same id for the same order and key', () => {
    expect(make().id).toBe(make().id);
    expect(make({ idempotencyKey: 'pay-attempt-0002' }).id).not.toBe(make().id);
  });

  it('keeps an amount to the hundredth', () => {
    expect(make({ amount: 199000.5 }).amount).toBe(199000.5);
    expect(make({ amount: 0.1 + 0.2 }).amount).toBe(0.3);
  });

  it.each([
    '',
    'short',
    'has space in it',
    'x'.repeat(101),
    'dots.not.ok',
    undefined as never,
    12345678 as never,
  ])('refuses the key %j with PAY-001', (key) => {
    expect(codeOf(() => make({ idempotencyKey: key }))).toBe(
      PaymentErrorCodes.INVALID_IDEMPOTENCY_KEY.code,
    );
  });

  it.each([
    ['no order', { orderId: '' }],
    ['no gateway name', { provider: '' }],
    ['a gateway name that is too long', { provider: 'g'.repeat(31) }],
    ['no money', { amount: 0 }],
    ['negative money', { amount: -5 }],
    ['money that is not a number', { amount: Number.NaN }],
    ['infinite money', { amount: Number.POSITIVE_INFINITY }],
    [
      'more money than the database can hold',
      { amount: MAX_PAYMENT_AMOUNT + 0.01 },
    ],
    ['a time to pay that is not a time', { expiresAt: new Date('nope') }],
  ])('refuses %s with PAY-000', (_, bad) => {
    expect(codeOf(() => make(bad))).toBe(
      PaymentErrorCodes.DOMAIN_EXCEPTION.code,
    );
  });

  it('accepts the most the database can hold', () => {
    expect(make({ amount: MAX_PAYMENT_AMOUNT }).amount).toBe(
      MAX_PAYMENT_AMOUNT,
    );
  });
});

describe('Payment.restore and what it can tell', () => {
  const restored = (overrides: Record<string, unknown> = {}) =>
    Payment.restore({
      id: 'p1',
      orderId: 'order-1',
      idempotencyKey: 'pay-attempt-0001',
      provider: 'fake',
      status: PaymentStatus.SUCCEEDED,
      version: 3,
      amount: 1000,
      paidAmount: null,
      providerRef: 'ref-1',
      payUrl: 'https://pay',
      expiresAt: EXPIRES,
      createdAt: EXPIRES,
      updatedAt: EXPIRES,
      ...overrides,
    });

  it('knows whether the gateway has been asked', () => {
    expect(restored().hasCharge).toBe(true);
    expect(restored({ providerRef: null }).hasCharge).toBe(false);
  });

  it('knows which moves it may make', () => {
    expect(restored().canMoveTo(PaymentStatus.REFUND_PENDING)).toBe(true);
    expect(restored().canMoveTo(PaymentStatus.FAILED)).toBe(false);
    expect(
      restored({ status: PaymentStatus.FAILED }).canMoveTo(
        PaymentStatus.SUCCEEDED,
      ),
    ).toBe(true);
  });

  it('refunds what was really collected, not what the order costs', () => {
    expect(restored({ paidAmount: 1000 }).refundAmount).toBe(1000);
    expect(restored({ paidAmount: 1 }).refundAmount).toBe(1);
    expect(restored({ paidAmount: 5000 }).refundAmount).toBe(5000);
    expect(restored({ paidAmount: null }).refundAmount).toBe(1000);
  });
});

describe('the limit of attempts', () => {
  it('is three for one order', () => {
    expect(MAX_ATTEMPTS_PER_ORDER).toBe(3);
  });
});
