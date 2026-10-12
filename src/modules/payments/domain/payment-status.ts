export enum PaymentStatus {
  /** The customer started paying and the gateway has not said how it went. */
  INITIATED = 'INITIATED',
  /** The money came in. */
  SUCCEEDED = 'SUCCEEDED',
  /** The gateway said the payment did not work. */
  FAILED = 'FAILED',
  /** The time to pay ran out and the gateway never said the money came in. */
  EXPIRED = 'EXPIRED',
  /** The money has to go back: the goods cannot be delivered, the amount was wrong, or the order was cancelled. */
  REFUND_PENDING = 'REFUND_PENDING',
  /** The money went back. */
  REFUNDED = 'REFUNDED',
}

/**
 * Every move a payment may make, and nothing else is allowed:
 *
 *   INITIATED ──▶ SUCCEEDED ──▶ REFUND_PENDING ──▶ REFUNDED
 *       │            ▲
 *       ├──▶ FAILED ─┤        (the money turned out to have come in after all)
 *       └──▶ EXPIRED ┘
 *
 * "The money wins": a FAILED or EXPIRED payment becomes SUCCEEDED if the gateway later says the
 * money came in, because the money is real. The other way round never happens: a report of failure
 * that arrives after the money was reported changes nothing (SUCCEEDED cannot go back).
 */
export const TRANSITIONS: ReadonlyArray<
  readonly [PaymentStatus, PaymentStatus]
> = [
  [PaymentStatus.INITIATED, PaymentStatus.SUCCEEDED],
  [PaymentStatus.INITIATED, PaymentStatus.FAILED],
  [PaymentStatus.INITIATED, PaymentStatus.EXPIRED],
  [PaymentStatus.FAILED, PaymentStatus.SUCCEEDED],
  [PaymentStatus.EXPIRED, PaymentStatus.SUCCEEDED],
  [PaymentStatus.SUCCEEDED, PaymentStatus.REFUND_PENDING],
  [PaymentStatus.REFUND_PENDING, PaymentStatus.REFUNDED],
];

/** Statuses from which a payment can still move: those that lead somewhere. */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** The statuses a payment may be in just before it becomes `to`. */
export function statusesBefore(to: PaymentStatus): PaymentStatus[] {
  return TRANSITIONS.filter(([, t]) => t === to).map(([f]) => f);
}
