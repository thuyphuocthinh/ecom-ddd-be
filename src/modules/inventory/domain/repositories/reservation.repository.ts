import type { Reservation, StockItem } from '../entities/reservation.entity.js';

/** What `confirm` found. Only CONFIRMED changed anything. */
export type ConfirmOutcome =
  'CONFIRMED' | 'ALREADY_CONFIRMED' | 'RELEASED' | 'NOT_FOUND';

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

  /** Orders still RESERVED and past their expiry, oldest first. */
  findExpiredOrderIds(limit: number): Promise<string[]>;
}
