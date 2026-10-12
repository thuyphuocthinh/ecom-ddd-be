import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import { DomainException, OrderErrorCodes } from '@/core/index.js';
import {
  ConfirmOrderCommand,
  ExpireOrderCommand,
  ReopenOrderCommand,
} from '../../../orders/application/index.js';
import {
  Order,
  OrderDomainException,
  OrderStatus,
  PaymentMethod,
} from '../../../orders/domain/index.js';
import {
  GatewayRejected,
  GatewayUnavailable,
  Payment,
  PaymentStatus,
  type IInboxStore,
  type IPaymentGateway,
  type IPaymentRepository,
} from '../../domain/index.js';
import { ApplyPaymentResultCommand } from './apply-payment-result.command.js';
import { ApplyPaymentResultHandler } from './apply-payment-result.handler.js';
import { FinishPaidPaymentCommand } from './finish-paid-payment.command.js';
import { FinishPaidPaymentHandler } from './finish-paid-payment.handler.js';
import { RefundPaymentCommand } from './refund-payment.command.js';
import { RefundPaymentHandler } from './refund-payment.handler.js';

const ADDRESS = {
  recipientName: 'A',
  phone: '0901234567',
  provinceCode: '01',
  provinceName: 'Hà Nội',
  wardCode: '00001',
  wardName: 'Ba Đình',
  street: '1 Street',
  label: null,
};
const orderOf = (status: OrderStatus) => {
  const created = Order.create({
    userId: 'user-1',
    idempotencyKey: 'checkout-key-0001',
    paymentMethod: PaymentMethod.ONLINE,
    shippingAddress: ADDRESS,
    items: [
      {
        skuId: 'A',
        productName: 'A',
        thumbnail: null,
        attributes: {},
        unitPrice: 150000,
        quantity: 1,
      },
    ],
    expiresAt: new Date(Date.now() + 60_000),
  });
  return Order.restore({ ...created, id: 'order-1', status } as never);
};
const paymentOf = (overrides: Record<string, unknown> = {}) =>
  Payment.restore({
    id: 'pay-1',
    orderId: 'order-1',
    idempotencyKey: 'pay-attempt-0001',
    provider: 'fake',
    status: PaymentStatus.SUCCEEDED,
    version: 2,
    amount: 150000,
    paidAmount: 150000,
    providerRef: 'ref-1',
    payUrl: 'https://pay',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date('2026-10-12T10:00:00.000Z'),
    updatedAt: new Date('2026-10-12T10:05:00.000Z'),
    ...overrides,
  });
const notAllowed = () =>
  new OrderDomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('ApplyPaymentResultHandler', () => {
  let calls: string[];
  let payments: any;
  let inbox: {
    record: ReturnType<typeof vi.fn>;
    forget: ReturnType<typeof vi.fn>;
  };
  let bus: { execute: ReturnType<typeof vi.fn> };
  const handler = () =>
    new ApplyPaymentResultHandler(
      payments as IPaymentRepository,
      inbox as unknown as IInboxStore,
      bus as unknown as CommandBus,
    );
  const apply = (
    status: 'PAID' | 'FAILED' = 'PAID',
    amount = 150000,
    eventId: string | null = 'evt-1',
  ) =>
    handler().execute(
      new ApplyPaymentResultCommand(
        'fake',
        'ref-1',
        status,
        amount,
        eventId ?? undefined,
      ),
    );

  beforeEach(() => {
    calls = [];
    payments = {
      findByProviderRef: vi.fn(async () =>
        paymentOf({ status: PaymentStatus.INITIATED, paidAmount: null }),
      ),
      transition: vi.fn(
        async (_id: string, _from: unknown, to: PaymentStatus) => {
          calls.push(`transition:${to}`);
          return paymentOf({ status: to });
        },
      ),
    };
    inbox = {
      record: vi.fn(async () => {
        calls.push('inbox.record');
        return true;
      }),
      forget: vi.fn(async () => {
        calls.push('inbox.forget');
      }),
    };
    bus = {
      execute: vi.fn(async (command: object) => {
        calls.push(command.constructor.name);
      }),
    };
  });

  it('notes the message FIRST, then moves the payment, then finishes it', async () => {
    const result = await apply('PAID');

    expect(result).toBe('APPLIED');
    expect(calls).toEqual([
      'inbox.record',
      'transition:SUCCEEDED',
      'FinishPaidPaymentCommand',
    ]);
    expect(inbox.record).toHaveBeenCalledWith('webhook:fake', 'evt-1');
  });

  it('moves INITIATED, FAILED and EXPIRED payments to SUCCEEDED (the money wins) and records what came in', async () => {
    await apply('PAID', 1000);

    const [id, from, to, event, move] = payments.transition.mock.calls[0];
    expect(id).toBe('pay-1');
    expect([...from].sort()).toEqual(
      [
        PaymentStatus.EXPIRED,
        PaymentStatus.FAILED,
        PaymentStatus.INITIATED,
      ].sort(),
    );
    expect(to).toBe(PaymentStatus.SUCCEEDED);
    expect(event).toMatchObject({
      type: 'payment.succeeded',
      payload: { amount: 1000 },
    });
    expect(move).toEqual({ paidAmount: 1000 });
  });

  it('moves only an INITIATED payment to FAILED, and opens the order again', async () => {
    const result = await apply('FAILED');

    expect(result).toBe('APPLIED');
    expect(payments.transition).toHaveBeenCalledWith(
      'pay-1',
      [PaymentStatus.INITIATED],
      PaymentStatus.FAILED,
      expect.objectContaining({ type: 'payment.failed' }),
    );
    expect(bus.execute.mock.calls[0][0]).toEqual(
      new ReopenOrderCommand('order-1'),
    );
  });

  it('a message with an id that was noted before is a DUPLICATE: nothing else happens', async () => {
    inbox.record.mockResolvedValue(false);

    expect(await apply()).toBe('DUPLICATE');
    expect(payments.findByProviderRef).not.toHaveBeenCalled();
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('a report with no message id (from a sweep) does not touch the inbox', async () => {
    expect(await apply('PAID', 150000, null)).toBe('APPLIED');
    expect(inbox.record).not.toHaveBeenCalled();
    expect(inbox.forget).not.toHaveBeenCalled();
  });

  it('a charge that is not ours is UNKNOWN_PAYMENT: nothing is changed', async () => {
    payments.findByProviderRef.mockResolvedValue(null);

    expect(await apply()).toBe('UNKNOWN_PAYMENT');
    expect(payments.transition).not.toHaveBeenCalled();
    expect(bus.execute).not.toHaveBeenCalled();
  });

  it.each([0, -5, Number.NaN])(
    'a PAID report for an amount of %s is IGNORED',
    async (amount) => {
      expect(await apply('PAID', amount)).toBe('IGNORED');
      expect(payments.transition).not.toHaveBeenCalled();
    },
  );

  it('when the payment is past this (the update found nothing to change) it is IGNORED and goes no further', async () => {
    payments.transition.mockResolvedValue(null);

    expect(await apply('PAID')).toBe('IGNORED');
    expect(await apply('FAILED')).toBe('IGNORED');
    expect(bus.execute).not.toHaveBeenCalled();
  });

  it('when finishing a paid payment fails, the payment stays recorded as paid and the report is still answered as handled', async () => {
    bus.execute.mockRejectedValueOnce(new Error('Postgres down'));

    expect(await apply('PAID')).toBe('APPLIED');
    expect(inbox.forget).not.toHaveBeenCalled();
  });

  it('when opening the order again fails after a failure, the report is still handled', async () => {
    bus.execute.mockRejectedValueOnce(notAllowed());

    expect(await apply('FAILED')).toBe('APPLIED');
  });

  it('when the payment cannot be recorded, the note is taken back out of the inbox and the error goes on (the gateway will send it again)', async () => {
    const down = new Error('connection lost');
    payments.transition.mockRejectedValueOnce(down);

    await expect(apply()).rejects.toBe(down);
    expect(calls).toEqual(['inbox.record', 'inbox.forget']);
    expect(inbox.forget).toHaveBeenCalledWith('webhook:fake', 'evt-1');
  });

  it('when the payment cannot even be looked up, the same: the note is taken back and the error goes on', async () => {
    const down = new Error('connection lost');
    payments.findByProviderRef.mockRejectedValueOnce(down);

    await expect(apply()).rejects.toBe(down);
    expect(inbox.forget).toHaveBeenCalledTimes(1);
  });

  it('still passes the original error on when taking the note back fails too', async () => {
    const down = new Error('connection lost');
    payments.transition.mockRejectedValueOnce(down);
    inbox.forget.mockRejectedValueOnce(new Error('also down'));

    await expect(apply()).rejects.toBe(down);
  });
});

describe('FinishPaidPaymentHandler', () => {
  let calls: string[];
  let payments: any;
  let bus: { execute: ReturnType<typeof vi.fn> };
  let queryBus: { execute: ReturnType<typeof vi.fn> };
  let confirm: () => unknown;

  const finish = (id = 'pay-1') =>
    new FinishPaidPaymentHandler(
      payments as IPaymentRepository,
      bus as unknown as CommandBus,
      queryBus as unknown as QueryBus,
    ).execute(new FinishPaidPaymentCommand(id));
  const orderIs = (status: OrderStatus) =>
    queryBus.execute.mockResolvedValue(orderOf(status));
  const commandsRun = () =>
    bus.execute.mock.calls.map(([c]) => c.constructor.name);

  beforeEach(() => {
    calls = [];
    confirm = () => ({
      kind: 'CONFIRMED',
      order: orderOf(OrderStatus.CONFIRMED),
    });
    payments = {
      findById: vi.fn(async () => paymentOf()),
      listByOrder: vi.fn(async () => [paymentOf()]),
      transition: vi.fn(
        async (_id: string, _from: unknown, to: PaymentStatus) => {
          calls.push(`transition:${to}`);
          return paymentOf({ status: to });
        },
      ),
    };
    queryBus = {
      execute: vi.fn(async () => orderOf(OrderStatus.PAYMENT_PROCESSING)),
    };
    bus = {
      execute: vi.fn(async (command: object) => {
        calls.push(command.constructor.name);
        if (command instanceof ConfirmOrderCommand) return confirm();
        return undefined;
      }),
    };
  });

  it('confirms an order that is waiting for this payment, and does nothing else', async () => {
    expect(await finish()).toEqual({ kind: 'CONFIRMED' });
    expect(calls).toEqual(['ConfirmOrderCommand']);
  });

  it.each([
    [OrderStatus.CANCELLED, 'ORDER_CLOSED'],
    [OrderStatus.EXPIRED, 'ORDER_CLOSED'],
    [OrderStatus.PENDING, 'ORDER_NOT_WAITING'],
  ])(
    'an order in %s: the money goes back (%s), the order is not confirmed',
    async (status, reason) => {
      orderIs(status);

      expect(await finish()).toEqual({ kind: 'REFUNDING', reason });
      expect(calls).toEqual([
        'transition:REFUND_PENDING',
        'RefundPaymentCommand',
      ]);
    },
  );

  it('an amount that is not the price of the order: the order is opened again (if it is waiting) and the money goes back, NOT confirmed', async () => {
    payments.findById.mockResolvedValue(paymentOf({ paidAmount: 1000 }));

    expect(await finish()).toEqual({
      kind: 'REFUNDING',
      reason: 'AMOUNT_MISMATCH',
    });
    expect(calls).toEqual([
      'ReopenOrderCommand',
      'transition:REFUND_PENDING',
      'RefundPaymentCommand',
    ]);
    expect(commandsRun()).not.toContain('ConfirmOrderCommand');
  });

  it('a wrong amount for an order that is not waiting does not try to open it', async () => {
    payments.findById.mockResolvedValue(paymentOf({ paidAmount: 999999 }));
    orderIs(OrderStatus.CANCELLED);

    expect(await finish()).toEqual({
      kind: 'REFUNDING',
      reason: 'AMOUNT_MISMATCH',
    });
    expect(commandsRun()).not.toContain('ReopenOrderCommand');
  });

  it('the held stock is gone (HOLD_LOST): the order expires FIRST, then the money goes back', async () => {
    confirm = () => ({ kind: 'HOLD_LOST' });

    expect(await finish()).toEqual({ kind: 'REFUNDING', reason: 'HOLD_LOST' });
    expect(calls).toEqual([
      'ConfirmOrderCommand',
      'ExpireOrderCommand',
      'transition:REFUND_PENDING',
      'RefundPaymentCommand',
    ]);
    expect(bus.execute.mock.calls[1][0]).toEqual(
      new ExpireOrderCommand('order-1'),
    );
  });

  it('an order already confirmed by another payment that became paid before this one: this one is a duplicate and goes back', async () => {
    orderIs(OrderStatus.CONFIRMED);
    payments.listByOrder.mockResolvedValue([
      paymentOf(),
      paymentOf({
        id: 'pay-0',
        updatedAt: new Date('2026-10-12T10:01:00.000Z'),
      }),
    ]);

    expect(await finish()).toEqual({
      kind: 'REFUNDING',
      reason: 'DUPLICATE_PAYMENT',
    });
  });

  it.each([OrderStatus.CONFIRMED, OrderStatus.SHIPPING, OrderStatus.DELIVERED])(
    'an order in %s that THIS payment confirmed: nothing to do, and the money is not touched',
    async (status) => {
      orderIs(status);
      payments.listByOrder.mockResolvedValue([
        paymentOf(),
        paymentOf({
          id: 'pay-2',
          updatedAt: new Date('2026-10-12T10:09:00.000Z'),
        }), // a later one is the extra
      ]);

      expect(await finish()).toEqual({ kind: 'NOTHING_TO_DO' });
      expect(calls).toEqual([]);
    },
  );

  it('another payment that is not SUCCEEDED any more (it left for a refund) is not the one that paid the order', async () => {
    orderIs(OrderStatus.CONFIRMED);
    payments.listByOrder.mockResolvedValue([
      paymentOf(),
      paymentOf({
        id: 'pay-0',
        status: PaymentStatus.REFUNDED,
        updatedAt: new Date('2026-10-12T10:01:00.000Z'),
      }),
    ]);

    expect(await finish()).toEqual({ kind: 'NOTHING_TO_DO' });
  });

  it.each([
    PaymentStatus.INITIATED,
    PaymentStatus.FAILED,
    PaymentStatus.REFUND_PENDING,
    PaymentStatus.REFUNDED,
  ])(
    'a payment that is %s is not finished (only SUCCEEDED is)',
    async (status) => {
      payments.findById.mockResolvedValue(paymentOf({ status }));

      expect(await finish()).toEqual({ kind: 'NOTHING_TO_DO' });
      expect(queryBus.execute).not.toHaveBeenCalled();
    },
  );

  it('a payment that does not exist: nothing to do', async () => {
    payments.findById.mockResolvedValue(null);

    expect(await finish()).toEqual({ kind: 'NOTHING_TO_DO' });
  });

  it('an order that moved while it was confirming: it looks again ONCE, and refunds when the order is closed now', async () => {
    let looks = 0;
    queryBus.execute.mockImplementation(async () =>
      orderOf(
        looks++ === 0 ? OrderStatus.PAYMENT_PROCESSING : OrderStatus.EXPIRED,
      ),
    );
    confirm = () => {
      throw notAllowed();
    };

    expect(await finish()).toEqual({
      kind: 'REFUNDING',
      reason: 'ORDER_CLOSED',
    });
    expect(queryBus.execute).toHaveBeenCalledTimes(2);
  });

  it('an order that keeps refusing is not looked at for ever: the second refusal sends the money back', async () => {
    confirm = () => {
      throw notAllowed();
    };

    expect(await finish()).toEqual({
      kind: 'REFUNDING',
      reason: 'ORDER_NOT_WAITING',
    });
    expect(queryBus.execute).toHaveBeenCalledTimes(2);
  });

  it('any other failure while confirming goes on (the sweep finishes it later)', async () => {
    const down = new Error('Postgres down');
    confirm = () => {
      throw down;
    };

    await expect(finish()).rejects.toBe(down);
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('a failing refund is not an error here: the payment stays REFUND_PENDING for the sweep', async () => {
    orderIs(OrderStatus.CANCELLED);
    bus.execute.mockImplementation(async (command: object) => {
      if (command instanceof RefundPaymentCommand)
        throw new Error('gateway down');
    });

    expect(await finish()).toEqual({
      kind: 'REFUNDING',
      reason: 'ORDER_CLOSED',
    });
  });

  it('an order that does not exist is treated as closed: money is never kept for nothing', async () => {
    queryBus.execute.mockRejectedValue(
      new DomainException(OrderErrorCodes.NOT_FOUND),
    );

    expect(await finish()).toEqual({
      kind: 'REFUNDING',
      reason: 'ORDER_CLOSED',
    });
  });
});

describe('RefundPaymentHandler', () => {
  let payments: any;
  let gateway: { refund: ReturnType<typeof vi.fn> };
  const refund = (options: { markFirst?: boolean } = {}) =>
    new RefundPaymentHandler(
      payments as IPaymentRepository,
      gateway as unknown as IPaymentGateway,
    ).execute(new RefundPaymentCommand('pay-1', options));

  beforeEach(() => {
    payments = {
      findById: vi.fn(async () =>
        paymentOf({ status: PaymentStatus.REFUND_PENDING }),
      ),
      transition: vi.fn(
        async (_id: string, _from: unknown, to: PaymentStatus) =>
          paymentOf({ status: to }),
      ),
    };
    gateway = { refund: vi.fn(async () => ({ refundRef: 'refund-1' })) };
  });

  it('asks the gateway for what was collected, THEN marks the payment REFUNDED with its event', async () => {
    payments.findById.mockResolvedValue(
      paymentOf({ status: PaymentStatus.REFUND_PENDING, paidAmount: 90000 }),
    );
    const order: string[] = [];
    gateway.refund.mockImplementation(async () => {
      order.push('gateway');
      return { refundRef: 'r' };
    });
    payments.transition.mockImplementation(async () => {
      order.push('mark');
      return paymentOf({ status: PaymentStatus.REFUNDED });
    });

    expect(await refund()).toEqual({ kind: 'REFUNDED' });

    expect(order).toEqual(['gateway', 'mark']);
    expect(gateway.refund).toHaveBeenCalledWith({
      paymentId: 'pay-1',
      providerRef: 'ref-1',
      amount: 90000,
    });
    expect(payments.transition).toHaveBeenCalledWith(
      'pay-1',
      [PaymentStatus.REFUND_PENDING],
      PaymentStatus.REFUNDED,
      expect.objectContaining({
        type: 'payment.refunded',
        payload: expect.objectContaining({ amount: 90000 }),
      }),
    );
  });

  it('with markFirst, a SUCCEEDED payment is moved to REFUND_PENDING first; without it, it is left alone', async () => {
    payments.findById.mockResolvedValue(
      paymentOf({ status: PaymentStatus.SUCCEEDED }),
    );

    expect(await refund()).toEqual({ kind: 'NOTHING_TO_DO' });
    expect(gateway.refund).not.toHaveBeenCalled();

    expect(await refund({ markFirst: true })).toEqual({ kind: 'REFUNDED' });
    expect(payments.transition.mock.calls[0].slice(1, 3)).toEqual([
      [PaymentStatus.SUCCEEDED],
      PaymentStatus.REFUND_PENDING,
    ]);
    expect(gateway.refund).toHaveBeenCalledTimes(1);
  });

  it('a payment that is already REFUNDED answers REFUNDED without asking the gateway', async () => {
    payments.findById.mockResolvedValue(
      paymentOf({ status: PaymentStatus.REFUNDED }),
    );

    expect(await refund()).toEqual({ kind: 'REFUNDED' });
    expect(gateway.refund).not.toHaveBeenCalled();
  });

  it.each([
    PaymentStatus.INITIATED,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
  ])(
    'a payment that is %s has nothing to refund, even with markFirst',
    async (status) => {
      payments.findById.mockResolvedValue(paymentOf({ status }));

      expect(await refund({ markFirst: true })).toEqual({
        kind: 'NOTHING_TO_DO',
      });
      expect(gateway.refund).not.toHaveBeenCalled();
    },
  );

  it('a payment that does not exist: nothing to do', async () => {
    payments.findById.mockResolvedValue(null);

    expect(await refund()).toEqual({ kind: 'NOTHING_TO_DO' });
  });

  it('a gateway that cannot be reached: RETRY_LATER, and the payment stays as it is', async () => {
    gateway.refund.mockRejectedValue(new GatewayUnavailable());

    expect(await refund()).toEqual({ kind: 'RETRY_LATER' });
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('a gateway that refuses: REFUSED, and the payment stays as it is', async () => {
    gateway.refund.mockRejectedValue(new GatewayRejected('no'));

    expect(await refund()).toEqual({ kind: 'REFUSED' });
    expect(payments.transition).not.toHaveBeenCalled();
  });

  it('an unexpected failure of the gateway call goes on', async () => {
    const bug = new Error('a bug in the adapter');
    gateway.refund.mockRejectedValue(bug);

    await expect(refund()).rejects.toBe(bug);
  });

  it('a payment waiting for a refund with no gateway reference cannot be refunded: REFUSED, nothing is sent', async () => {
    payments.findById.mockResolvedValue(
      paymentOf({ status: PaymentStatus.REFUND_PENDING, providerRef: null }),
    );

    expect(await refund()).toEqual({ kind: 'REFUSED' });
    expect(gateway.refund).not.toHaveBeenCalled();
  });

  it('when the payment was already marked by a repeat of this command, it is still REFUNDED', async () => {
    payments.transition.mockResolvedValue(null);

    expect(await refund()).toEqual({ kind: 'REFUNDED' });
  });
});
