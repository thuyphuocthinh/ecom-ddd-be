import { vi } from 'vitest';
import type { CommandBus } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import {
  CoreErrorCodes,
  DomainException,
  InventoryErrorCodes,
  OrderErrorCodes,
  type LockService,
} from '@/core/index.js';
import {
  ReleaseReservationCommand,
  ReturnReservationCommand,
} from '../../../inventory/application/index.js';
import { InventoryDomainException } from '../../../inventory/domain/index.js';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  type IOrderRepository,
} from '../../domain/index.js';
import type { OrdersConfig } from '../../orders.config.js';
import { OrderStockReturner } from '../services/order-stock-returner.service.js';
import { OrderMaintenance } from '../maintenance/order-maintenance.service.js';
import { SWEEP_BATCH_SIZE, SWEEP_MAX_BATCHES } from '../sweep.js';
import { CancelOrderCommand } from './cancel-order.command.js';
import { CancelOrderHandler } from './cancel-order.handler.js';
import {
  ExpireDueOrdersHandler,
  FinishPendingCodOrdersHandler,
  ReturnStockForCancelledOrdersHandler,
} from './sweep.handlers.js';

const USER = 'user-1';
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
  status: OrderStatus,
  paymentMethod = PaymentMethod.COD,
  key = 'checkout-key-0001',
) => {
  const created = Order.create({
    userId: USER,
    idempotencyKey: key,
    paymentMethod,
    shippingAddress: ADDRESS,
    items: [
      {
        skuId: 'A',
        productName: 'Product A',
        thumbnail: null,
        attributes: {},
        unitPrice: 100,
        quantity: 2,
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
    return error as DomainException;
  }
  throw new Error('expected a rejection');
};

/** Fake order repository: `calls` records the order in which things happened. */
const fakeOrders = (calls: string[], stored: Order[] = []) => {
  const byId = new Map(stored.map((o) => [o.id, o]));
  return {
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
    findByIdForUser: vi.fn(async (userId: string, id: string) => {
      const order = byId.get(id);
      return order && order.userId === userId ? order : null;
    }),
    transition: vi.fn<(...args: any[]) => Promise<Order | null>>(
      async (
        id: string,
        _from: OrderStatus,
        to: OrderStatus,
        _e: unknown,
        options?: object,
      ) => {
        calls.push(`transition:${to}${options ? ':flag' : ''}`);
        const order = byId.get(id)!;
        return Order.restore({
          ...order,
          status: to,
          stockReturnPending: !!options,
        } as never);
      },
    ),
    findDueOnlineIds: vi.fn(async (_limit: number): Promise<string[]> => []),
    findPendingCodIds: vi.fn(
      async (_s: number, _limit: number): Promise<string[]> => [],
    ),
    findStockReturnPendingIds: vi.fn(
      async (_s: number, _limit: number): Promise<string[]> => [],
    ),
    clearStockReturnPending: vi.fn(async () => {
      calls.push('clearFlag');
    }),
  };
};

const fakeBus = (
  calls: string[],
  handlers: Record<string, (c: any) => unknown> = {},
) => ({
  execute: vi.fn(async (command: object) => {
    const name = command.constructor.name;
    calls.push(name);
    return handlers[name]?.(command);
  }),
});

beforeAll(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('CancelOrderHandler', () => {
  const setup = (
    order: Order | null,
    handlers: Record<string, (c: any) => unknown> = {},
  ) => {
    const calls: string[] = [];
    const orders = fakeOrders(calls, order ? [order] : []);
    const bus = fakeBus(calls, handlers);
    const returner = new OrderStockReturner(
      orders as unknown as IOrderRepository,
      bus as unknown as CommandBus,
    );
    const handler = new CancelOrderHandler(
      orders as unknown as IOrderRepository,
      returner,
      bus as unknown as CommandBus,
    );
    return { handler, calls, orders, bus };
  };

  it('PENDING: changes the order first, then gives the held stock back (no flag)', async () => {
    const order = orderOf(OrderStatus.PENDING, PaymentMethod.ONLINE);
    const s = setup(order);

    const result = await s.handler.execute(
      new CancelOrderCommand(USER, order.id),
    );

    expect(s.calls).toEqual([
      'transition:CANCELLED',
      'ReleaseReservationCommand',
    ]);
    expect(result.status).toBe('CANCELLED');
    expect(s.orders.transition).toHaveBeenCalledWith(
      order.id,
      OrderStatus.PENDING,
      OrderStatus.CANCELLED,
      expect.objectContaining({
        type: 'order.status_changed',
        payload: expect.objectContaining({ from: 'PENDING', to: 'CANCELLED' }),
      }),
      undefined,
    );
  });

  it('CONFIRMED: sets the flag in the same step as the cancel, THEN puts the stock back, THEN clears the flag', async () => {
    const order = orderOf(OrderStatus.CONFIRMED);
    const s = setup(order);

    await s.handler.execute(new CancelOrderCommand(USER, order.id));

    expect(s.calls).toEqual([
      'transition:CANCELLED:flag',
      'ReturnReservationCommand',
      'clearFlag',
    ]);
    expect(s.orders.transition).toHaveBeenCalledWith(
      order.id,
      OrderStatus.CONFIRMED,
      OrderStatus.CANCELLED,
      expect.anything(),
      { stockReturnPending: true },
    );
  });

  it('an order of another user or that does not exist is ORD-002, and nothing is touched', async () => {
    const order = orderOf(OrderStatus.PENDING);
    const s = setup(order);

    for (const [user, id] of [
      ['someone-else', order.id],
      [USER, 'no-such-order'],
    ]) {
      const error = await rejection(
        s.handler.execute(new CancelOrderCommand(user, id)),
      );
      expect(error.code).toBe(OrderErrorCodes.NOT_FOUND.code);
    }
    expect(s.calls).toEqual([]);
  });

  it.each([
    OrderStatus.PAYMENT_PROCESSING,
    OrderStatus.SHIPPING,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
  ])('%s cannot be cancelled: ORD-006, nothing touched', async (status) => {
    const order = orderOf(status, PaymentMethod.ONLINE);
    const s = setup(order);

    const error = await rejection(
      s.handler.execute(new CancelOrderCommand(USER, order.id)),
    );

    expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
    expect(s.calls).toEqual([]);
  });

  it('when another request moved the order first (shipped, expired...): ORD-006 and the stock is NOT touched', async () => {
    for (const status of [OrderStatus.PENDING, OrderStatus.CONFIRMED]) {
      const order = orderOf(status);
      const s = setup(order);
      s.orders.transition.mockResolvedValueOnce(null);

      const error = await rejection(
        s.handler.execute(new CancelOrderCommand(USER, order.id)),
      );

      expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
      expect(s.bus.execute).not.toHaveBeenCalled();
    }
  });

  it('PENDING: a hold that cannot be given back does not undo the cancel', async () => {
    const order = orderOf(OrderStatus.PENDING);
    const s = setup(order, {
      ReleaseReservationCommand: () => {
        throw new Error('Redis down');
      },
    });

    const result = await s.handler.execute(
      new CancelOrderCommand(USER, order.id),
    );

    expect(result.status).toBe('CANCELLED');
  });

  it('CONFIRMED: stock that cannot be put back leaves the flag ON (the sweep will), and the cancel stands', async () => {
    const order = orderOf(OrderStatus.CONFIRMED);
    const s = setup(order, {
      ReturnReservationCommand: () => {
        throw new Error('Postgres down');
      },
    });

    const result = await s.handler.execute(
      new CancelOrderCommand(USER, order.id),
    );

    expect(result).toMatchObject({
      status: 'CANCELLED',
      stockReturnPending: true,
    });
    expect(s.orders.clearStockReturnPending).not.toHaveBeenCalled();
  });
});

describe('OrderStockReturner', () => {
  const setup = (handlers: Record<string, (c: any) => unknown> = {}) => {
    const calls: string[] = [];
    const orders = fakeOrders(calls);
    const bus = fakeBus(calls, handlers);
    return {
      calls,
      orders,
      returner: new OrderStockReturner(
        orders as unknown as IOrderRepository,
        bus as unknown as CommandBus,
      ),
    };
  };

  it('puts the stock back, then clears the flag', async () => {
    const s = setup();
    await s.returner.putBack('o1');
    expect(s.calls).toEqual(['ReturnReservationCommand', 'clearFlag']);
  });

  it.each([
    [
      'never taken out (INV-008)',
      InventoryErrorCodes.RESERVATION_NOT_CONFIRMED,
    ],
    ['no record at all (INV-003)', InventoryErrorCodes.RESERVATION_NOT_FOUND],
  ])(
    'stock %s: nothing to wait for, so the flag is cleared',
    async (_, code) => {
      const s = setup({
        ReturnReservationCommand: () => {
          throw new InventoryDomainException(code);
        },
      });

      await s.returner.putBack('o1');

      expect(s.calls).toEqual(['ReturnReservationCommand', 'clearFlag']);
    },
  );

  it('any other failure is passed on and the flag stays on', async () => {
    const down = new Error('Postgres down');
    const s = setup({
      ReturnReservationCommand: () => {
        throw down;
      },
    });

    await expect(s.returner.putBack('o1')).rejects.toBe(down);
    expect(s.calls).toEqual(['ReturnReservationCommand']);
  });
});

describe('ExpireDueOrdersHandler', () => {
  const setup = (
    orders: Order[],
    handlers: Record<string, (c: any) => unknown> = {},
  ) => {
    const calls: string[] = [];
    const repo = fakeOrders(calls, orders);
    repo.findDueOnlineIds
      .mockResolvedValueOnce(orders.map((o) => o.id))
      .mockResolvedValue([]);
    const bus = fakeBus(calls, handlers);
    const handler = new ExpireDueOrdersHandler(
      repo as unknown as IOrderRepository,
      bus as unknown as CommandBus,
    );
    return { handler, calls, repo, bus };
  };

  it('moves each due order to EXPIRED first and gives its hold back second, and counts them', async () => {
    const a = orderOf(
      OrderStatus.PENDING,
      PaymentMethod.ONLINE,
      'checkout-key-000A',
    );
    const b = orderOf(
      OrderStatus.PENDING,
      PaymentMethod.ONLINE,
      'checkout-key-000B',
    );
    const s = setup([a, b]);

    const count = await s.handler.execute();

    expect(count).toBe(2);
    expect(s.calls).toEqual([
      'transition:EXPIRED',
      'ReleaseReservationCommand',
      'transition:EXPIRED',
      'ReleaseReservationCommand',
    ]);
  });

  it('leaves alone an order that was paid or cancelled a moment ago (the conditional update finds nothing)', async () => {
    const order = orderOf(OrderStatus.PENDING, PaymentMethod.ONLINE);
    const s = setup([order]);
    s.repo.transition.mockResolvedValueOnce(null);

    expect(await s.handler.execute()).toBe(0);
    expect(s.bus.execute).not.toHaveBeenCalled();
  });

  it('skips an order that is no longer PENDING when it is looked at', async () => {
    const s = setup([orderOf(OrderStatus.CONFIRMED, PaymentMethod.ONLINE)]);

    expect(await s.handler.execute()).toBe(0);
    expect(s.repo.transition).not.toHaveBeenCalled();
  });

  it('one order failing does not stop the others, and a hold that cannot be given back does not undo the expiry', async () => {
    const a = orderOf(
      OrderStatus.PENDING,
      PaymentMethod.ONLINE,
      'checkout-key-000A',
    );
    const b = orderOf(
      OrderStatus.PENDING,
      PaymentMethod.ONLINE,
      'checkout-key-000B',
    );
    const c = orderOf(
      OrderStatus.PENDING,
      PaymentMethod.ONLINE,
      'checkout-key-000C',
    );
    const s = setup([a, b, c], {
      ReleaseReservationCommand: (cmd: ReleaseReservationCommand) => {
        if (cmd.orderId === b.id) throw new Error('Redis down');
      },
    });
    s.repo.transition.mockImplementationOnce(async () => {
      throw new Error('Postgres hiccup');
    });

    const count = await s.handler.execute();

    expect(count).toBe(2); // a failed, b expired (hold failure swallowed), c expired
  });

  it('asks again while batches come back full, but never more than the maximum', async () => {
    const calls: string[] = [];
    const repo = fakeOrders(calls);
    repo.findDueOnlineIds.mockResolvedValue(
      Array.from({ length: SWEEP_BATCH_SIZE }, (_, i) => `missing-${i}`),
    );
    const handler = new ExpireDueOrdersHandler(
      repo as unknown as IOrderRepository,
      fakeBus(calls) as unknown as CommandBus,
    );

    await handler.execute();

    expect(repo.findDueOnlineIds).toHaveBeenCalledTimes(SWEEP_MAX_BATCHES);
  });
});

describe('FinishPendingCodOrdersHandler', () => {
  const setup = (orders: Order[], confirm: (c: any) => unknown) => {
    const calls: string[] = [];
    const repo = fakeOrders(calls, orders);
    repo.findPendingCodIds
      .mockResolvedValueOnce(orders.map((o) => o.id))
      .mockResolvedValue([]);
    const bus = fakeBus(calls, { ConfirmOrderCommand: confirm });
    return {
      calls,
      repo,
      handler: new FinishPendingCodOrdersHandler(
        repo as unknown as IOrderRepository,
        bus as unknown as CommandBus,
      ),
    };
  };

  it('asks only for orders older than the grace period', async () => {
    const s = setup([], () => undefined);
    await s.handler.execute();
    expect(s.repo.findPendingCodIds).toHaveBeenCalledWith(30, SWEEP_BATCH_SIZE);
  });

  it('confirms each order it finds', async () => {
    const order = orderOf(OrderStatus.PENDING);
    const s = setup([order], () => ({ kind: 'CONFIRMED', order }));

    expect(await s.handler.execute()).toBe(1);
    expect(s.calls).toEqual(['ConfirmOrderCommand']);
  });

  it('expires an order whose held stock was already given back', async () => {
    const order = orderOf(OrderStatus.PENDING);
    const s = setup([order], () => ({ kind: 'HOLD_LOST' }));

    expect(await s.handler.execute()).toBe(1);
    expect(s.calls).toEqual(['ConfirmOrderCommand', 'transition:EXPIRED']);
  });

  it('leaves alone an order somebody else changed meanwhile (ORD-006), without counting it', async () => {
    const order = orderOf(OrderStatus.PENDING);
    const s = setup([order], () => {
      throw new DomainException(OrderErrorCodes.INVALID_STATE_TRANSITION);
    });

    expect(await s.handler.execute()).toBe(0);
  });

  it('one order failing does not stop the next', async () => {
    const a = orderOf(
      OrderStatus.PENDING,
      PaymentMethod.COD,
      'checkout-key-000A',
    );
    const b = orderOf(
      OrderStatus.PENDING,
      PaymentMethod.COD,
      'checkout-key-000B',
    );
    let first = true;
    const s = setup([a, b], () => {
      if (first) {
        first = false;
        throw new Error('Postgres hiccup');
      }
      return { kind: 'CONFIRMED', order: b };
    });

    expect(await s.handler.execute()).toBe(1);
  });
});

describe('ReturnStockForCancelledOrdersHandler', () => {
  it('puts the stock back for each order found, older than the grace period, and one failure does not stop the others', async () => {
    const calls: string[] = [];
    const repo = fakeOrders(calls);
    repo.findStockReturnPendingIds
      .mockResolvedValueOnce(['o1', 'o2', 'o3'])
      .mockResolvedValue([]);
    const bus = fakeBus(calls, {
      ReturnReservationCommand: (c: ReturnReservationCommand) => {
        if (c.orderId === 'o2') throw new Error('Postgres down');
      },
    });
    const returner = new OrderStockReturner(
      repo as unknown as IOrderRepository,
      bus as unknown as CommandBus,
    );
    const handler = new ReturnStockForCancelledOrdersHandler(
      repo as unknown as IOrderRepository,
      returner,
    );

    const count = await handler.execute();

    expect(count).toBe(2);
    expect(repo.findStockReturnPendingIds).toHaveBeenCalledWith(
      30,
      SWEEP_BATCH_SIZE,
    );
    expect(repo.clearStockReturnPending).toHaveBeenCalledTimes(2);
  });
});

describe('OrderMaintenance', () => {
  const setup = (
    seconds: number,
    handlers: Record<string, (c: any) => unknown> = {},
  ) => {
    const calls: string[] = [];
    const bus = fakeBus(calls, handlers);
    const lock = {
      run: vi.fn(
        async (_n: string, work: () => Promise<unknown>, _o?: object) => work(),
      ),
    };
    const config = {
      outboxIntervalMs: 0,
      outboxBatchSize: 1,
      maintenanceIntervalSeconds: seconds,
    } as OrdersConfig;
    const maintenance = new OrderMaintenance(
      bus as unknown as CommandBus,
      lock as unknown as LockService,
      config,
    );
    return { maintenance, calls, lock };
  };

  it('runs the three sweeps in order, under a lock it does not wait for', async () => {
    const s = setup(0);

    await s.maintenance.runOnce();

    expect(s.calls).toEqual([
      'ExpireDueOrdersCommand',
      'FinishPendingCodOrdersCommand',
      'ReturnStockForCancelledOrdersCommand',
    ]);
    expect(s.lock.run.mock.calls[0][2]).toMatchObject({ waitMs: 0 });
  });

  it('a failing sweep does not stop the next one, and runOnce never throws', async () => {
    const s = setup(0, {
      ExpireDueOrdersCommand: () => {
        throw new Error('boom');
      },
    });

    await expect(s.maintenance.runOnce()).resolves.toBeUndefined();
    expect(s.calls).toEqual([
      'ExpireDueOrdersCommand',
      'FinishPendingCodOrdersCommand',
      'ReturnStockForCancelledOrdersCommand',
    ]);
  });

  it('skips the round quietly when another copy holds the lock', async () => {
    const s = setup(0);
    s.lock.run.mockRejectedValueOnce(
      new DomainException(CoreErrorCodes.RESOURCE_BUSY),
    );

    await expect(s.maintenance.runOnce()).resolves.toBeUndefined();
    expect(s.calls).toEqual([]);
  });

  it('does not start a timer when the interval is 0, and starts one (and stops it) otherwise', async () => {
    vi.useFakeTimers();
    try {
      const off = setup(0);
      off.maintenance.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(5000);
      expect(off.calls).toEqual([]);

      const on = setup(1);
      on.maintenance.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(1100);
      expect(on.calls.length).toBe(3);
      on.maintenance.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(5000);
      expect(on.calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
