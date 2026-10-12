import { describe, it, expect } from 'vitest';
import {
  FINAL_STATUSES,
  OrderStatus,
  PaymentMethod,
  TRANSITIONS,
  canTransition,
} from './order-status.js';

const {
  PENDING,
  PAYMENT_PROCESSING,
  CONFIRMED,
  SHIPPING,
  DELIVERED,
  CANCELLED,
  EXPIRED,
} = OrderStatus;
const { ONLINE, COD } = PaymentMethod;

/** The whole table, written out once more here on purpose: the test is the second opinion. */
const ALLOWED: Record<PaymentMethod, Array<[OrderStatus, OrderStatus]>> = {
  [ONLINE]: [
    [PENDING, PAYMENT_PROCESSING],
    [PAYMENT_PROCESSING, CONFIRMED],
    [PAYMENT_PROCESSING, PENDING],
    [PAYMENT_PROCESSING, EXPIRED],
    [PENDING, CANCELLED],
    [PENDING, EXPIRED],
    [CONFIRMED, CANCELLED],
    [CONFIRMED, SHIPPING],
    [SHIPPING, DELIVERED],
  ],
  [COD]: [
    [PENDING, CONFIRMED],
    [PENDING, CANCELLED],
    [PENDING, EXPIRED],
    [CONFIRMED, CANCELLED],
    [CONFIRMED, SHIPPING],
    [SHIPPING, DELIVERED],
  ],
};

const ALL = Object.values(OrderStatus);

describe('canTransition (AC-9)', () => {
  for (const method of [ONLINE, COD]) {
    describe(`an order paid ${method}`, () => {
      it('allows exactly the steps of the table', () => {
        const allowed: string[] = [];
        for (const from of ALL) {
          for (const to of ALL) {
            if (canTransition(from, to, method)) allowed.push(`${from}>${to}`);
          }
        }
        expect(allowed.sort()).toEqual(
          ALLOWED[method].map(([from, to]) => `${from}>${to}`).sort(),
        );
      });

      it.each(ALLOWED[method])('allows %s to %s', (from, to) => {
        expect(canTransition(from, to, method)).toBe(true);
      });
    });
  }

  it('refuses every pair that is not in the table: 49 pairs, only the allowed ones are true', () => {
    // 7 statuses x 7 = 49 pairs for each payment method
    let allowed = 0;
    for (const method of [ONLINE, COD]) {
      for (const from of ALL) {
        for (const to of ALL) {
          if (canTransition(from, to, method)) allowed++;
        }
      }
    }
    expect(allowed).toBe(ALLOWED[ONLINE].length + ALLOWED[COD].length);
  });

  it.each([
    ['an order does not stay where it is', PENDING, PENDING, ONLINE],
    [
      'an online order is not confirmed without being paid',
      PENDING,
      CONFIRMED,
      ONLINE,
    ],
    [
      'a cash on delivery order has no payment step',
      PENDING,
      PAYMENT_PROCESSING,
      COD,
    ],
    [
      'a cash on delivery order has no payment to finish',
      PAYMENT_PROCESSING,
      CONFIRMED,
      COD,
    ],
    ['a cancelled order does not come back', CANCELLED, PENDING, ONLINE],
    ['an expired order does not come back', EXPIRED, PENDING, COD],
    ['a delivered order stays delivered', DELIVERED, CANCELLED, ONLINE],
    ['nothing is shipped before it is confirmed', PENDING, SHIPPING, COD],
    ['a shipped order cannot be cancelled any more', SHIPPING, CANCELLED, COD],
    [
      'a shipped order does not go back to confirmed',
      SHIPPING,
      CONFIRMED,
      ONLINE,
    ],
    [
      'an order is not delivered without being shipped',
      CONFIRMED,
      DELIVERED,
      COD,
    ],
    [
      'an order that is being paid cannot simply be cancelled',
      PAYMENT_PROCESSING,
      CANCELLED,
      ONLINE,
    ],
    [
      'a cash on delivery order is never being paid, so it cannot expire from there',
      PAYMENT_PROCESSING,
      EXPIRED,
      COD,
    ],
    ['a confirmed order does not expire', CONFIRMED, EXPIRED, COD],
  ])('refuses: %s', (_, from, to, method) => {
    expect(canTransition(from, to, method)).toBe(false);
  });

  it('lets a customer cancel before delivery, whatever the payment method', () => {
    for (const method of [ONLINE, COD]) {
      expect(canTransition(PENDING, CANCELLED, method)).toBe(true);
      expect(canTransition(CONFIRMED, CANCELLED, method)).toBe(true);
    }
  });
});

describe('the table itself', () => {
  it('has no step that leaves a final status', () => {
    for (const step of TRANSITIONS) {
      expect(FINAL_STATUSES).not.toContain(step.from);
    }
  });

  it('has no step listed twice', () => {
    const keys = TRANSITIONS.map((s) => `${s.from}>${s.to}>${s.only ?? '*'}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks exactly DELIVERED, CANCELLED and EXPIRED as final', () => {
    expect([...FINAL_STATUSES].sort()).toEqual(
      [CANCELLED, DELIVERED, EXPIRED].sort(),
    );
  });

  it('lets every non-final status go somewhere, so no order is stuck', () => {
    for (const status of ALL.filter((s) => !FINAL_STATUSES.includes(s))) {
      expect(TRANSITIONS.some((step) => step.from === status)).toBe(true);
    }
  });
});
