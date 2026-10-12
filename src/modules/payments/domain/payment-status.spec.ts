import { describe, it, expect } from 'vitest';
import {
  PaymentStatus,
  TRANSITIONS,
  canTransition,
  statusesBefore,
} from './payment-status.js';

const { INITIATED, SUCCEEDED, FAILED, EXPIRED, REFUND_PENDING, REFUNDED } =
  PaymentStatus;
const ALL = Object.values(PaymentStatus);

/** The whole table, written out once more here on purpose: the test is the second opinion. */
const ALLOWED: Array<[PaymentStatus, PaymentStatus]> = [
  [INITIATED, SUCCEEDED],
  [INITIATED, FAILED],
  [INITIATED, EXPIRED],
  [FAILED, SUCCEEDED],
  [EXPIRED, SUCCEEDED],
  [SUCCEEDED, REFUND_PENDING],
  [REFUND_PENDING, REFUNDED],
];

describe('canTransition', () => {
  it.each(ALLOWED)('allows %s to %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('refuses every pair that is not in the table: 36 pairs, only the allowed ones are true', () => {
    let allowed = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        if (canTransition(from, to)) allowed++;
      }
    }
    expect(ALL).toHaveLength(6);
    expect(allowed).toBe(ALLOWED.length);
  });

  it.each([
    ['a payment does not stay where it is', INITIATED, INITIATED],
    [
      'a report of failure after the money came in changes nothing',
      SUCCEEDED,
      FAILED,
    ],
    ['money that came in is not "not paid" later', SUCCEEDED, EXPIRED],
    ['money that came in does not go back to waiting', SUCCEEDED, INITIATED],
    [
      'a failed payment does not start again (a new one is made instead)',
      FAILED,
      INITIATED,
    ],
    ['an expired payment does not start again', EXPIRED, INITIATED],
    [
      'a failed payment is not refunded: no money came in',
      FAILED,
      REFUND_PENDING,
    ],
    [
      'an expired payment is not refunded: no money came in',
      EXPIRED,
      REFUND_PENDING,
    ],
    ['nothing is refunded before it was paid', INITIATED, REFUND_PENDING],
    ['a refund is not skipped', SUCCEEDED, REFUNDED],
    ['a refund does not go back', REFUNDED, REFUND_PENDING],
    ['a refunded payment is not paid again', REFUNDED, SUCCEEDED],
    [
      'a refund that is waiting does not turn back into a payment',
      REFUND_PENDING,
      SUCCEEDED,
    ],
  ])('refuses: %s', (_, from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe('the table itself', () => {
  it('has no step listed twice', () => {
    const keys = TRANSITIONS.map(([f, t]) => `${f}>${t}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has no step that leaves REFUNDED', () => {
    expect(TRANSITIONS.filter(([from]) => from === REFUNDED)).toEqual([]);
  });

  it('lets money win: the only way out of FAILED and of EXPIRED is to SUCCEEDED', () => {
    for (const from of [FAILED, EXPIRED]) {
      expect(TRANSITIONS.filter(([f]) => f === from).map(([, t]) => t)).toEqual(
        [SUCCEEDED],
      );
    }
  });

  it('every status is reachable from INITIATED', () => {
    const seen = new Set<PaymentStatus>([INITIATED]);
    for (let round = 0; round < ALL.length; round++) {
      for (const [from, to] of TRANSITIONS) if (seen.has(from)) seen.add(to);
    }
    expect([...seen].sort()).toEqual([...ALL].sort());
  });
});

describe('statusesBefore', () => {
  it('lists the statuses a payment may be in just before a move', () => {
    expect(statusesBefore(SUCCEEDED).sort()).toEqual(
      [EXPIRED, FAILED, INITIATED].sort(),
    );
    expect(statusesBefore(FAILED)).toEqual([INITIATED]);
    expect(statusesBefore(EXPIRED)).toEqual([INITIATED]);
    expect(statusesBefore(REFUND_PENDING)).toEqual([SUCCEEDED]);
    expect(statusesBefore(REFUNDED)).toEqual([REFUND_PENDING]);
    expect(statusesBefore(INITIATED)).toEqual([]);
  });
});
