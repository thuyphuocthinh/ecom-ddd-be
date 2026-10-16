import type { OrderStatus } from '../order-status.js';

/** What the feed tells: this order is now in this status. Nothing else, so nothing private travels. */
export interface OrderStatusUpdate {
  orderId: string;
  status: OrderStatus;
}

export type OrderStatusListener = (update: OrderStatusUpdate) => void;

/**
 * Carries "this order changed status" to whoever is looking at that order right now (a browser that
 * holds a server-sent-events stream open).
 *
 * `publish` reaches the listeners of EVERY copy of the application, not only this one: the change may
 * happen in copy A (a webhook, a sweep) while the browser is connected to copy B. `watch` registers a
 * listener in THIS copy and returns the function that removes it.
 *
 * A message is not stored: a listener that was not there when it was published never gets it, so a
 * reader must also read the current status when it starts to watch.
 */
export interface IOrderStatusFeed {
  publish(update: OrderStatusUpdate): Promise<void>;
  watch(orderId: string, listener: OrderStatusListener): () => void;
}

/** DI token for the active IOrderStatusFeed. */
export const ORDER_STATUS_FEED = 'IOrderStatusFeed';
