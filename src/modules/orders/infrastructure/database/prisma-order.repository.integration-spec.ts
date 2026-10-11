import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/core/index.js';
import {
  Order,
  OrderAlreadyExistsError,
  OrderStatus,
  PaymentMethod,
  orderCreatedEvent,
  orderStatusChangedEvent,
  type OutboxEventDraft,
  type ShippingAddress,
} from '../../domain/index.js';
import { PrismaOrderRepository } from './prisma-order.repository.js';

/** Against the real Postgres: the transactions, the conditional updates and the constraints. */
describe('PrismaOrderRepository (Integration)', () => {
  let prisma: PrismaService;
  let repository: PrismaOrderRepository;

  const U1 = 'ord_repo_user_1';
  const U2 = 'ord_repo_user_2';
  // The database clock can differ from this machine's by a second or so, so "long ago" is generous
  const LONG_AGO = 3_600_000;

  const address: ShippingAddress = {
    recipientName: 'Nguyễn Văn A',
    phone: '0901234567',
    provinceCode: '01',
    provinceName: 'Thành phố Hà Nội',
    wardCode: '00001',
    wardName: 'Phường Ba Đình',
    street: '12 Đường Liễu Giai',
    label: 'Nhà riêng',
  };

  const build = (
    overrides: {
      userId?: string;
      key?: string;
      paymentMethod?: PaymentMethod;
      expiresAt?: Date;
      now?: Date;
    } = {},
  ) =>
    Order.create({
      userId: overrides.userId ?? U1,
      idempotencyKey: overrides.key ?? `key-${randomUUID()}`,
      paymentMethod: overrides.paymentMethod ?? PaymentMethod.ONLINE,
      shippingAddress: address,
      items: [
        {
          skuId: 'sku-b',
          productName: 'Áo thun',
          thumbnail: null,
          attributes: { size: 'M', color: 'Đen' },
          unitPrice: 199000.5,
          quantity: 3,
        },
        {
          skuId: 'sku-a',
          productName: 'Quần jean',
          thumbnail: 'https://img/jean.jpg',
          attributes: {},
          unitPrice: 3990000,
          quantity: 1,
        },
      ],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 15 * 60_000),
      now: overrides.now,
    });

  const place = async (order: Order) => {
    await repository.create(order, orderCreatedEvent(order));
    return order;
  };

  const eventsOf = (orderId: string) =>
    prisma.outboxEvent.findMany({
      where: { aggregateId: orderId },
      orderBy: { seq: 'asc' },
    });

  const statusChange = (
    order: Order,
    from: OrderStatus,
    to: OrderStatus,
  ): OutboxEventDraft => orderStatusChangedEvent(order, from, to);

  /** Moves a column straight in the database, to set up the times the sweeps look at. */
  const setColumn = (orderId: string, column: string, agoMs: number) =>
    prisma.$executeRawUnsafe(
      `UPDATE "Order" SET "${column}" = (now() AT TIME ZONE 'UTC') - make_interval(secs => $1) WHERE "id" = $2`,
      agoMs / 1000,
      orderId,
    );

  const clean = async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.order.deleteMany({ where: { userId: { in: [U1, U2] } } });
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService, PrismaOrderRepository],
    }).compile();
    prisma = module.get(PrismaService);
    repository = module.get(PrismaOrderRepository);
    for (const id of [U1, U2]) {
      await prisma.user.upsert({ where: { id }, update: {}, create: { id } });
    }
  });

  beforeEach(clean);

  afterAll(async () => {
    await clean();
    await prisma.user.deleteMany({ where: { id: { in: [U1, U2] } } });
    await prisma.$disconnect();
  });

  describe('create', () => {
    it('writes the order, its items and its event together, and reads them back the same', async () => {
      const order = await place(build({ paymentMethod: PaymentMethod.COD }));

      const read = await repository.findById(order.id);

      expect(read).toMatchObject({
        id: order.id,
        userId: U1,
        paymentMethod: 'COD',
        status: 'PENDING',
        version: 1,
        stockReturnPending: false,
        total: 3990000 + 199000.5 * 3,
        shippingAddress: address,
      });
      // Always in the same order (by SKU), however Postgres returns the rows
      expect(read?.items.map((i) => i.skuId)).toEqual(['sku-a', 'sku-b']);
      expect(read?.items[1]).toMatchObject({
        productName: 'Áo thun',
        thumbnail: null,
        attributes: { size: 'M', color: 'Đen' },
        unitPrice: 199000.5,
        quantity: 3,
        lineTotal: 597001.5,
      });
      const events = await eventsOf(order.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'order.created',
        publishedAt: null,
      });
    });

    it('writes nothing at all when the event cannot be written (all or nothing)', async () => {
      const order = build();
      const event = orderCreatedEvent(order);
      await prisma.outboxEvent.create({
        data: {
          id: event.id,
          type: 'x',
          aggregateId: 'other',
          payload: {},
        },
      });

      await expect(repository.create(order, event)).rejects.toThrow();

      expect(await prisma.order.count({ where: { id: order.id } })).toBe(0);
      expect(
        await prisma.orderItem.count({ where: { orderId: order.id } }),
      ).toBe(0);
    });

    it('refuses the same order twice with OrderAlreadyExistsError and leaves no second event (AC-4)', async () => {
      const order = await place(build({ key: 'same-key-0001' }));

      await expect(
        repository.create(order, orderCreatedEvent(order)),
      ).rejects.toBeInstanceOf(OrderAlreadyExistsError);

      expect(await eventsOf(order.id)).toHaveLength(1);
    });

    it('lets two requests with the same key race: one wins, the other gets OrderAlreadyExistsError', async () => {
      const first = build({ key: 'race-key-0001' });
      const second = build({ key: 'race-key-0001' });
      expect(second.id).toBe(first.id);

      const results = await Promise.allSettled([
        repository.create(first, orderCreatedEvent(first)),
        repository.create(second, orderCreatedEvent(second)),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected');
      expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(
        OrderAlreadyExistsError,
      );
      expect(await eventsOf(first.id)).toHaveLength(1);
    });

    it('lets two users use the same key', async () => {
      await place(build({ userId: U1, key: 'shared-key-001' }));

      await expect(
        place(build({ userId: U2, key: 'shared-key-001' })),
      ).resolves.toBeDefined();
    });
  });

  describe('the database protects itself (AC-18)', () => {
    const insertOrder = (overrides: Record<string, unknown> = {}) =>
      prisma.order.create({
        data: {
          id: randomUUID(),
          userId: U1,
          idempotencyKey: `k-${randomUUID()}`,
          paymentMethod: 'ONLINE',
          total: 10,
          shippingAddress: {},
          expiresAt: new Date(),
          ...overrides,
        },
      });

    it('refuses an order for a user that does not exist', async () => {
      await expect(insertOrder({ userId: 'nobody' })).rejects.toThrow();
    });

    it('refuses a negative total', async () => {
      await expect(insertOrder({ total: -1 })).rejects.toThrow();
    });

    it('refuses an item with quantity 0, a negative price, or a negative line total', async () => {
      const order = await insertOrder();
      const item = {
        id: randomUUID(),
        orderId: order.id,
        skuId: 's1',
        productName: 'P',
        attributes: {},
        unitPrice: 1,
        quantity: 1,
        lineTotal: 1,
      };

      await expect(
        prisma.orderItem.create({ data: { ...item, quantity: 0 } }),
      ).rejects.toThrow();
      await expect(
        prisma.orderItem.create({ data: { ...item, unitPrice: -1 } }),
      ).rejects.toThrow();
      await expect(
        prisma.orderItem.create({ data: { ...item, lineTotal: -1 } }),
      ).rejects.toThrow();
      await expect(
        prisma.orderItem.create({ data: item }),
      ).resolves.toBeDefined();
    });

    it('refuses the same SKU twice in one order', async () => {
      const order = await insertOrder();
      const item = (id: string) => ({
        id,
        orderId: order.id,
        skuId: 'same-sku',
        productName: 'P',
        attributes: {},
        unitPrice: 1,
        quantity: 1,
        lineTotal: 1,
      });
      await prisma.orderItem.create({ data: item(randomUUID()) });

      await expect(
        prisma.orderItem.create({ data: item(randomUUID()) }),
      ).rejects.toThrow();
    });

    it('does not let a user with orders be deleted', async () => {
      await insertOrder();

      await expect(prisma.user.delete({ where: { id: U1 } })).rejects.toThrow();
    });

    it('removes the items with their order', async () => {
      const order = await place(build());

      await prisma.order.delete({ where: { id: order.id } });

      expect(
        await prisma.orderItem.count({ where: { orderId: order.id } }),
      ).toBe(0);
    });
  });

  describe('transition', () => {
    it('changes the status, adds 1 to the version and writes its event, in one go', async () => {
      const order = await place(build());

      const moved = await repository.transition(
        order.id,
        OrderStatus.PENDING,
        OrderStatus.CANCELLED,
        statusChange(order, OrderStatus.PENDING, OrderStatus.CANCELLED),
      );

      expect(moved).toMatchObject({
        status: 'CANCELLED',
        version: 2,
        stockReturnPending: false,
      });
      expect(moved?.items).toHaveLength(2);
      const events = await eventsOf(order.id);
      expect(events.map((e) => e.type)).toEqual([
        'order.created',
        'order.status_changed',
      ]);
      expect(events[1].payload).toMatchObject({
        from: 'PENDING',
        to: 'CANCELLED',
      });
    });

    it('does nothing, and writes no event, when the order is no longer in the status we expected', async () => {
      const order = await place(build());
      await repository.transition(
        order.id,
        OrderStatus.PENDING,
        OrderStatus.EXPIRED,
        statusChange(order, OrderStatus.PENDING, OrderStatus.EXPIRED),
      );

      const late = await repository.transition(
        order.id,
        OrderStatus.PENDING,
        OrderStatus.CANCELLED,
        statusChange(order, OrderStatus.PENDING, OrderStatus.CANCELLED),
      );

      expect(late).toBeNull();
      expect((await repository.findById(order.id))?.status).toBe('EXPIRED');
      expect(await eventsOf(order.id)).toHaveLength(2);
    });

    it('does nothing for an order that does not exist', async () => {
      const ghost = build();

      await expect(
        repository.transition(
          ghost.id,
          OrderStatus.PENDING,
          OrderStatus.CANCELLED,
          statusChange(ghost, OrderStatus.PENDING, OrderStatus.CANCELLED),
        ),
      ).resolves.toBeNull();
      expect(await eventsOf(ghost.id)).toHaveLength(0);
    });

    it('lets exactly one win when a cancel and an expiry reach the same order together (AC-9)', async () => {
      const order = await place(build());

      const results = await Promise.all([
        repository.transition(
          order.id,
          OrderStatus.PENDING,
          OrderStatus.CANCELLED,
          statusChange(order, OrderStatus.PENDING, OrderStatus.CANCELLED),
        ),
        repository.transition(
          order.id,
          OrderStatus.PENDING,
          OrderStatus.EXPIRED,
          statusChange(order, OrderStatus.PENDING, OrderStatus.EXPIRED),
        ),
      ]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const final = await repository.findById(order.id);
      expect(final?.version).toBe(2);
      expect(await eventsOf(order.id)).toHaveLength(2);
    });

    it('lets exactly one win among many callers doing the same thing', async () => {
      const order = await place(build({ paymentMethod: PaymentMethod.COD }));

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.transition(
            order.id,
            OrderStatus.PENDING,
            OrderStatus.CONFIRMED,
            statusChange(order, OrderStatus.PENDING, OrderStatus.CONFIRMED),
          ),
        ),
      );

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect((await repository.findById(order.id))?.version).toBe(2);
      expect(await eventsOf(order.id)).toHaveLength(2);
    });

    it('sets the stock-return flag in the same step when asked (cancel after confirm)', async () => {
      const order = await place(build({ paymentMethod: PaymentMethod.COD }));
      await repository.transition(
        order.id,
        OrderStatus.PENDING,
        OrderStatus.CONFIRMED,
        statusChange(order, OrderStatus.PENDING, OrderStatus.CONFIRMED),
      );

      const cancelled = await repository.transition(
        order.id,
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
        statusChange(order, OrderStatus.CONFIRMED, OrderStatus.CANCELLED),
        { stockReturnPending: true },
      );

      expect(cancelled).toMatchObject({
        status: 'CANCELLED',
        stockReturnPending: true,
      });
    });

    it('does not touch the flag when not asked', async () => {
      const order = await place(build());

      const moved = await repository.transition(
        order.id,
        OrderStatus.PENDING,
        OrderStatus.CANCELLED,
        statusChange(order, OrderStatus.PENDING, OrderStatus.CANCELLED),
      );

      expect(moved?.stockReturnPending).toBe(false);
    });

    it('writes no change at all when its event cannot be written (all or nothing)', async () => {
      const order = await place(build());
      const event = statusChange(
        order,
        OrderStatus.PENDING,
        OrderStatus.CANCELLED,
      );
      await prisma.outboxEvent.create({
        data: { id: event.id, type: 'x', aggregateId: 'other', payload: {} },
      });

      await expect(
        repository.transition(
          order.id,
          OrderStatus.PENDING,
          OrderStatus.CANCELLED,
          event,
        ),
      ).rejects.toThrow();

      const after = await repository.findById(order.id);
      expect(after).toMatchObject({ status: 'PENDING', version: 1 });
    });
  });

  describe('reading', () => {
    it('gives an order only to its owner (findByIdForUser)', async () => {
      const order = await place(build({ userId: U1 }));

      expect(await repository.findByIdForUser(U1, order.id)).not.toBeNull();
      expect(await repository.findByIdForUser(U2, order.id)).toBeNull();
      expect(await repository.findByIdForUser(U1, randomUUID())).toBeNull();
    });

    it("lists a user's orders newest first, page by page, never showing another user's", async () => {
      const base = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const order = await place(build({ now: new Date(base + i * 1000) }));
        ids.push(order.id);
      }
      await place(build({ userId: U2, now: new Date(base + 10_000) }));

      const first = await repository.listByUser(U1, 2);
      const second = await repository.listByUser(
        U1,
        2,
        first!.meta.nextCursor!,
      );
      const third = await repository.listByUser(
        U1,
        2,
        second!.meta.nextCursor!,
      );

      const newestFirst = [...ids].reverse();
      expect(first!.data.map((o) => o.id)).toEqual(newestFirst.slice(0, 2));
      expect(first!.meta.hasMore).toBe(true);
      expect(second!.data.map((o) => o.id)).toEqual(newestFirst.slice(2, 4));
      expect(third!.data.map((o) => o.id)).toEqual(newestFirst.slice(4));
      expect(third!.meta).toEqual({ hasMore: false, nextCursor: null });
      expect(first!.data[0].items).toHaveLength(2);
    });

    it('gives an empty list to a user with no orders', async () => {
      const page = await repository.listByUser(U2, 10);

      expect(page).toEqual({
        data: [],
        meta: { hasMore: false, nextCursor: null },
      });
    });

    it("refuses a cursor that is not one of this user's orders (null), so it cannot be used to probe", async () => {
      const mine = await place(build({ userId: U1 }));
      const theirs = await place(build({ userId: U2 }));

      expect(await repository.listByUser(U1, 10, theirs.id)).toBeNull();
      expect(await repository.listByUser(U1, 10, randomUUID())).toBeNull();
      expect(await repository.listByUser(U1, 10, mine.id)).not.toBeNull();
    });
  });

  describe('what the sweep looks for (by the database clock)', () => {
    it('findDueOnlineIds: online PENDING orders past their expiry, and no others', async () => {
      const due = await place(build());
      const notYet = await place(build());
      const cod = await place(build({ paymentMethod: PaymentMethod.COD }));
      const alreadyCancelled = await place(build());
      await setColumn(due.id, 'expiresAt', LONG_AGO);
      await setColumn(cod.id, 'expiresAt', LONG_AGO);
      await setColumn(alreadyCancelled.id, 'expiresAt', LONG_AGO);
      await repository.transition(
        alreadyCancelled.id,
        OrderStatus.PENDING,
        OrderStatus.CANCELLED,
        statusChange(
          alreadyCancelled,
          OrderStatus.PENDING,
          OrderStatus.CANCELLED,
        ),
      );

      const ids = await repository.findDueOnlineIds(100);

      expect(ids).toEqual([due.id]);
      expect(ids).not.toContain(notYet.id);
    });

    it('findDueOnlineIds: oldest first, and no more than the limit', async () => {
      const orders = [];
      for (let i = 0; i < 3; i++) orders.push(await place(build()));
      await setColumn(orders[0].id, 'expiresAt', 3 * LONG_AGO);
      await setColumn(orders[1].id, 'expiresAt', 2 * LONG_AGO);
      await setColumn(orders[2].id, 'expiresAt', LONG_AGO);

      expect(await repository.findDueOnlineIds(2)).toEqual([
        orders[0].id,
        orders[1].id,
      ]);
    });

    it('findPendingCodIds: COD PENDING orders older than the given seconds, and no others', async () => {
      const old = await place(build({ paymentMethod: PaymentMethod.COD }));
      const fresh = await place(build({ paymentMethod: PaymentMethod.COD }));
      const online = await place(build());
      await setColumn(old.id, 'createdAt', LONG_AGO);
      await setColumn(online.id, 'createdAt', LONG_AGO);

      const ids = await repository.findPendingCodIds(30, 100);

      expect(ids).toEqual([old.id]);
      expect(ids).not.toContain(fresh.id);
    });

    it('findStockReturnPendingIds: cancelled orders with the flag, untouched for a while', async () => {
      const stuck = await place(build({ paymentMethod: PaymentMethod.COD }));
      const justNow = await place(build({ paymentMethod: PaymentMethod.COD }));
      const noFlag = await place(build({ paymentMethod: PaymentMethod.COD }));
      for (const order of [stuck, justNow]) {
        await repository.transition(
          order.id,
          OrderStatus.PENDING,
          OrderStatus.CONFIRMED,
          statusChange(order, OrderStatus.PENDING, OrderStatus.CONFIRMED),
        );
        await repository.transition(
          order.id,
          OrderStatus.CONFIRMED,
          OrderStatus.CANCELLED,
          statusChange(order, OrderStatus.CONFIRMED, OrderStatus.CANCELLED),
          { stockReturnPending: true },
        );
      }
      await repository.transition(
        noFlag.id,
        OrderStatus.PENDING,
        OrderStatus.CANCELLED,
        statusChange(noFlag, OrderStatus.PENDING, OrderStatus.CANCELLED),
      );
      await setColumn(stuck.id, 'updatedAt', LONG_AGO);
      await setColumn(noFlag.id, 'updatedAt', LONG_AGO);

      expect(await repository.findStockReturnPendingIds(30, 100)).toEqual([
        stuck.id,
      ]);
    });

    it('clearStockReturnPending: takes the flag off, and the order no longer shows up', async () => {
      const order = await place(build({ paymentMethod: PaymentMethod.COD }));
      await repository.transition(
        order.id,
        OrderStatus.PENDING,
        OrderStatus.CONFIRMED,
        statusChange(order, OrderStatus.PENDING, OrderStatus.CONFIRMED),
      );
      await repository.transition(
        order.id,
        OrderStatus.CONFIRMED,
        OrderStatus.CANCELLED,
        statusChange(order, OrderStatus.CONFIRMED, OrderStatus.CANCELLED),
        { stockReturnPending: true },
      );
      await setColumn(order.id, 'updatedAt', LONG_AGO);
      expect(await repository.findStockReturnPendingIds(30, 100)).toEqual([
        order.id,
      ]);

      await repository.clearStockReturnPending(order.id);

      expect((await repository.findById(order.id))?.stockReturnPending).toBe(
        false,
      );
      expect(await repository.findStockReturnPendingIds(30, 100)).toEqual([]);
      // Doing it again is harmless
      await expect(
        repository.clearStockReturnPending(order.id),
      ).resolves.toBeUndefined();
    });
  });
});
