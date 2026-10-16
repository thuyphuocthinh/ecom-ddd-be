import type { MessageEvent } from '@nestjs/common';
import type { OrderStreamMessage } from '../../application/index.js';

/**
 * Writes the messages of an order stream the way server-sent events carry them: the `type` is the
 * `event:` line, the `data` is sent as JSON.
 */
export class OrderStreamMapper {
  static toMessageEvent(message: OrderStreamMessage): MessageEvent {
    if (message.kind === 'ping') return { type: 'ping', data: {} };
    return {
      type: 'status',
      data: { orderId: message.orderId, status: message.status },
    };
  }
}
