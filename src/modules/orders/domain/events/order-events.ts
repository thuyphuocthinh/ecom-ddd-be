import { randomUUID } from 'crypto';
import type { Order } from '../entities/order.entity.js';
import type { OrderStatus } from '../order-status.js';

/**
 * An event written to the outbox in the same transaction as the change it reports. The publisher sends
 * it later; `type` becomes the event name (`order.created`) and `payload` its data.
 *
 * Neither event carries the delivery address or the phone number: whoever listens does not need
 * them, and an event is copied to every listener.
 */
export interface OutboxEventDraft {
  /** Stable: a receiver recognises a message that arrives twice by this id. */
  id: string;
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export const ORDER_CREATED = 'order.created';
export const ORDER_STATUS_CHANGED = 'order.status_changed';

export function orderCreatedEvent(order: Order): OutboxEventDraft {
  return {
    id: randomUUID(),
    type: ORDER_CREATED,
    aggregateId: order.id,
    payload: {
      orderId: order.id,
      userId: order.userId,
      paymentMethod: order.paymentMethod,
      total: order.total,
      expiresAt: order.expiresAt.toISOString(),
      items: order.items.map((item) => ({
        skuId: item.skuId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    },
  };
}

export function orderStatusChangedEvent(
  order: { id: string; userId: string },
  from: OrderStatus,
  to: OrderStatus,
): OutboxEventDraft {
  return {
    id: randomUUID(),
    type: ORDER_STATUS_CHANGED,
    aggregateId: order.id,
    payload: { orderId: order.id, userId: order.userId, from, to },
  };
}
