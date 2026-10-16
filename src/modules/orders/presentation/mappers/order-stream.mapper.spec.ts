import { OrderStatus } from '../../domain/index.js';
import { OrderStreamMapper } from './order-stream.mapper.js';

describe('OrderStreamMapper', () => {
  it('writes a status message as an `event: status` with the order and its status only', () => {
    expect(
      OrderStreamMapper.toMessageEvent({
        kind: 'status',
        orderId: 'order-1',
        status: OrderStatus.CONFIRMED,
      }),
    ).toEqual({
      type: 'status',
      data: { orderId: 'order-1', status: OrderStatus.CONFIRMED },
    });
  });

  it('writes a ping as an `event: ping` with nothing in it', () => {
    expect(OrderStreamMapper.toMessageEvent({ kind: 'ping' })).toEqual({
      type: 'ping',
      data: {},
    });
  });
});
