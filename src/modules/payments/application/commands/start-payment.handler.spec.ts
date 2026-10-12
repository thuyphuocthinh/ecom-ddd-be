import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import {
  DomainException,
  InventoryErrorCodes,
  OrderErrorCodes,
  PaymentErrorCodes,
  type LockService,
} from '@/core/index.js';
import { ExtendReservationCommand } from '../../../inventory/application/index.js';
import { InventoryDomainException } from '../../../inventory/domain/index.js';
import {
  GetOrderQuery,
  ReopenOrderCommand,
  StartOrderPaymentCommand,
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
  MAX_ATTEMPTS_PER_ORDER,
  Payment,
  PaymentAlreadyExistsError,
  PaymentInProgressError,
  PaymentStatus,
  derivePaymentId,
  type IPaymentRepository,
} from '../../domain/index.js';
import { FakePaymentGateway } from '../../infrastructure/gateways/fake-payment.gateway.js';
import type { PaymentsConfig } from '../../payments.config.js';
import { StartPaymentCommand } from './start-payment.command.js';
import { StartPaymentHandler } from './start-payment.handler.js';

const USER = 'user-1';
const ORDER_ID = 'order-1';
const KEY = 'pay-attempt-0001';
const HOLD_UNTIL = new Date(Date.now() + 15 * 60_000);
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
const orderOf = (
  status = OrderStatus.PENDING,
  method = PaymentMethod.ONLINE,
  price = 150000,
) => {
  const created = Order.create({
    userId: USER,
    idempotencyKey: 'checkout-key-0001',
    paymentMethod: method,
    shippingAddress: ADDRESS,
    items: [
      {
        skuId: 'A',
        productName: 'A',
        thumbnail: null,
        attributes: {},
        unitPrice: price,
        quantity: 1,
      },
    ],
    expiresAt: HOLD_UNTIL,
  });
  return Order.restore({ ...created, id: ORDER_ID, status } as never);
};
const paymentOf = (overrides: Record<string, unknown> = {}) =>
  Payment.restore({
    id: derivePaymentId(ORDER_ID, KEY),
    orderId: ORDER_ID,
    idempotencyKey: KEY,
    provider: 'fake',
    status: PaymentStatus.INITIATED,
    version: 1,
    amount: 150000,
    paidAmount: null,
    providerRef: null,
    payUrl: null,
    expiresAt: HOLD_UNTIL,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as DomainException;
  }
  throw new Error('expected a rejection');
};

const setup = (
  options: { order?: Order; existing?: Payment | null; attempts?: number } = {},
) => {
  const calls: string[] = [];
  const gateway = new FakePaymentGateway({
    secret: 'a-fake-gateway-secret-of-length',
  });
  const createCharge = vi.spyOn(gateway, 'createCharge');
  const payments = {
    findById: vi.fn(async (id: string): Promise<Payment | null> => {
      calls.push('payments.findById');
      if (options.existing === undefined) return created.get(id) ?? null;
      return options.existing;
    }),
    countByOrder: vi.fn(async () => options.attempts ?? 0),
    create: vi.fn(async (p: Payment) => {
      calls.push('payments.create');
      created.set(p.id, p);
    }),
    attachCharge: vi.fn(
      async (id: string, providerRef: string, payUrl: string) => {
        calls.push('payments.attachCharge');
        const p = created.get(id);
        if (p)
          created.set(
            id,
            paymentOf({
              ...p,
              providerRef,
              payUrl,
              id: p.id,
              amount: p.amount,
            }),
          );
        return true;
      },
    ),
    transition: vi.fn(async (id: string) => {
      calls.push('payments.transition');
      return paymentOf({ id, status: PaymentStatus.FAILED });
    }),
  };
  const created = new Map<string, Payment>();
  const lock = {
    run: vi.fn(async (name: string, work: () => Promise<unknown>) => {
      calls.push(`lock:${name}`);
      return work();
    }),
  };
  const queryBus = {
    execute: vi.fn(async (_query?: unknown) => {
      calls.push('order.get');
      return options.order ?? orderOf();
    }),
  };
  const commandBus = {
    execute: vi.fn(async (command: object): Promise<unknown> => {
      calls.push(command.constructor.name);
      if (command instanceof ExtendReservationCommand) {
        return { orderId: ORDER_ID, expiresAt: HOLD_UNTIL };
      }
      return undefined;
    }),
  };
  const config = {
    gateway: 'fake',
    windowMinutes: 15,
    maintenanceIntervalSeconds: 60,
    webhookToleranceSeconds: 300,
    fakeWebhookSecret: 'x',
  } as PaymentsConfig;
  const handler = new StartPaymentHandler(
    payments as unknown as IPaymentRepository,
    gateway,
    lock as unknown as LockService,
    commandBus as unknown as CommandBus,
    queryBus as unknown as QueryBus,
    config,
  );
  return {
    handler,
    calls,
    gateway,
    createCharge,
    payments,
    lock,
    queryBus,
    commandBus,
  };
};

const start = (key = KEY) => new StartPaymentCommand(USER, ORDER_ID, key);

describe('StartPaymentHandler', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('does the steps in the safe order: the order, extend the hold, move the order, write the payment, ask the gateway, store the answer', async () => {
    const s = setup();

    const result = await s.handler.execute(start());

    expect(s.calls).toEqual([
      `lock:payment:start:${ORDER_ID}`,
      'order.get',
      'payments.findById',
      'ExtendReservationCommand',
      'StartOrderPaymentCommand',
      'payments.create',
      'payments.attachCharge',
      'payments.findById',
    ]);
    expect(result.replayed).toBe(false);
    expect(result.payment).toMatchObject({
      status: 'INITIATED',
      amount: 150000,
      provider: 'fake',
    });
    expect(result.payment.providerRef).toMatch(/^fake_/);
    expect(result.payment.payUrl).toContain('/dev/fake-gateway/charges/');
  });

  it('takes the amount from the order, the time to pay from the extended hold, and asks the gateway with the payment id', async () => {
    const s = setup({
      order: orderOf(OrderStatus.PENDING, PaymentMethod.ONLINE, 199000.5),
    });

    const { payment } = await s.handler.execute(start());

    expect(payment.amount).toBe(199000.5);
    expect(payment.expiresAt.getTime()).toBe(HOLD_UNTIL.getTime());
    expect(payment.id).toBe(derivePaymentId(ORDER_ID, KEY));
    expect(s.createCharge).toHaveBeenCalledWith({
      paymentId: payment.id,
      orderId: ORDER_ID,
      amount: 199000.5,
    });
    const extend = s.commandBus.execute.mock.calls
      .map(([c]) => c)
      .find(
        (c) => c instanceof ExtendReservationCommand,
      ) as ExtendReservationCommand;
    expect(extend).toMatchObject({ orderId: ORDER_ID, seconds: 15 * 60 });
    const startOrder = s.commandBus.execute.mock.calls
      .map(([c]) => c)
      .find(
        (c) => c instanceof StartOrderPaymentCommand,
      ) as StartOrderPaymentCommand;
    expect(startOrder).toMatchObject({
      orderId: ORDER_ID,
      expiresAt: HOLD_UNTIL,
    });
  });

  it("asks for the order of THIS user: another user's order is the answer of the order module (ORD-002), and nothing else happens", async () => {
    const s = setup();
    s.queryBus.execute.mockRejectedValueOnce(
      new OrderDomainException(OrderErrorCodes.NOT_FOUND),
    );

    const error = await rejection(s.handler.execute(start()));

    expect(error.code).toBe(OrderErrorCodes.NOT_FOUND.code);
    expect(s.queryBus.execute.mock.calls[0][0]).toEqual(
      new GetOrderQuery(USER, ORDER_ID),
    );
    expect(s.commandBus.execute).not.toHaveBeenCalled();
    expect(s.payments.create).not.toHaveBeenCalled();
  });

  it.each(['', 'short', 'has space in it!', 'x'.repeat(101), null as never])(
    'refuses the key %j with PAY-001 before taking any lock',
    async (key) => {
      const s = setup();

      const error = await rejection(s.handler.execute(start(key)));

      expect(error.code).toBe(PaymentErrorCodes.INVALID_IDEMPOTENCY_KEY.code);
      expect(s.lock.run).not.toHaveBeenCalled();
    },
  );

  describe('what it refuses, changing nothing (AC-3)', () => {
    const nothingChanged = (s: ReturnType<typeof setup>) => {
      expect(s.commandBus.execute).not.toHaveBeenCalled();
      expect(s.payments.create).not.toHaveBeenCalled();
      expect(s.createCharge).not.toHaveBeenCalled();
    };

    it('a cash on delivery order: PAY-002', async () => {
      const s = setup({
        order: orderOf(OrderStatus.CONFIRMED, PaymentMethod.COD),
      });

      expect((await rejection(s.handler.execute(start()))).code).toBe(
        PaymentErrorCodes.NOT_ONLINE.code,
      );
      nothingChanged(s);
    });

    it.each([
      OrderStatus.PAYMENT_PROCESSING,
      OrderStatus.CONFIRMED,
      OrderStatus.SHIPPING,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
    ])('an online order in %s: PAY-003', async (status) => {
      const s = setup({ order: orderOf(status) });

      expect((await rejection(s.handler.execute(start()))).code).toBe(
        PaymentErrorCodes.NOT_PAYABLE.code,
      );
      nothingChanged(s);
    });

    it('an order that has used up its attempts: PAY-004', async () => {
      const s = setup({ attempts: MAX_ATTEMPTS_PER_ORDER });

      expect((await rejection(s.handler.execute(start()))).code).toBe(
        PaymentErrorCodes.TOO_MANY_ATTEMPTS.code,
      );
      nothingChanged(s);
    });

    it('lets the last attempt through', async () => {
      const s = setup({ attempts: MAX_ATTEMPTS_PER_ORDER - 1 });

      await expect(s.handler.execute(start())).resolves.toMatchObject({
        replayed: false,
      });
    });

    it.each([
      [
        'a hold that was given back or paid (INV-009)',
        InventoryErrorCodes.EXTEND_NOT_ALLOWED,
      ],
      [
        'an order that holds nothing (INV-003)',
        InventoryErrorCodes.RESERVATION_NOT_FOUND,
      ],
    ])('%s: PAY-005, and the order is not moved', async (_, code) => {
      const s = setup();
      s.commandBus.execute.mockRejectedValueOnce(
        new InventoryDomainException(code),
      );

      const error = await rejection(s.handler.execute(start()));

      expect(error.code).toBe(PaymentErrorCodes.TIME_RAN_OUT.code);
      expect(s.calls).not.toContain('StartOrderPaymentCommand');
      expect(s.payments.create).not.toHaveBeenCalled();
    });

    it('any other failure of the stock service passes through', async () => {
      const s = setup();
      const down = new Error('Postgres down');
      s.commandBus.execute.mockRejectedValueOnce(down);

      await expect(s.handler.execute(start())).rejects.toBe(down);
      expect(s.payments.create).not.toHaveBeenCalled();
    });

    it('an order that another request moved first (ORD-006): PAY-003, and no payment is written', async () => {
      const s = setup();
      const original = s.commandBus.execute.getMockImplementation()!;
      s.commandBus.execute.mockImplementation(async (command: object) => {
        if (command instanceof StartOrderPaymentCommand) {
          throw new OrderDomainException(
            OrderErrorCodes.INVALID_STATE_TRANSITION,
          );
        }
        return original(command);
      });

      const error = await rejection(s.handler.execute(start()));

      expect(error.code).toBe(PaymentErrorCodes.NOT_PAYABLE.code);
      expect(s.payments.create).not.toHaveBeenCalled();
      expect(s.createCharge).not.toHaveBeenCalled();
    });
  });

  describe('a request sent again (AC-2)', () => {
    it('gives back the payment that has its charge, and touches nothing else', async () => {
      const existing = paymentOf({
        providerRef: 'ref-1',
        payUrl: 'https://pay/1',
      });
      const s = setup({ existing });

      const result = await s.handler.execute(start());

      expect(result).toEqual({ payment: existing, replayed: true });
      expect(s.commandBus.execute).not.toHaveBeenCalled();
      expect(s.payments.create).not.toHaveBeenCalled();
      expect(s.createCharge).not.toHaveBeenCalled();
    });

    it('answers from the payment even when the order is not PENDING any more (it is being paid)', async () => {
      const existing = paymentOf({
        providerRef: 'ref-1',
        payUrl: 'https://pay/1',
      });
      const s = setup({
        existing,
        order: orderOf(OrderStatus.PAYMENT_PROCESSING),
      });

      await expect(s.handler.execute(start())).resolves.toMatchObject({
        replayed: true,
      });
    });

    it('finishes the charge a payment still lacks (the process died after writing it): asks the gateway and stores the answer', async () => {
      const existing = paymentOf();
      const s = setup({ existing });

      const result = await s.handler.execute(start());

      expect(result.replayed).toBe(true);
      expect(s.createCharge).toHaveBeenCalledTimes(1);
      expect(s.payments.attachCharge).toHaveBeenCalledTimes(1);
      expect(s.calls).not.toContain('ExtendReservationCommand');
      expect(s.calls).not.toContain('payments.create');
    });

    it.each([
      PaymentStatus.FAILED,
      PaymentStatus.EXPIRED,
      PaymentStatus.SUCCEEDED,
      PaymentStatus.REFUNDED,
    ])(
      'gives back a payment that is %s as it is, without asking the gateway',
      async (status) => {
        const existing = paymentOf({ status });
        const s = setup({ existing });

        const result = await s.handler.execute(start());

        expect(result).toEqual({ payment: existing, replayed: true });
        expect(s.createCharge).not.toHaveBeenCalled();
      },
    );
  });

  describe('when the payment cannot be written', () => {
    it('another copy of the same request wrote it first: that payment is the answer, and the order is not reopened', async () => {
      const s = setup();
      const saved = paymentOf({
        providerRef: 'ref-1',
        payUrl: 'https://pay/1',
      });
      s.payments.findById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(saved);
      s.payments.create.mockRejectedValueOnce(
        new PaymentAlreadyExistsError('p'),
      );

      const result = await s.handler.execute(start());

      expect(result).toEqual({ payment: saved, replayed: true });
      expect(s.calls).not.toContain('ReopenOrderCommand');
    });

    it('another payment is in progress for the order and none is ours: the order is put back and the answer is PAY-003', async () => {
      const s = setup();
      s.payments.create.mockRejectedValueOnce(
        new PaymentInProgressError(ORDER_ID),
      );

      const error = await rejection(s.handler.execute(start()));

      expect(error.code).toBe(PaymentErrorCodes.NOT_PAYABLE.code);
      expect(s.commandBus.execute.mock.calls.map(([c]) => c)).toContainEqual(
        new ReopenOrderCommand(ORDER_ID),
      );
      expect(s.createCharge).not.toHaveBeenCalled();
    });

    it('the database failed: the order is put back and the error passes through', async () => {
      const s = setup();
      const down = new Error('connection lost');
      s.payments.create.mockRejectedValueOnce(down);

      await expect(s.handler.execute(start())).rejects.toBe(down);
      expect(s.commandBus.execute.mock.calls.map(([c]) => c)).toContainEqual(
        new ReopenOrderCommand(ORDER_ID),
      );
    });

    it('still passes the original error on when putting the order back fails too (the sweep will)', async () => {
      const s = setup();
      const down = new Error('connection lost');
      s.payments.create.mockRejectedValueOnce(down);
      const original = s.commandBus.execute.getMockImplementation()!;
      s.commandBus.execute.mockImplementation(async (command: object) => {
        if (command instanceof ReopenOrderCommand) throw new Error('also down');
        return original(command);
      });

      await expect(s.handler.execute(start())).rejects.toBe(down);
    });
  });

  describe('when the gateway fails (AC-4)', () => {
    it.each([
      ['cannot be reached', () => new GatewayUnavailable()],
      ['refuses the request', () => new GatewayRejected('no')],
    ])(
      'a gateway that %s: the payment is failed, the order is opened again, and the customer gets PAY-006 (503)',
      async (_, error) => {
        const s = setup();
        s.createCharge.mockRejectedValueOnce(error());

        const thrown = await rejection(s.handler.execute(start()));

        expect(thrown.code).toBe(PaymentErrorCodes.GATEWAY_UNAVAILABLE.code);
        expect(thrown.status).toBe(503);
        expect(s.payments.transition).toHaveBeenCalledWith(
          derivePaymentId(ORDER_ID, KEY),
          [PaymentStatus.INITIATED],
          PaymentStatus.FAILED,
          expect.objectContaining({ type: 'payment.failed' }),
        );
        expect(s.commandBus.execute.mock.calls.map(([c]) => c)).toContainEqual(
          new ReopenOrderCommand(ORDER_ID),
        );
        expect(s.payments.attachCharge).not.toHaveBeenCalled();
      },
    );

    it('does not reopen the order when it was not this request that failed the payment', async () => {
      const s = setup();
      s.createCharge.mockRejectedValueOnce(new GatewayUnavailable());
      s.payments.transition.mockResolvedValueOnce(null as never);

      await rejection(s.handler.execute(start()));

      expect(s.calls).not.toContain('ReopenOrderCommand');
    });

    it('still answers PAY-006 when the payment cannot be marked failed (the sweep expires it)', async () => {
      const s = setup();
      s.createCharge.mockRejectedValueOnce(new GatewayUnavailable());
      s.payments.transition.mockRejectedValueOnce(new Error('Postgres down'));

      const error = await rejection(s.handler.execute(start()));

      expect(error.code).toBe(PaymentErrorCodes.GATEWAY_UNAVAILABLE.code);
      expect(s.calls).not.toContain('ReopenOrderCommand');
    });

    it('an unexpected failure of the gateway call passes through and leaves the payment waiting, so a repeat can finish it', async () => {
      const s = setup();
      const bug = new Error('a bug in the adapter');
      s.createCharge.mockRejectedValueOnce(bug);

      await expect(s.handler.execute(start())).rejects.toBe(bug);
      expect(s.payments.transition).not.toHaveBeenCalled();
    });

    it('a repeat after a gateway that was down finds the failed payment and returns it (a new key starts again)', async () => {
      const existing = paymentOf({ status: PaymentStatus.FAILED });
      const s = setup({ existing });

      const result = await s.handler.execute(start());

      expect(result.payment.status).toBe('FAILED');
      expect(result.replayed).toBe(true);
    });
  });
});
