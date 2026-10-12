import { describe, it, expect } from 'vitest';
import { deriveOrderId } from '../../../orders/domain/index.js';
import { derivePaymentId, sameAmount } from './payment-identity.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('derivePaymentId', () => {
  it('gives the same id for the same order and key, every time', () => {
    const first = derivePaymentId('order-1', 'pay-attempt-0001');

    expect(derivePaymentId('order-1', 'pay-attempt-0001')).toBe(first);
  });

  it('gives another id for another key, or for another order with the same key', () => {
    const base = derivePaymentId('order-1', 'pay-attempt-0001');

    expect(derivePaymentId('order-1', 'pay-attempt-0002')).not.toBe(base);
    expect(derivePaymentId('order-2', 'pay-attempt-0001')).not.toBe(base);
  });

  it('is written like a UUID', () => {
    expect(derivePaymentId('order-1', 'pay-attempt-0001')).toMatch(UUID);
    expect(derivePaymentId('o'.repeat(100), 'k'.repeat(100))).toMatch(UUID);
  });

  it('cannot mix up two different (order, key) pairs that glue into the same text', () => {
    expect(derivePaymentId('order-1', '2-key-aaaaaaaa')).not.toBe(
      derivePaymentId('order-12', '-key-aaaaaaaa'),
    );
  });

  it('is not the id of an order made from the same two words', () => {
    expect(derivePaymentId('user-1', 'checkout-key-0001')).not.toBe(
      deriveOrderId('user-1', 'checkout-key-0001'),
    );
  });

  it('gives no collisions over many keys', () => {
    const ids = new Set(
      Array.from({ length: 5000 }, (_, i) =>
        derivePaymentId('order-1', `key-${i}-xxxxxxxx`),
      ),
    );
    expect(ids.size).toBe(5000);
  });
});

describe('sameAmount', () => {
  it.each([
    [3990000, 3990000, true],
    [199000.5, 199000.5, true],
    [0.1 + 0.2, 0.3, true], // not equal in plain floating point
    [3990000, 3990000.01, false],
    [1000, 1, false],
    [1000000, 1000, false],
    [0.004, 0, true], // below a hundredth rounds away
  ])('%s and %s: %s', (a, b, expected) => {
    expect(sameAmount(a, b)).toBe(expected);
  });
});
