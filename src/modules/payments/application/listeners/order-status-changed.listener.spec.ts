import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { CommandBus } from '@nestjs/cqrs';
import type { IEventBus, IntegrationEvent } from '@/core/index.js';
import {
  Payment,
  PaymentStatus,
  type IInboxStore,
  type IPaymentRepository,
} from '../../domain/index.js';
import { RefundPaymentCommand } from '../commands/refund-payment.command.js';
import {
  ORDER_EVENTS_CONSUMER,
  OrderStatusChangedListener,
} from './order-status-changed.listener.js';

const paymentOf = (id: string, status: PaymentStatus) =>
  Payment.restore({
    id,
    orderId: 'order-1',
    idempotencyKey: `pay-attempt-${id}`,
    provider: 'fake',
    status,
    version: 2,
    amount: 150000,
    paidAmount: status === PaymentStatus.SUCCEEDED ? 150000 : null,
    providerRef: `ref-${id}`,
    payUrl: 'https://pay',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date('2026-10-12T10:00:00.000Z'),
    updatedAt: new Date('2026-10-12T10:05:00.000Z'),
  });
const eventOf = (
  data: unknown,
  id = 'evt-1',
  name = 'order.status_changed',
): IntegrationEvent => ({
  id,
  name,
  occurredAt: new Date(),
  data,
});
const cancelled = { orderId: 'order-1', from: 'CONFIRMED', to: 'CANCELLED' };

describe('OrderStatusChangedListener', () => {
  let bus: { subscribe: ReturnType<typeof vi.fn> };
  let inbox: {
    record: ReturnType<typeof vi.fn>;
    forget: ReturnType<typeof vi.fn>;
  };
  let payments: { listByOrder: ReturnType<typeof vi.fn> };
  let commands: { execute: ReturnType<typeof vi.fn> };
  let listener: OrderStatusChangedListener;

  beforeEach(() => {
    bus = { subscribe: vi.fn() };
    inbox = {
      record: vi.fn().mockResolvedValue(true),
      forget: vi.fn().mockResolvedValue(undefined),
    };
    payments = {
      listByOrder: vi
        .fn()
        .mockResolvedValue([paymentOf('p1', PaymentStatus.SUCCEEDED)]),
    };
    commands = { execute: vi.fn().mockResolvedValue({ kind: 'REFUNDED' }) };
    listener = new OrderStatusChangedListener(
      bus as unknown as IEventBus,
      inbox as unknown as IInboxStore,
      payments as unknown as IPaymentRepository,
      commands as unknown as CommandBus,
    );
  });

  it('subscribes with its own queue name to the order status changes', () => {
    listener.onModuleInit();

    expect(bus.subscribe).toHaveBeenCalledWith(
      { name: 'payments.order-events', pattern: 'order.status_changed' },
      expect.any(Function),
    );
    expect(ORDER_EVENTS_CONSUMER).toBe('payments.order-events');
  });

  it('refunds the paid payment of an order that went from CONFIRMED to CANCELLED, noting the event first', async () => {
    await listener.handle(eventOf(cancelled));

    expect(inbox.record).toHaveBeenCalledWith(ORDER_EVENTS_CONSUMER, 'evt-1');
    expect(commands.execute).toHaveBeenCalledTimes(1);
    const command = commands.execute.mock.calls[0][0] as RefundPaymentCommand;
    expect(command).toBeInstanceOf(RefundPaymentCommand);
    expect(command.paymentId).toBe('p1');
    expect(command.options).toEqual({ markFirst: true });
  });

  it('refunds only the paid payments of the order, not the ones that failed or expired', async () => {
    payments.listByOrder.mockResolvedValue([
      paymentOf('p1', PaymentStatus.FAILED),
      paymentOf('p2', PaymentStatus.SUCCEEDED),
      paymentOf('p3', PaymentStatus.EXPIRED),
      paymentOf('p4', PaymentStatus.REFUNDED),
    ]);

    await listener.handle(eventOf(cancelled));

    expect(commands.execute).toHaveBeenCalledTimes(1);
    expect(
      (commands.execute.mock.calls[0][0] as RefundPaymentCommand).paymentId,
    ).toBe('p2');
  });

  it('an event it has already handled is dropped: nothing is looked up or refunded', async () => {
    inbox.record.mockResolvedValue(false);

    await listener.handle(eventOf(cancelled));

    expect(payments.listByOrder).not.toHaveBeenCalled();
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      'PENDING to CANCELLED (never paid)',
      { orderId: 'order-1', from: 'PENDING', to: 'CANCELLED' },
    ],
    [
      'CONFIRMED to SHIPPED',
      { orderId: 'order-1', from: 'CONFIRMED', to: 'SHIPPED' },
    ],
    [
      'PAYMENT_PROCESSING to EXPIRED',
      { orderId: 'order-1', from: 'PAYMENT_PROCESSING', to: 'EXPIRED' },
    ],
    ['no data', null],
    ['text', 'CANCELLED'],
    ['a number', 42],
    ['an empty object', {}],
    [
      'an order id that is not text',
      { orderId: 5, from: 'CONFIRMED', to: 'CANCELLED' },
    ],
    ['an empty order id', { orderId: '', from: 'CONFIRMED', to: 'CANCELLED' }],
  ])('ignores %s, without noting it or failing', async (_label, data) => {
    await expect(listener.handle(eventOf(data))).resolves.toBeUndefined();

    expect(inbox.record).not.toHaveBeenCalled();
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('when the refund fails, the event is taken back out of the inbox and the error goes on (so it is retried, then dead-lettered)', async () => {
    commands.execute.mockRejectedValue(new Error('adapter bug'));

    await expect(listener.handle(eventOf(cancelled))).rejects.toThrow(
      'adapter bug',
    );

    expect(inbox.forget).toHaveBeenCalledWith(ORDER_EVENTS_CONSUMER, 'evt-1');
  });

  it('when taking the note back fails too, the original error is the one that goes on', async () => {
    commands.execute.mockRejectedValue(new Error('adapter bug'));
    inbox.forget.mockRejectedValue(new Error('Postgres down'));

    await expect(listener.handle(eventOf(cancelled))).rejects.toThrow(
      'adapter bug',
    );
  });
});
