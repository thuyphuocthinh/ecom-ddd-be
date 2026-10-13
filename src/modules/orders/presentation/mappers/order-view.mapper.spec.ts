import { describe, it, expect } from 'vitest';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  emptyTimeline,
  type OrderItem,
  type OrderStatusCounts,
} from '../../domain/index.js';
import { OrderViewMapper } from './order-view.mapper.js';

const item = (n: number): OrderItem => ({
  skuId: `sku-${n}`,
  productName: `Product ${n}`,
  thumbnail: n % 2 === 0 ? null : `https://img/${n}.png`,
  attributes: { n: String(n) },
  unitPrice: 100 * n,
  quantity: n,
  lineTotal: 100 * n * n,
});
const orderWith = (
  items: OrderItem[],
  timeline = emptyTimeline(),
  status = OrderStatus.CONFIRMED,
) =>
  Order.restore({
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    userId: 'user-1',
    idempotencyKey: 'secret-key-0001',
    paymentMethod: PaymentMethod.ONLINE,
    status,
    version: 4,
    stockReturnPending: true,
    total: 1000,
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
    items,
    expiresAt: new Date('2026-10-11T10:20:00.000Z'),
    createdAt: new Date('2026-10-11T10:05:00.000Z'),
    updatedAt: new Date('2026-10-11T10:06:00.000Z'),
    timeline,
  });

describe('a line of the list of orders', () => {
  it('shows the first 3 items with only what the list needs, and how many lines there are in all', () => {
    const summary = OrderViewMapper.toSummary(
      orderWith([item(1), item(2), item(3), item(4), item(5)]),
    );

    expect(summary.itemCount).toBe(5);
    expect(summary.items).toEqual([
      { productName: 'Product 1', thumbnail: 'https://img/1.png', quantity: 1 },
      { productName: 'Product 2', thumbnail: null, quantity: 2 },
      { productName: 'Product 3', thumbnail: 'https://img/3.png', quantity: 3 },
    ]);
  });

  it('shows all the items when there are fewer than 3', () => {
    expect(OrderViewMapper.toSummary(orderWith([item(1)])).items).toHaveLength(
      1,
    );
    expect(
      OrderViewMapper.toSummary(orderWith([item(1), item(2)])).items,
    ).toHaveLength(2);
  });

  it('does not show the timeline, nor anything internal', () => {
    const summary = OrderViewMapper.toSummary(orderWith([item(1)]));

    expect(Object.keys(summary).sort()).toEqual(
      [
        'createdAt',
        'expiresAt',
        'id',
        'itemCount',
        'items',
        'paymentMethod',
        'status',
        'total',
      ].sort(),
    );
    expect(Object.keys(summary.items[0]).sort()).toEqual(
      ['productName', 'quantity', 'thumbnail'].sort(),
    );
  });
});

describe('the detail of an order', () => {
  it('has the timeline: when it was placed (its createdAt) and each time it reached a status', () => {
    const confirmedAt = new Date('2026-10-11T10:07:00.000Z');
    const detail = OrderViewMapper.toDetail(
      orderWith([item(1)], { ...emptyTimeline(), confirmedAt }),
    );

    expect(detail.timeline).toEqual({
      placedAt: new Date('2026-10-11T10:05:00.000Z'),
      confirmedAt,
      shippedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      expiredAt: null,
    });
  });

  it('has an empty timeline for an order from before the times were kept', () => {
    const detail = OrderViewMapper.toDetail(orderWith([item(1)]));

    expect(detail.timeline.placedAt).toEqual(detail.createdAt);
    expect(detail.timeline.confirmedAt).toBeNull();
  });

  it('still shows nothing internal', () => {
    const detail = OrderViewMapper.toDetail(orderWith([item(1)]));
    const text = JSON.stringify(detail);

    expect(text).not.toContain('secret-key-0001');
    expect(text).not.toContain('user-1');
    expect(text).not.toContain('stockReturnPending');
    expect(text).not.toContain('version');
  });
});

describe('the counts', () => {
  it('shows the seven statuses', () => {
    const counts: OrderStatusCounts = {
      PENDING: 1,
      PAYMENT_PROCESSING: 2,
      CONFIRMED: 3,
      SHIPPING: 4,
      DELIVERED: 5,
      CANCELLED: 6,
      EXPIRED: 7,
    };

    expect(OrderViewMapper.toCounts(counts)).toEqual(counts);
  });
});
