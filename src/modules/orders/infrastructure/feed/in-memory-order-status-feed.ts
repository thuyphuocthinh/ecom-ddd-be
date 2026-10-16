import type {
  IOrderStatusFeed,
  OrderStatusListener,
  OrderStatusUpdate,
} from '../../domain/index.js';
import { LocalWatchers } from './local-watchers.js';

/** One copy of the application only: a message goes straight to the listeners here. For tests. */
export class InMemoryOrderStatusFeed implements IOrderStatusFeed {
  readonly watchers = new LocalWatchers();

  publish(update: OrderStatusUpdate): Promise<void> {
    this.watchers.dispatch(update);
    return Promise.resolve();
  }

  watch(orderId: string, listener: OrderStatusListener): () => void {
    return this.watchers.add(orderId, listener);
  }
}
