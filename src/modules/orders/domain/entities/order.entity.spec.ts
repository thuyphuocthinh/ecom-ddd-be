import { describe, it, expect } from 'vitest';
import { Order, MAX_ORDER_ITEMS } from './order.entity.js';
import type { NewOrderItem, ShippingAddress } from './order.entity.js';
import { OrderStatus, PaymentMethod } from '../order-status.js';
import { deriveOrderId } from '../services/order-identity.js';
import {
  ORDER_CREATED,
  ORDER_STATUS_CHANGED,
  orderCreatedEvent,
  orderStatusChangedEvent,
} from '../events/order-events.js';

const ADDRESS: ShippingAddress = {
  recipientName: 'Nguyễn Văn A',
  phone: '0912345678',
  provinceCode: '01',
  provinceName: 'Thành phố Hà Nội',
  wardCode: '00004',
  wardName: 'Phường Ba Đình',
  street: '12 Bạch Đằng',
  label: 'Nhà',
};

const item = (
  skuId: string,
  overrides: Partial<NewOrderItem> = {},
): NewOrderItem => ({
  skuId,
  productName: `Product ${skuId}`,
  thumbnail: null,
  attributes: { color: 'White' },
  unitPrice: 1000,
  quantity: 1,
  ...overrides,
});

const make = (overrides: Record<string, unknown> = {}) =>
  Order.create({
    userId: 'user-1',
    idempotencyKey: 'checkout-attempt-0001',
    paymentMethod: PaymentMethod.ONLINE,
    shippingAddress: ADDRESS,
    items: [
      item('A', { unitPrice: 3990000, quantity: 2 }),
      item('B', { unitPrice: 199000.5 }),
    ],
    expiresAt: new Date('2026-10-11T09:00:00.000Z'),
    ...overrides,
  });

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error: any) {
    return { code: error.code, details: error.details };
  }
  throw new Error('should have failed');
};

describe('Order.create', () => {
  it('starts PENDING at version 1, with no stock to put back', () => {
    const order = make();

    expect(order.status).toBe(OrderStatus.PENDING);
    expect(order.version).toBe(1);
    expect(order.stockReturnPending).toBe(false);
    expect(order.paymentMethod).toBe(PaymentMethod.ONLINE);
  });

  it('takes its id from the user and the key', () => {
    expect(make().id).toBe(deriveOrderId('user-1', 'checkout-attempt-0001'));
    expect(make({ userId: 'user-2' }).id).not.toBe(make().id);
  });

  it('works out each line total and the order total exactly', () => {
    const order = make();

    expect(order.items.map((i) => [i.skuId, i.lineTotal])).toEqual([
      ['A', 7980000],
      ['B', 199000.5],
    ]);
    expect(order.total).toBe(8179000.5);
    expect(order.itemCount).toBe(2);
  });

  it('keeps a copy of what was bought and where it goes', () => {
    const order = make();

    expect(order.items[0]).toMatchObject({
      productName: 'Product A',
      attributes: { color: 'White' },
      unitPrice: 3990000,
      quantity: 2,
    });
    expect(order.shippingAddress).toEqual(ADDRESS);
  });

  it.each([PaymentMethod.ONLINE, PaymentMethod.COD])(
    'accepts payment method %s',
    (method) => {
      expect(make({ paymentMethod: method }).paymentMethod).toBe(method);
    },
  );

  it('refuses a key that is not acceptable with ORD-005', () => {
    expect(failure(() => make({ idempotencyKey: 'short' })).code).toBe(
      'ORD-005',
    );
    expect(
      failure(() => make({ idempotencyKey: 'has spaces in it' })).code,
    ).toBe('ORD-005');
  });

  it.each([
    ['an unknown payment method', { paymentMethod: 'CHEQUE' }],
    ['no user', { userId: '' }],
    ['no items', { items: [] }],
    ['the same SKU twice', { items: [item('A'), item('A')] }],
    ['a zero quantity', { items: [item('A', { quantity: 0 })] }],
    ['a fractional quantity', { items: [item('A', { quantity: 1.5 })] }],
    ['more than 1000 of one item', { items: [item('A', { quantity: 1001 })] }],
    ['a negative price', { items: [item('A', { unitPrice: -1 })] }],
    [
      'a price that is not a number',
      { items: [item('A', { unitPrice: NaN })] },
    ],
    ['an invalid expiry', { expiresAt: new Date('nope') }],
  ])('refuses %s with ORD-000', (_, bad) => {
    expect(failure(() => make(bad)).code).toBe('ORD-000');
  });

  it('accepts 50 items but not 51', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => item(`S${i}`));

    expect(() => make({ items: many(MAX_ORDER_ITEMS) })).not.toThrow();
    expect(failure(() => make({ items: many(MAX_ORDER_ITEMS + 1) })).code).toBe(
      'ORD-000',
    );
  });

  it('refuses a total that the database column could not hold', () => {
    const huge = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        item(`S${i}`, { unitPrice: 99999999.99, quantity: 99 }),
      );

    expect(() => make({ items: huge(1) })).not.toThrow();
    expect(failure(() => make({ items: huge(50) })).details.reason).toMatch(
      /too large/,
    );
  });

  it('accepts a free item (price 0) and the largest quantity', () => {
    const order = make({
      items: [item('A', { unitPrice: 0, quantity: 1000 })],
    });

    expect(order.total).toBe(0);
  });
});

describe('Order.canMoveTo and isFinal', () => {
  it('follows the table for its own payment method', () => {
    const online = make({ paymentMethod: PaymentMethod.ONLINE });
    const cod = make({ paymentMethod: PaymentMethod.COD });

    expect(online.canMoveTo(OrderStatus.CONFIRMED)).toBe(false);
    expect(cod.canMoveTo(OrderStatus.CONFIRMED)).toBe(true);
    expect(online.canMoveTo(OrderStatus.PAYMENT_PROCESSING)).toBe(true);
    expect(cod.canMoveTo(OrderStatus.PAYMENT_PROCESSING)).toBe(false);
    expect(online.canMoveTo(OrderStatus.CANCELLED)).toBe(true);
    expect(online.canMoveTo(OrderStatus.SHIPPING)).toBe(false);
  });

  it('knows a final status', () => {
    const order = make();
    const restore = (status: OrderStatus) =>
      Order.restore({
        id: order.id,
        userId: order.userId,
        idempotencyKey: order.idempotencyKey,
        paymentMethod: order.paymentMethod,
        status,
        version: 3,
        stockReturnPending: false,
        total: order.total,
        shippingAddress: order.shippingAddress,
        items: [...order.items],
        expiresAt: order.expiresAt,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      });

    expect(restore(OrderStatus.DELIVERED).isFinal).toBe(true);
    expect(restore(OrderStatus.CANCELLED).isFinal).toBe(true);
    expect(restore(OrderStatus.EXPIRED).isFinal).toBe(true);
    expect(restore(OrderStatus.PENDING).isFinal).toBe(false);
    expect(restore(OrderStatus.SHIPPING).isFinal).toBe(false);
    expect(restore(OrderStatus.SHIPPING).version).toBe(3);
  });
});

describe('the outbox events of an order (AC-15)', () => {
  it('order.created carries what the listeners need and nothing personal', () => {
    const order = make({ paymentMethod: PaymentMethod.COD });

    const event = orderCreatedEvent(order);

    expect(event.type).toBe(ORDER_CREATED);
    expect(event.aggregateId).toBe(order.id);
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.payload).toEqual({
      orderId: order.id,
      userId: 'user-1',
      paymentMethod: 'COD',
      total: 8179000.5,
      expiresAt: '2026-10-11T09:00:00.000Z',
      items: [
        { skuId: 'A', quantity: 2, unitPrice: 3990000 },
        { skuId: 'B', quantity: 1, unitPrice: 199000.5 },
      ],
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain('0912345678');
    expect(text).not.toContain('Bạch Đằng');
    expect(text).not.toContain('Nguyễn');
  });

  it('order.status_changed says who and from where to where', () => {
    const order = make();

    const event = orderStatusChangedEvent(
      order,
      OrderStatus.PENDING,
      OrderStatus.CANCELLED,
    );

    expect(event.type).toBe(ORDER_STATUS_CHANGED);
    expect(event.aggregateId).toBe(order.id);
    expect(event.payload).toEqual({
      orderId: order.id,
      userId: 'user-1',
      from: 'PENDING',
      to: 'CANCELLED',
    });
  });

  it('gives each event its own id', () => {
    const order = make();

    expect(orderCreatedEvent(order).id).not.toBe(orderCreatedEvent(order).id);
  });
});
