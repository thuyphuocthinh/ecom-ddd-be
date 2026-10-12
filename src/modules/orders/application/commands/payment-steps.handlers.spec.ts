import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { CommandBus } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import { OrderErrorCodes } from '@/core/index.js';
import { ReleaseReservationCommand } from '../../../inventory/application/index.js';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  type IOrderRepository,
} from '../../domain/index.js';
import {
  FindStuckPaymentOrdersHandler,
  GetOrderByIdHandler,
} from '../queries/order.query-handlers.js';
import {
  FindStuckPaymentOrdersQuery,
  GetOrderByIdQuery,
} from '../queries/order.queries.js';
import {
  ExpireOrderCommand,
  ReopenOrderCommand,
  StartOrderPaymentCommand,
} from './payment-steps.commands.js';
import {
  ExpireOrderHandler,
  ReopenOrderHandler,
  StartOrderPaymentHandler,
} from './payment-steps.handlers.js';

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
const orderOf = (status: OrderStatus, method = PaymentMethod.ONLINE) => {
  const created = Order.create({
    userId: 'user-1',
    idempotencyKey: 'checkout-key-0001',
    paymentMethod: method,
    shippingAddress: ADDRESS,
    items: [
      {
        skuId: 'A',
        productName: 'A',
        thumbnail: null,
        attributes: {},
        unitPrice: 100,
        quantity: 1,
      },
    ],
    expiresAt: new Date(Date.now() + 60_000),
  });
  return Order.restore({ ...created, status } as never);
};
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string };
  }
  throw new Error('expected a rejection');
};

describe('the order steps of an online payment (AC-20)', () => {
  let orders: any;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    orders = {
      findById: vi.fn(),
      transition: vi.fn(async (_id, _from, to) =>
        Order.restore({ ...orderOf(OrderStatus.PENDING), status: to } as never),
      ),
    };
  });

  describe('StartOrderPaymentHandler', () => {
    const start = (expiresAt = new Date('2026-10-12T10:15:00.000Z')) =>
      new StartOrderPaymentHandler(orders as IOrderRepository).execute(
        new StartOrderPaymentCommand('O1', expiresAt),
      );

    it('moves a PENDING online order to PAYMENT_PROCESSING with the new time to pay, and writes the event', async () => {
      const expiresAt = new Date('2026-10-12T10:15:00.000Z');
      orders.findById.mockResolvedValue(orderOf(OrderStatus.PENDING));

      const result = await start(expiresAt);

      expect(result.status).toBe('PAYMENT_PROCESSING');
      expect(orders.transition).toHaveBeenCalledWith(
        'O1',
        OrderStatus.PENDING,
        OrderStatus.PAYMENT_PROCESSING,
        expect.objectContaining({
          type: 'order.status_changed',
          payload: expect.objectContaining({
            from: 'PENDING',
            to: 'PAYMENT_PROCESSING',
          }),
        }),
        { expiresAt },
      );
    });

    it.each([
      [
        'a cash on delivery order',
        orderOf(OrderStatus.PENDING, PaymentMethod.COD),
      ],
      ['an order already being paid', orderOf(OrderStatus.PAYMENT_PROCESSING)],
      ['a confirmed order', orderOf(OrderStatus.CONFIRMED)],
      ['a cancelled order', orderOf(OrderStatus.CANCELLED)],
      ['an expired order', orderOf(OrderStatus.EXPIRED)],
    ])(
      'refuses %s with ORD-006 without changing anything',
      async (_, order) => {
        orders.findById.mockResolvedValue(order);

        const error = await rejection(start());

        expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
        expect(orders.transition).not.toHaveBeenCalled();
      },
    );

    it('says ORD-006 when another change got to the order first', async () => {
      orders.findById.mockResolvedValue(orderOf(OrderStatus.PENDING));
      orders.transition.mockResolvedValue(null);

      const error = await rejection(start());

      expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
    });

    it('says ORD-002 for an order that does not exist', async () => {
      orders.findById.mockResolvedValue(null);

      const error = await rejection(start());

      expect(error.code).toBe(OrderErrorCodes.NOT_FOUND.code);
    });

    it('refuses a time to pay that is not a time (ORD-000), before reading anything', async () => {
      for (const bad of [
        new Date('nope'),
        'tomorrow' as never,
        null as never,
      ]) {
        const error = await rejection(Promise.resolve().then(() => start(bad)));
        expect(error.code).toBe(OrderErrorCodes.DOMAIN_EXCEPTION.code);
      }
      expect(orders.findById).not.toHaveBeenCalled();
    });
  });

  describe('ReopenOrderHandler', () => {
    const reopen = () =>
      new ReopenOrderHandler(orders as IOrderRepository).execute(
        new ReopenOrderCommand('O1'),
      );

    it('moves an order being paid back to PENDING, keeping its time to pay', async () => {
      orders.findById.mockResolvedValue(
        orderOf(OrderStatus.PAYMENT_PROCESSING),
      );

      const result = await reopen();

      expect(result.status).toBe('PENDING');
      expect(orders.transition).toHaveBeenCalledWith(
        'O1',
        OrderStatus.PAYMENT_PROCESSING,
        OrderStatus.PENDING,
        expect.anything(),
        undefined,
      );
    });

    it.each([OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.EXPIRED])(
      'refuses an order in %s with ORD-006',
      async (status) => {
        orders.findById.mockResolvedValue(orderOf(status));

        const error = await rejection(reopen());

        expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
        expect(orders.transition).not.toHaveBeenCalled();
      },
    );
  });

  describe('ExpireOrderHandler', () => {
    let calls: string[];
    let bus: { execute: ReturnType<typeof vi.fn> };
    const expire = () =>
      new ExpireOrderHandler(
        orders as IOrderRepository,
        bus as unknown as CommandBus,
      ).execute(new ExpireOrderCommand('O1'));

    beforeEach(() => {
      calls = [];
      orders.transition.mockImplementation(
        async (_id: string, _from: unknown, to: OrderStatus) => {
          calls.push(`transition:${to}`);
          return Order.restore({
            ...orderOf(OrderStatus.PENDING),
            status: to,
          } as never);
        },
      );
      bus = {
        execute: vi.fn(async (command: object) => {
          calls.push(command.constructor.name);
        }),
      };
    });

    it.each([OrderStatus.PENDING, OrderStatus.PAYMENT_PROCESSING])(
      'expires an online order in %s FIRST and gives the held stock back SECOND',
      async (status) => {
        orders.findById.mockResolvedValue(orderOf(status));

        const result = await expire();

        expect(result.status).toBe('EXPIRED');
        expect(calls).toEqual([
          'transition:EXPIRED',
          'ReleaseReservationCommand',
        ]);
        expect(bus.execute.mock.calls[0][0]).toEqual(
          new ReleaseReservationCommand('O1'),
        );
      },
    );

    it('expires a cash on delivery order that is still PENDING too', async () => {
      orders.findById.mockResolvedValue(
        orderOf(OrderStatus.PENDING, PaymentMethod.COD),
      );

      await expect(expire()).resolves.toMatchObject({ status: 'EXPIRED' });
    });

    it.each([
      OrderStatus.CONFIRMED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
      OrderStatus.SHIPPING,
    ])(
      'refuses an order in %s with ORD-006 and does not touch the stock',
      async (status) => {
        orders.findById.mockResolvedValue(orderOf(status));

        const error = await rejection(expire());

        expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
        expect(bus.execute).not.toHaveBeenCalled();
      },
    );

    it('does not touch the stock when another change got to the order first', async () => {
      orders.findById.mockResolvedValue(orderOf(OrderStatus.PENDING));
      orders.transition.mockResolvedValue(null);

      await rejection(expire());

      expect(bus.execute).not.toHaveBeenCalled();
    });

    it('still expires the order when the stock cannot be given back (it runs out by itself)', async () => {
      orders.findById.mockResolvedValue(
        orderOf(OrderStatus.PAYMENT_PROCESSING),
      );
      bus.execute.mockRejectedValue(new Error('Redis down'));

      await expect(expire()).resolves.toMatchObject({ status: 'EXPIRED' });
    });
  });

  describe('FindStuckPaymentOrdersHandler', () => {
    const find = (seconds: number, limit: number) =>
      new FindStuckPaymentOrdersHandler(orders as IOrderRepository).execute(
        new FindStuckPaymentOrdersQuery(seconds, limit),
      );

    it('asks the repository for the ids', async () => {
      orders.findStuckPaymentOrderIds = vi.fn(async () => ['O1', 'O2']);

      await expect(Promise.resolve(find(60, 100))).resolves.toEqual([
        'O1',
        'O2',
      ]);
      expect(orders.findStuckPaymentOrderIds).toHaveBeenCalledWith(60, 100);
    });

    it.each([
      [-1, 10],
      [1.5, 10],
      [60, 0],
      [60, 1001],
      [Number.NaN, 10],
    ])(
      'refuses %s seconds and a limit of %s (ORD-000)',
      async (seconds, limit) => {
        orders.findStuckPaymentOrderIds = vi.fn();

        const error = await rejection(
          Promise.resolve().then(() => find(seconds, limit)),
        );

        expect(error.code).toBe(OrderErrorCodes.DOMAIN_EXCEPTION.code);
        expect(orders.findStuckPaymentOrderIds).not.toHaveBeenCalled();
      },
    );
  });
  describe('GetOrderByIdHandler', () => {
    it('gives the order whoever it belongs to (an internal read for other modules)', async () => {
      const order = orderOf(OrderStatus.PAYMENT_PROCESSING);
      orders.findById.mockResolvedValue(order);

      const read = await new GetOrderByIdHandler(
        orders as IOrderRepository,
      ).execute(new GetOrderByIdQuery('O1'));

      expect(read).toBe(order);
      expect(orders.findById).toHaveBeenCalledWith('O1');
    });

    it('says ORD-002 for an order that does not exist', async () => {
      orders.findById.mockResolvedValue(null);

      const error = await rejection(
        new GetOrderByIdHandler(orders as IOrderRepository).execute(
          new GetOrderByIdQuery('O1'),
        ),
      );

      expect(error.code).toBe(OrderErrorCodes.NOT_FOUND.code);
    });
  });
});
