import { describe, it, expect } from 'vitest';
import {
  ALL_ORDER_STATUSES,
  Order,
  OrderStatus,
  PaymentMethod,
  TIMELINE_COLUMN,
  emptyTimeline,
  isValidOrderCode,
} from './index.js';

describe('the code of an order (the start of its id)', () => {
  it.each(['3fa85f', '3fa85f64', '3fa85f64-5717-4562-b3fc-2c963f66afa6'])(
    'accepts %s',
    (code) => {
      expect(isValidOrderCode(code)).toBe(true);
    },
  );

  it.each([
    ['too short', '3fa85'],
    ['too long', 'a'.repeat(37)],
    ['upper case (the controller lowers it first)', '3FA85F64'],
    ['not hex', 'xyz12345'],
    ['a space', '3fa85f 64'],
    ['a quote', "3fa85f'64"],
    ['a wildcard', '3fa85f%'],
    ['empty', ''],
  ])('refuses %s', (_label, code) => {
    expect(isValidOrderCode(code)).toBe(false);
  });

  it('refuses what is not text', () => {
    for (const value of [undefined, null, 123456, ['3fa85f64'], {}]) {
      expect(isValidOrderCode(value)).toBe(false);
    }
  });
});

describe('every status', () => {
  it('ALL_ORDER_STATUSES is exactly the statuses there are', () => {
    expect([...ALL_ORDER_STATUSES].sort()).toEqual(
      Object.values(OrderStatus).sort(),
    );
  });
});

describe('the time column of each status', () => {
  it('has one for each status an order ends up in, and none for the two it passes through', () => {
    expect(TIMELINE_COLUMN).toEqual({
      CONFIRMED: 'confirmedAt',
      SHIPPING: 'shippedAt',
      DELIVERED: 'deliveredAt',
      CANCELLED: 'cancelledAt',
      EXPIRED: 'expiredAt',
    });
    expect(TIMELINE_COLUMN[OrderStatus.PENDING]).toBeUndefined();
    expect(TIMELINE_COLUMN[OrderStatus.PAYMENT_PROCESSING]).toBeUndefined();
  });

  it('every column is a field of the timeline of an order', () => {
    const fields = Object.keys(emptyTimeline());

    for (const column of Object.values(TIMELINE_COLUMN)) {
      expect(fields).toContain(column);
    }
    expect(Object.values(TIMELINE_COLUMN)).toHaveLength(fields.length);
  });
});

describe('the timeline of an order', () => {
  const placed = () =>
    Order.create({
      userId: 'user-1',
      idempotencyKey: 'timeline-key-0001',
      paymentMethod: PaymentMethod.COD,
      shippingAddress: {
        recipientName: 'A',
        phone: '0901234567',
        provinceCode: '01',
        provinceName: 'Hà Nội',
        wardCode: '00001',
        wardName: 'Ba Đình',
        street: '1 Đường Thử',
        label: null,
      },
      items: [
        {
          skuId: 'sku-1',
          productName: 'AirPods',
          thumbnail: null,
          attributes: {},
          unitPrice: 100,
          quantity: 1,
        },
      ],
      expiresAt: new Date(Date.now() + 60_000),
    });

  it('is empty for a new order', () => {
    expect(placed().timeline).toEqual({
      confirmedAt: null,
      shippedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      expiredAt: null,
    });
  });

  it('is kept when an order is rebuilt, and empty when none is given (orders from before)', () => {
    const base = placed();
    const data = { ...base, items: [...base.items] };
    const confirmedAt = new Date('2026-10-11T10:05:00.000Z');

    const withTimes = Order.restore({
      ...data,
      timeline: { ...emptyTimeline(), confirmedAt },
    });
    const without = Order.restore(data);

    expect(withTimes.timeline.confirmedAt).toEqual(confirmedAt);
    expect(without.timeline).toEqual(emptyTimeline());
  });

  it('two new orders do not share one timeline object', () => {
    expect(placed().timeline).not.toBe(placed().timeline);
  });
});
