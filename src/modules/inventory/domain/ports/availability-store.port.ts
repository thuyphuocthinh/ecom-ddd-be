import type { StockItem } from '../entities/reservation.entity.js';
import type { Shortage } from '../exceptions/inventory.exception.js';

/** What `hold` found. Only HELD changed anything. */
export type HoldResult =
  | { kind: 'HELD' }
  /** Another request is holding this very order right now. */
  | { kind: 'IN_PROGRESS' }
  /** Redis has no number for these SKUs (it lost them): rebuild from Postgres, then try again. */
  | { kind: 'MISSING'; skuIds: string[] }
  /** At least one SKU has less than asked for; nothing was taken. */
  | { kind: 'SHORT'; shortages: Shortage[] };

/**
 * The fast side of the stock: how many units of each SKU can be sold right now, kept in Redis.
 * It only guards against overselling and can always be rebuilt from Postgres.
 *
 * Every method rejects with `INV-007` when Redis cannot be reached. The caller must treat that as
 * "do not sell": stock that cannot be checked is never handed out.
 */
export interface IAvailabilityStore {
  /**
   * Takes the units of a whole order in ONE atomic step: either every SKU has enough and all are
   * taken, or nothing is taken. Also writes the "being held" record of the order, which lasts
   * until `finishHold` or `undoHold`.
   */
  hold(
    orderId: string,
    fingerprint: string,
    items: StockItem[],
  ): Promise<HoldResult>;

  /** The numbers Redis has now, without changing anything; null for a SKU it has no number for. */
  peek(skuIds: string[]): Promise<Map<string, number | null>>;

  /** The order is saved in Postgres: forget its "being held" record. */
  finishHold(orderId: string): Promise<void>;

  /**
   * Gives back what `hold` took, but only if the order's "being held" record still exists, and
   * removes that record, all in one step. So it adds back at most once, even when a repair job and
   * the request itself both try. Returns whether it did.
   */
  undoHold(orderId: string, items: StockItem[]): Promise<boolean>;

  /** The items of an order's "being held" record, or null when it has none. */
  readInflight(orderId: string): Promise<StockItem[] | null>;

  /** Orders whose "being held" record is older than `olderThanMs` (Redis clock), oldest first. */
  listStaleInflight(olderThanMs: number, limit: number): Promise<string[]>;

  /**
   * Adds units back (a release). A SKU Redis has no number for is skipped: creating a number from
   * the quantity alone would be wrong. Its next read rebuilds the number from Postgres.
   */
  giveBack(items: StockItem[]): Promise<void>;

  /** Writes a SKU's number only if Redis has none, so a rebuild never overwrites a live number. */
  setIfAbsent(skuId: string, available: number): Promise<boolean>;

  /** Forgets the numbers of these SKUs, so the next access rebuilds them from Postgres. */
  delete(skuIds: string[]): Promise<void>;
}
