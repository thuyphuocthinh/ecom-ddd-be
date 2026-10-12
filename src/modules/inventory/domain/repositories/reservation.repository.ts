import type { Reservation, StockItem } from '../entities/reservation.entity.js';

/**
 * What `confirm` found. Only CONFIRMED changed anything. RELEASED also stands for an order whose
 * confirmed stock was already returned: either way the hold is gone and cannot be confirmed.
 */
export type ConfirmOutcome =
  'CONFIRMED' | 'ALREADY_CONFIRMED' | 'RELEASED' | 'NOT_FOUND';

/**
 * What `returnConfirmed` found. Only RETURNED changed anything.
 *  - ALREADY_RETURNED: a repeat of a return that is done.
 *  - NOT_CONFIRMED: the order is RESERVED or RELEASED, so no stock was ever taken out to put back.
 */
export type ReturnResult =
  | { kind: 'RETURNED'; items: StockItem[] }
  | { kind: 'ALREADY_RETURNED' }
  | { kind: 'NOT_CONFIRMED' }
  | { kind: 'NOT_FOUND' };

/**
 * What `extend` found. Only EXTENDED changed anything.
 *  - NOT_EXTENDABLE: the order is not RESERVED any more (released, confirmed, returned), or its
 *    hold is already past its expiry by the database clock.
 */
export type ExtendResult =
  | { kind: 'EXTENDED'; expiresAt: Date }
  | { kind: 'NOT_EXTENDABLE' }
  | { kind: 'NOT_FOUND' };

/** Thrown by `create` when the order already holds one of these SKUs (unique on order + SKU). */
export class ReservationAlreadyExistsError extends Error {
  constructor(orderId: string) {
    super(`A reservation already exists for order ${orderId}`);
    this.name = 'ReservationAlreadyExistsError';
  }
}

export interface IReservationRepository {
  /** The reservation of an order, or null. */
  findByOrderId(orderId: string): Promise<Reservation | null>;

  /** Writes every line of a new RESERVED reservation in one transaction. */
  create(reservation: Reservation): Promise<void>;

  /** Whether any line exists for the order, in any status. */
  existsForOrder(orderId: string): Promise<boolean>;

  /**
   * Paid: RESERVED becomes CONFIRMED and the units leave the warehouse stock (`onHand`), in one
   * transaction. The status change is conditional (`WHERE status = 'RESERVED'`), so confirming
   * twice, or against a release that got there first, changes nothing.
   */
  confirm(orderId: string): Promise<ConfirmOutcome>;

  /**
   * Cancelled or expired: RESERVED becomes RELEASED. Conditional like `confirm`. With
   * `onlyIfExpired` it also requires the hold to be past its expiry, judged by the database clock.
   * Returns the lines it released: empty when there was nothing to release.
   */
  release(
    orderId: string,
    options: { onlyIfExpired: boolean },
  ): Promise<StockItem[]>;

  /**
   * The order was cancelled after it was paid: CONFIRMED becomes RETURNED and the units go back
   * into the warehouse stock (`onHand`), in one transaction. Conditional on CONFIRMED, so doing it
   * twice, or racing a confirm or a release, changes nothing the second time. Returns the lines it
   * put back so the caller can add them to the number in Redis.
   */
  returnConfirmed(orderId: string): Promise<ReturnResult>;

  /**
   * Holds the units of a RESERVED order until at least `seconds` from now (database clock): every
   * line gets `expiresAt = max(expiresAt, now + seconds)`, so a hold is never shortened. One
   * conditional update (`WHERE status = 'RESERVED' AND expiresAt > now`), so it cannot revive a
   * hold that a release or the expiry got to first. Redis is not touched.
   */
  extend(orderId: string, seconds: number): Promise<ExtendResult>;

  /** Orders still RESERVED and past their expiry, oldest first. */
  findExpiredOrderIds(limit: number): Promise<string[]>;
}
