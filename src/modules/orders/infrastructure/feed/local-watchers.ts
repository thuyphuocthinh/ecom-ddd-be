import type {
  OrderStatusListener,
  OrderStatusUpdate,
} from '../../domain/index.js';

/**
 * The listeners of THIS copy of the application, by order id. Both feeds use it to hand a message to
 * the right listeners; they differ only in how a message reaches this copy.
 */
export class LocalWatchers {
  private readonly byOrder = new Map<string, Set<OrderStatusListener>>();

  /** Adds a listener for one order; returns the function that removes it (safe to call twice). */
  add(orderId: string, listener: OrderStatusListener): () => void {
    let listeners = this.byOrder.get(orderId);
    if (!listeners) {
      listeners = new Set();
      this.byOrder.set(orderId, listeners);
    }
    // Wrapped so the same function added twice counts as two listeners
    const own: OrderStatusListener = (update) => listener(update);
    listeners.add(own);

    return () => {
      const current = this.byOrder.get(orderId);
      if (!current) return;
      current.delete(own);
      if (current.size === 0) this.byOrder.delete(orderId);
    };
  }

  /** Gives the update to the listeners of its order. One that throws does not stop the others. */
  dispatch(update: OrderStatusUpdate): void {
    const listeners = this.byOrder.get(update.orderId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(update);
      } catch {
        // A broken listener must not keep the message from the others
      }
    }
  }

  /** How many listeners an order has here (for tests and logs). */
  count(orderId: string): number {
    return this.byOrder.get(orderId)?.size ?? 0;
  }
}
