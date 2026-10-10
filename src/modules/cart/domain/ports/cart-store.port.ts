import type { CartLine } from '../cart-line.js';

/** What adding to the cart did. Only OK changed anything. */
export type AddOutcome =
  | { kind: 'OK'; quantity: number }
  /** A new item, but the cart already has the most lines */
  | { kind: 'LINES_FULL' }
  /** The item would have more than the most units per line */
  | { kind: 'QUANTITY_EXCEEDED' };

export type SetOutcome =
  | { kind: 'OK'; quantity: number; addedPrice: number }
  | { kind: 'NOT_IN_CART' }
  | { kind: 'QUANTITY_EXCEEDED' };

/**
 * Where the carts are kept (Redis). Every writing method checks the limits and writes in ONE
 * indivisible step, so many requests of the same user at the same moment cannot lose an addition
 * or go over a limit. Every method rejects with CART-005 when Redis cannot be reached.
 */
export interface ICartStore {
  /**
   * Adds `quantity` to the item (the line is created if there is none) and records `price` as the
   * price the customer saw. The time the item was first added stays as it was.
   */
  add(
    userId: string,
    skuId: string,
    quantity: number,
    price: number,
  ): Promise<AddOutcome>;

  /**
   * Sets the units of an item that is already in the cart. `price` null keeps the price recorded
   * before; a number replaces it.
   */
  setQuantity(
    userId: string,
    skuId: string,
    quantity: number,
    price: number | null,
  ): Promise<SetOutcome>;

  /** Removes the item; nothing happens when it is not there. */
  remove(userId: string, skuId: string): Promise<void>;

  /** Removes everything; nothing happens when the cart is empty. */
  clear(userId: string): Promise<void>;

  /** All the lines of the cart (in no particular order); empty when there is no cart. */
  read(userId: string): Promise<CartLine[]>;
}
