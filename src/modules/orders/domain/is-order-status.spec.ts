import { OrderStatus, isOrderStatus } from './order-status.js';

describe('isOrderStatus', () => {
  it.each(Object.values(OrderStatus))('accepts %s', (status) => {
    expect(isOrderStatus(status)).toBe(true);
  });

  it.each([undefined, null, 7, {}, '', 'confirmed', 'SHIPPED_TO_MARS'])(
    'refuses %j',
    (value) => {
      expect(isOrderStatus(value)).toBe(false);
    },
  );
});
