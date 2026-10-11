import { describe, it, expect } from 'vitest';
import {
  computeTotal,
  deriveOrderId,
  isValidIdempotencyKey,
  lineTotal,
} from './order-identity.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveOrderId', () => {
  it('gives the same id for the same user and key, every time', () => {
    const first = deriveOrderId('user-1', 'checkout-attempt-0001');

    expect(deriveOrderId('user-1', 'checkout-attempt-0001')).toBe(first);
    expect(deriveOrderId('user-1', 'checkout-attempt-0001')).toBe(first);
  });

  it('gives another id for another key, or for another user with the same key', () => {
    const base = deriveOrderId('user-1', 'checkout-attempt-0001');

    expect(deriveOrderId('user-1', 'checkout-attempt-0002')).not.toBe(base);
    expect(deriveOrderId('user-2', 'checkout-attempt-0001')).not.toBe(base);
  });

  it('is written like a UUID', () => {
    expect(deriveOrderId('user-1', 'checkout-attempt-0001')).toMatch(UUID);
    expect(deriveOrderId('a'.repeat(100), 'k'.repeat(100))).toMatch(UUID);
  });

  it('cannot mix up two different (user, key) pairs that glue into the same text', () => {
    expect(deriveOrderId('user-1', '2-key-aaaaaaaa')).not.toBe(
      deriveOrderId('user-12', '-key-aaaaaaaa'),
    );
  });

  it('gives no collisions over many keys', () => {
    const ids = new Set(
      Array.from({ length: 5000 }, (_, i) =>
        deriveOrderId('user-1', `key-${i}-xxxxxxxx`),
      ),
    );
    expect(ids.size).toBe(5000);
  });
});

describe('isValidIdempotencyKey (AC-4)', () => {
  it.each([
    '12345678',
    'abcdefgh',
    'checkout_attempt-0001',
    '123e4567-e89b-12d3-a456-426614174000', // a UUID
    'A'.repeat(100),
  ])('accepts %s', (key) => {
    expect(isValidIdempotencyKey(key)).toBe(true);
  });

  it.each([
    '',
    '1234567', // 7 characters
    'A'.repeat(101),
    'has space in it',
    'dots.are.not.allowed',
    'slash/not/allowed',
    'tiếng-việt-không-được',
    'emoji-🙂-nope-nope',
    'new\nline-1234',
  ])('refuses %j', (key) => {
    expect(isValidIdempotencyKey(key)).toBe(false);
  });

  it.each([undefined, null, 12345678, {}, ['abcdefgh']])(
    'refuses a value that is not text: %j',
    (key) => {
      expect(isValidIdempotencyKey(key)).toBe(false);
    },
  );
});

describe('money', () => {
  it('multiplies a price by a quantity exactly', () => {
    expect(lineTotal(199000.5, 3)).toBe(597001.5);
    expect(lineTotal(0.1, 3)).toBe(0.3); // 0.1 * 3 is 0.30000000000000004 in plain floating point
    expect(lineTotal(3990000, 2)).toBe(7980000);
    expect(lineTotal(0, 5)).toBe(0);
  });

  it('adds lines up exactly', () => {
    expect(
      computeTotal([
        { unitPrice: 199000.5, quantity: 3 },
        { unitPrice: 0.1, quantity: 7 },
      ]),
    ).toBe(597002.2);
    expect(
      computeTotal([
        { unitPrice: 0.1, quantity: 1 },
        { unitPrice: 0.2, quantity: 1 },
      ]),
    ).toBe(0.3);
  });

  it('is zero for no lines', () => {
    expect(computeTotal([])).toBe(0);
  });

  it('handles the biggest sums an order can have (50 lines of 99 x 99,999,999.99) without losing a cent', () => {
    const lines = Array.from({ length: 50 }, () => ({
      unitPrice: 99999999.99,
      quantity: 99,
    }));

    // 99 x 99,999,999.99 = 9,899,999,999.01 a line; fifty lines = 494,999,999,950.50
    expect(computeTotal(lines)).toBe(494999999950.5);
  });
});
