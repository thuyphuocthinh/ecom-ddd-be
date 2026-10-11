export enum OrderStatus {
  /** Placed, waiting to be paid (online) or to be confirmed (cash on delivery). */
  PENDING = 'PENDING',
  /** An online payment is running. */
  PAYMENT_PROCESSING = 'PAYMENT_PROCESSING',
  /** Paid, or cash on delivery accepted: the stock was taken out of the warehouse. */
  CONFIRMED = 'CONFIRMED',
  SHIPPING = 'SHIPPING',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export enum PaymentMethod {
  /** Paid before the goods leave. */
  ONLINE = 'ONLINE',
  /** Cash on delivery: nothing to wait for, the order is confirmed at once. */
  COD = 'COD',
}

interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  /** Only orders paid this way may take this step; absent means both. */
  only?: PaymentMethod;
}

/**
 * Every move an order may make, and nothing else is allowed:
 *
 *   PENDING ──(COD)──────────────▶ CONFIRMED ──▶ SHIPPING ──▶ DELIVERED
 *      │                               │
 *      ├─(ONLINE)─▶ PAYMENT_PROCESSING ─(ONLINE)─▶ CONFIRMED
 *      │                  └─(ONLINE)─▶ PENDING     (the payment failed, try again)
 *      ├──▶ CANCELLED ◀────────────────┘            (the customer cancels before delivery)
 *      └──▶ EXPIRED                                 (not paid in time, or the held stock was lost)
 *
 * DELIVERED, CANCELLED and EXPIRED are final. Nothing in this module moves an order to or from
 * PAYMENT_PROCESSING yet: the payment module will use these steps.
 */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: OrderStatus.PENDING,
    to: OrderStatus.CONFIRMED,
    only: PaymentMethod.COD,
  },
  {
    from: OrderStatus.PENDING,
    to: OrderStatus.PAYMENT_PROCESSING,
    only: PaymentMethod.ONLINE,
  },
  {
    from: OrderStatus.PAYMENT_PROCESSING,
    to: OrderStatus.CONFIRMED,
    only: PaymentMethod.ONLINE,
  },
  {
    from: OrderStatus.PAYMENT_PROCESSING,
    to: OrderStatus.PENDING,
    only: PaymentMethod.ONLINE,
  },
  { from: OrderStatus.PENDING, to: OrderStatus.CANCELLED },
  { from: OrderStatus.PENDING, to: OrderStatus.EXPIRED },
  { from: OrderStatus.CONFIRMED, to: OrderStatus.CANCELLED },
  { from: OrderStatus.CONFIRMED, to: OrderStatus.SHIPPING },
  { from: OrderStatus.SHIPPING, to: OrderStatus.DELIVERED },
];

export const FINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.EXPIRED,
];

/** Whether an order paid this way may move from one status to another. */
export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  paymentMethod: PaymentMethod,
): boolean {
  return TRANSITIONS.some(
    (step) =>
      step.from === from &&
      step.to === to &&
      (step.only === undefined || step.only === paymentMethod),
  );
}
