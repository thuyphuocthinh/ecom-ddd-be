import { Inject, Injectable } from '@nestjs/common';
import type { CartLine, ICartStore } from '../../domain/index.js';

/**
 * What the order module needs from the cart: the lines as they are (no prices or stock looked up
 * again, that is the order's own job) and a way to take the ordered items out afterwards.
 * Not an endpoint: other modules call it.
 */
@Injectable()
export class CartOrderingService {
  constructor(@Inject('ICartStore') private readonly store: ICartStore) {}

  /** The raw lines of the cart (SKU, quantity, price seen, when it was put in); empty when there is no cart. */
  getLines(userId: string): Promise<CartLine[]> {
    return this.store.read(userId);
  }

  /**
   * Takes these SKUs out of the cart in one atomic step. A SKU that is not in the cart is skipped,
   * the other items stay. Rejects with CART-005 when Redis cannot be reached.
   */
  removeLines(userId: string, skuIds: string[]): Promise<void> {
    return this.store.removeMany(userId, skuIds);
  }
}
