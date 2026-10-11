import { vi } from 'vitest';
import type { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  DomainException,
  InventoryErrorCodes,
  OrderErrorCodes,
  type LockService,
} from '@/core/index.js';
import type { SkuLookupService } from '../../../catalog/application/index.js';
import type { CartOrderingService } from '../../../cart/application/index.js';
import {
  ConfirmReservationCommand,
  ReleaseReservationCommand,
  ReserveStockCommand,
  ReturnReservationCommand,
} from '../../../inventory/application/index.js';
import { InventoryDomainException } from '../../../inventory/domain/index.js';
import {
  Order,
  OrderAlreadyExistsError,
  OrderStatus,
  PaymentMethod,
  deriveOrderId,
  type IOrderRepository,
} from '../../domain/index.js';
import { ConfirmOrderCommand } from './confirm-order.command.js';
import { ConfirmOrderHandler } from './confirm-order.handler.js';
import { PlaceOrderCommand } from './place-order.command.js';
import { PlaceOrderHandler } from './place-order.handler.js';

const USER = 'user-1';
const KEY = 'checkout-key-0001';
const ORDER_ID = deriveOrderId(USER, KEY);
const HOLD_EXPIRES = new Date(Date.now() + 15 * 60_000);

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
const sku = (skuId: string, price: number, published = true) => ({
  skuId,
  productId: 'P',
  productName: `Product ${skuId}`,
  thumbnail: null,
  attributes: { color: skuId },
  price,
  published,
});

const orderOf = (
  paymentMethod: PaymentMethod,
  status: OrderStatus = OrderStatus.PENDING,
) => {
  const created = Order.create({
    userId: USER,
    idempotencyKey: KEY,
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
    expiresAt: HOLD_EXPIRES,
  });
  return Order.restore({ ...created, status } as never);
};

/** The buses are fakes: `calls` is the order in which the other modules were asked to do things. */
const setup = (
  options: {
    lines?: { skuId: string; quantity: number }[];
    skus?: ReturnType<typeof sku>[];
    existing?: Order | null;
  } = {},
) => {
  const calls: string[] = [];
  const lines = options.lines ?? [{ skuId: 'A', quantity: 2 }];
  const skus = options.skus ?? [sku('A', 100)];

  const cart = {
    getLines: vi.fn(async () => {
      calls.push('cart.getLines');
      return lines.map((l) => ({ ...l, addedPrice: 1, addedAt: 1 }));
    }),
    removeLines: vi.fn(async () => {
      calls.push('cart.removeLines');
    }),
  };
  const lookup = {
    findMany: vi.fn(async (ids: string[]) => {
      calls.push('catalog.findMany');
      return new Map(
        skus.filter((s) => ids.includes(s.skuId)).map((s) => [s.skuId, s]),
      );
    }),
  };
  const orders = {
    findById: vi.fn(async () => options.existing ?? null),
    create: vi.fn(async () => {
      calls.push('orders.create');
    }),
    transition: vi.fn(),
  };
  const lock = {
    run: vi.fn(async (_name: string, work: () => Promise<unknown>) => {
      calls.push('lock');
      return work();
    }),
  };
  const queryBus = {
    execute: vi.fn(async () => {
      calls.push('address.get');
      return ADDRESS;
    }),
  };
  const commandBus = {
    execute: vi.fn(async (command: object): Promise<unknown> => {
      if (command instanceof ReserveStockCommand) {
        calls.push('inventory.reserve');
        return { orderId: ORDER_ID, expiresAt: HOLD_EXPIRES, items: [] };
      }
      if (command instanceof ReleaseReservationCommand) {
        calls.push('inventory.release');
        return undefined;
      }
      if (command instanceof ConfirmOrderCommand) {
        calls.push('order.confirm');
        return {
          kind: 'CONFIRMED',
          order: orderOf(PaymentMethod.COD, OrderStatus.CONFIRMED),
        };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    }),
  };
  const handler = new PlaceOrderHandler(
    orders as unknown as IOrderRepository,
    cart as unknown as CartOrderingService,
    lookup as unknown as SkuLookupService,
    lock as unknown as LockService,
    commandBus as unknown as CommandBus,
    queryBus as unknown as QueryBus,
  );
  return { handler, calls, cart, lookup, orders, lock, queryBus, commandBus };
};

const place = (method = PaymentMethod.ONLINE, key = KEY) =>
  new PlaceOrderCommand(USER, key, 'address-1', method);

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as DomainException;
  }
  throw new Error('expected a rejection');
};

describe('PlaceOrderHandler', () => {
  it('does the steps in the safe order for an online order: ask everything, hold, save, clear the cart', async () => {
    const { handler, calls } = setup();

    const result = await handler.execute(place(PaymentMethod.ONLINE));

    expect(calls).toEqual([
      'lock',
      'cart.getLines',
      'catalog.findMany',
      'address.get',
      'inventory.reserve',
      'orders.create',
      'cart.removeLines',
    ]);
    expect(result.replayed).toBe(false);
    expect(result.order).toMatchObject({
      id: ORDER_ID,
      status: 'PENDING',
      paymentMethod: 'ONLINE',
      expiresAt: HOLD_EXPIRES,
    });
  });

  it('confirms right after saving a cash-on-delivery order, before clearing the cart', async () => {
    const { handler, calls } = setup();

    const result = await handler.execute(place(PaymentMethod.COD));

    expect(calls.slice(-3)).toEqual([
      'orders.create',
      'order.confirm',
      'cart.removeLines',
    ]);
    expect(result.order.status).toBe('CONFIRMED');
  });

  it('never confirms an online order', async () => {
    const { handler, calls } = setup();

    await handler.execute(place(PaymentMethod.ONLINE));

    expect(calls).not.toContain('order.confirm');
  });

  it('takes the price from the catalog now, the address from the address book, and holds exactly the quantities', async () => {
    const { handler, orders, commandBus } = setup({
      lines: [
        { skuId: 'B', quantity: 1 },
        { skuId: 'A', quantity: 3 },
      ],
      skus: [sku('A', 199000.5), sku('B', 50)],
    });

    await handler.execute(place());

    const saved = orders.create.mock.calls[0] as unknown as [Order];
    expect(
      saved[0].items.map((i) => [i.skuId, i.unitPrice, i.quantity]),
    ).toEqual([
      ['A', 199000.5, 3],
      ['B', 50, 1],
    ]);
    expect(saved[0].total).toBe(597051.5);
    expect(saved[0].shippingAddress).toEqual(ADDRESS);
    const hold = commandBus.execute.mock.calls
      .map(([c]) => c)
      .find((c) => c instanceof ReserveStockCommand) as ReserveStockCommand;
    expect(hold.orderId).toBe(ORDER_ID);
    expect(hold.items).toEqual([
      { skuId: 'A', qty: 3 },
      { skuId: 'B', qty: 1 },
    ]);
  });

  it('takes the lock of the user', async () => {
    const { handler, lock } = setup();

    await handler.execute(place());

    expect(lock.run.mock.calls[0][0]).toBe(`order:place:${USER}`);
  });

  describe('a request sent again', () => {
    it('gives the existing order back and touches nothing else (AC-4)', async () => {
      const existing = orderOf(PaymentMethod.ONLINE);
      const { handler, calls, orders } = setup({ existing });

      const result = await handler.execute(place());

      expect(result).toEqual({ order: existing, replayed: true });
      expect(calls).toEqual(['lock']);
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('refuses a key that is not acceptable before taking any lock (ORD-005)', async () => {
      const { handler, lock } = setup();

      for (const key of [
        'short',
        'has space in it',
        'x'.repeat(101),
        undefined as never,
      ]) {
        const error = await rejection(
          handler.execute(
            new PlaceOrderCommand(USER, key, 'address-1', PaymentMethod.ONLINE),
          ),
        );
        expect(error.code).toBe(OrderErrorCodes.INVALID_IDEMPOTENCY_KEY.code);
      }
      expect(lock.run).not.toHaveBeenCalled();
    });

    it('refuses an unknown payment method before taking any lock', async () => {
      const { handler, lock } = setup();

      const error = await rejection(
        handler.execute(place('CRYPTO' as PaymentMethod)),
      );

      expect(error.code).toBe(OrderErrorCodes.DOMAIN_EXCEPTION.code);
      expect(lock.run).not.toHaveBeenCalled();
    });
  });

  describe('when it cannot be placed, nothing is held and nothing is saved (AC-6)', () => {
    const nothingLeft = ({ calls, orders, cart }: ReturnType<typeof setup>) => {
      expect(calls).not.toContain('inventory.reserve');
      expect(calls).not.toContain('inventory.release');
      expect(orders.create).not.toHaveBeenCalled();
      expect(cart.removeLines).not.toHaveBeenCalled();
    };

    it('an empty cart: ORD-003', async () => {
      const s = setup({ lines: [] });

      const error = await rejection(s.handler.execute(place()));

      expect(error.code).toBe(OrderErrorCodes.EMPTY_CART.code);
      nothingLeft(s);
    });

    it('a SKU that is gone or not on sale: ORD-004 with every such SKU', async () => {
      const s = setup({
        lines: [
          { skuId: 'A', quantity: 1 },
          { skuId: 'HIDDEN', quantity: 1 },
          { skuId: 'GONE', quantity: 1 },
        ],
        skus: [sku('A', 1), sku('HIDDEN', 1, false)],
      });

      const error = await rejection(s.handler.execute(place()));

      expect(error.code).toBe(OrderErrorCodes.ITEM_UNAVAILABLE.code);
      expect((error.details as { skuIds: string[] }).skuIds.sort()).toEqual([
        'GONE',
        'HIDDEN',
      ]);
      nothingLeft(s);
    });

    it("an address that is not the user's: the address error passes through unchanged", async () => {
      const s = setup();
      const notFound = new DomainException({
        code: 'ADDR-001',
        message: 'x',
        status: 404,
      });
      s.queryBus.execute.mockRejectedValueOnce(notFound);

      await expect(s.handler.execute(place())).rejects.toBe(notFound);
      nothingLeft(s);
    });

    it('not enough stock: ORD-001 with the shortages, nothing saved', async () => {
      const s = setup();
      const shortages = [{ skuId: 'A', requested: 2, available: 1 }];
      s.commandBus.execute.mockRejectedValueOnce(
        InventoryDomainException.outOfStock(shortages),
      );

      const error = await rejection(s.handler.execute(place()));

      expect(error.code).toBe(OrderErrorCodes.OUT_OF_STOCK.code);
      expect(error.status).toBe(409);
      expect(error.details).toEqual({ shortages });
      expect(s.orders.create).not.toHaveBeenCalled();
      expect(s.cart.removeLines).not.toHaveBeenCalled();
    });

    it.each([
      ['INV-004', InventoryErrorCodes.RESERVATION_IN_PROGRESS],
      ['INV-006', InventoryErrorCodes.RESERVATION_RELEASED],
      ['INV-007', InventoryErrorCodes.STOCK_UNAVAILABLE],
    ])(
      'another inventory refusal (%s) passes through unchanged',
      async (_, code) => {
        const s = setup();
        const refusal = new InventoryDomainException(code);
        s.commandBus.execute.mockRejectedValueOnce(refusal);

        await expect(s.handler.execute(place())).rejects.toBe(refusal);
        expect(s.orders.create).not.toHaveBeenCalled();
      },
    );

    it('Redis down while reading the cart: the error passes through and nothing was held', async () => {
      const s = setup();
      const down = new Error('Redis down');
      s.cart.getLines.mockRejectedValueOnce(down);

      await expect(s.handler.execute(place())).rejects.toBe(down);
      nothingLeft(s);
    });
  });

  describe('when saving the order fails after the stock was held (AC-8)', () => {
    it('keeps the held stock, passes the error on, and leaves the cart untouched, so the same request can be sent again', async () => {
      const s = setup();
      const failure = new Error('connection lost');
      s.orders.create.mockRejectedValueOnce(failure);

      await expect(s.handler.execute(place())).rejects.toBe(failure);

      expect(s.calls).toContain('inventory.reserve');
      expect(s.calls).not.toContain('inventory.release');
      expect(s.cart.removeLines).not.toHaveBeenCalled();
    });

    it("does NOT give the stock back when the order turns out to exist already: that hold is the order's own", async () => {
      const s = setup();
      const saved = orderOf(PaymentMethod.ONLINE);
      s.orders.create.mockRejectedValueOnce(
        new OrderAlreadyExistsError(ORDER_ID),
      );
      s.orders.findById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(saved);

      const result = await s.handler.execute(place());

      expect(result).toEqual({ order: saved, replayed: true });
      expect(s.calls).not.toContain('inventory.release');
    });

    it('an order that is not acceptable (a total too large for the database, ORD-000) is refused and the hold is given back, since sending it again cannot work', async () => {
      const s = setup({
        skus: [sku('A', 99_999_999.99)],
        lines: [{ skuId: 'A', quantity: 1000 }],
      });

      const error = await rejection(s.handler.execute(place()));

      expect(error.code).toBe(OrderErrorCodes.DOMAIN_EXCEPTION.code);
      expect(s.calls).toContain('inventory.release');
      expect(s.orders.create).not.toHaveBeenCalled();
    });
  });

  describe('what must never fail a saved order', () => {
    it('a cart that cannot be cleared (Redis) does not fail the request (AC-8)', async () => {
      const s = setup();
      s.cart.removeLines.mockRejectedValueOnce(new Error('Redis down'));

      const result = await s.handler.execute(place());

      expect(result.order.id).toBe(ORDER_ID);
    });

    it('a cash-on-delivery confirm that fails leaves the order PENDING and the request a success (AC-3)', async () => {
      const s = setup();
      const original = s.commandBus.execute.getMockImplementation()!;
      s.commandBus.execute.mockImplementation(async (command: object) => {
        if (command instanceof ConfirmOrderCommand)
          throw new Error('Postgres hiccup');
        return original(command);
      });

      const result = await s.handler.execute(place(PaymentMethod.COD));

      expect(result.order.status).toBe('PENDING');
      expect(s.calls).toContain('cart.removeLines');
      expect(s.calls).not.toContain('inventory.release');
    });

    it('a cash-on-delivery order whose hold was already lost is answered PENDING (the sweep expires it)', async () => {
      const s = setup();
      const original = s.commandBus.execute.getMockImplementation()!;
      s.commandBus.execute.mockImplementation(async (command: object) =>
        command instanceof ConfirmOrderCommand
          ? { kind: 'HOLD_LOST' }
          : original(command),
      );

      const result = await s.handler.execute(place(PaymentMethod.COD));

      expect(result.order.status).toBe('PENDING');
    });
  });
});

describe('ConfirmOrderHandler', () => {
  const confirmSetup = (order: Order | null, after?: Order | null) => {
    const calls: string[] = [];
    const orders = {
      findById: vi.fn(async () => order),
      transition: vi.fn(async () => {
        calls.push('orders.transition');
        return after === undefined
          ? orderOf(PaymentMethod.COD, OrderStatus.CONFIRMED)
          : after;
      }),
    };
    const commandBus = {
      execute: vi.fn(async (command: object) => {
        if (command instanceof ConfirmReservationCommand)
          calls.push('inventory.confirm');
        if (command instanceof ReturnReservationCommand)
          calls.push('inventory.return');
        return undefined;
      }),
    };
    const handler = new ConfirmOrderHandler(
      orders as unknown as IOrderRepository,
      commandBus as unknown as CommandBus,
    );
    return { handler, calls, orders, commandBus };
  };

  it('takes the stock out of the warehouse FIRST and moves the order SECOND', async () => {
    const s = confirmSetup(orderOf(PaymentMethod.COD));

    const result = await s.handler.execute(new ConfirmOrderCommand(ORDER_ID));

    expect(s.calls).toEqual(['inventory.confirm', 'orders.transition']);
    expect(result).toMatchObject({ kind: 'CONFIRMED' });
    expect(s.orders.transition).toHaveBeenCalledWith(
      ORDER_ID,
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      expect.objectContaining({
        type: 'order.status_changed',
        payload: expect.objectContaining({ from: 'PENDING', to: 'CONFIRMED' }),
      }),
    );
  });

  it('answers an order that is already CONFIRMED as confirmed, touching nothing', async () => {
    const done = orderOf(PaymentMethod.COD, OrderStatus.CONFIRMED);
    const s = confirmSetup(done);

    const result = await s.handler.execute(new ConfirmOrderCommand(ORDER_ID));

    expect(result).toEqual({ kind: 'CONFIRMED', order: done });
    expect(s.calls).toEqual([]);
  });

  it('says ORD-002 for an order that does not exist', async () => {
    const s = confirmSetup(null);

    const error = await rejection(
      s.handler.execute(new ConfirmOrderCommand(ORDER_ID)),
    );

    expect(error.code).toBe(OrderErrorCodes.NOT_FOUND.code);
  });

  it.each([
    ['an online order that is only PENDING', orderOf(PaymentMethod.ONLINE)],
    ['a cancelled order', orderOf(PaymentMethod.COD, OrderStatus.CANCELLED)],
    ['an expired order', orderOf(PaymentMethod.COD, OrderStatus.EXPIRED)],
    ['a shipped order', orderOf(PaymentMethod.COD, OrderStatus.SHIPPING)],
  ])('refuses %s with ORD-006 before touching the stock', async (_, order) => {
    const s = confirmSetup(order);

    const error = await rejection(
      s.handler.execute(new ConfirmOrderCommand(ORDER_ID)),
    );

    expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
    expect(s.calls).toEqual([]);
  });

  it('reports HOLD_LOST, and leaves the order alone, when the held stock was already given back', async () => {
    const s = confirmSetup(orderOf(PaymentMethod.COD));
    s.commandBus.execute.mockRejectedValueOnce(
      new InventoryDomainException(InventoryErrorCodes.RESERVATION_RELEASED),
    );

    const result = await s.handler.execute(new ConfirmOrderCommand(ORDER_ID));

    expect(result).toEqual({ kind: 'HOLD_LOST' });
    expect(s.orders.transition).not.toHaveBeenCalled();
  });

  it('passes any other inventory error on, and leaves the order alone', async () => {
    const s = confirmSetup(orderOf(PaymentMethod.COD));
    const refusal = new InventoryDomainException(
      InventoryErrorCodes.RESERVATION_NOT_FOUND,
    );
    s.commandBus.execute.mockRejectedValueOnce(refusal);

    await expect(
      s.handler.execute(new ConfirmOrderCommand(ORDER_ID)),
    ).rejects.toBe(refusal);
    expect(s.orders.transition).not.toHaveBeenCalled();
  });

  it('when another confirm won the move, answers confirmed and puts nothing back', async () => {
    const done = orderOf(PaymentMethod.COD, OrderStatus.CONFIRMED);
    const s = confirmSetup(orderOf(PaymentMethod.COD), null);
    s.orders.findById
      .mockResolvedValueOnce(orderOf(PaymentMethod.COD))
      .mockResolvedValueOnce(done);

    const result = await s.handler.execute(new ConfirmOrderCommand(ORDER_ID));

    expect(result).toEqual({ kind: 'CONFIRMED', order: done });
    expect(s.calls).not.toContain('inventory.return');
  });

  it('when the order was cancelled just after the stock was taken out, puts the stock back and says ORD-006', async () => {
    const s = confirmSetup(orderOf(PaymentMethod.COD), null);
    s.orders.findById
      .mockResolvedValueOnce(orderOf(PaymentMethod.COD))
      .mockResolvedValueOnce(orderOf(PaymentMethod.COD, OrderStatus.CANCELLED));

    const error = await rejection(
      s.handler.execute(new ConfirmOrderCommand(ORDER_ID)),
    );

    expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
    expect(s.calls).toEqual([
      'inventory.confirm',
      'orders.transition',
      'inventory.return',
    ]);
  });

  it('still says ORD-006 when putting the stock back fails too', async () => {
    const s = confirmSetup(orderOf(PaymentMethod.COD), null);
    s.orders.findById
      .mockResolvedValueOnce(orderOf(PaymentMethod.COD))
      .mockResolvedValueOnce(orderOf(PaymentMethod.COD, OrderStatus.EXPIRED));
    const original = s.commandBus.execute.getMockImplementation()!;
    s.commandBus.execute.mockImplementation(async (command: object) => {
      if (command instanceof ReturnReservationCommand)
        throw new Error('Postgres down');
      return original(command);
    });

    const error = await rejection(
      s.handler.execute(new ConfirmOrderCommand(ORDER_ID)),
    );

    expect(error.code).toBe(OrderErrorCodes.INVALID_STATE_TRANSITION.code);
  });
});
