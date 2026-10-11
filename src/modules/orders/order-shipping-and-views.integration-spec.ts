import { Test, TestingModule } from '@nestjs/testing';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import {
  DatabaseModule,
  PrismaService,
  type PaginatedResult,
} from '@/core/index.js';
import { PrismaOrderRepository } from './infrastructure/index.js';
import {
  DeliverOrderCommand,
  DeliverOrderHandler,
  GetOrderHandler,
  GetOrderQuery,
  ListOrdersHandler,
  ListOrdersQuery,
  ShipOrderCommand,
  ShipOrderHandler,
} from './application/index.js';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  orderCreatedEvent,
  orderStatusChangedEvent,
} from './domain/index.js';

const U1 = 'ord_view_user_1';
const U2 = 'ord_view_user_2';

/** Shipping by the admin and the customer's own views, against the real order tables. */
describe('Shipping and viewing orders (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let commands: CommandBus;
  let queries: QueryBus;
  let repo: PrismaOrderRepository;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule, CqrsModule],
      providers: [
        PrismaOrderRepository,
        { provide: 'IOrderRepository', useExisting: PrismaOrderRepository },
        ShipOrderHandler,
        DeliverOrderHandler,
        GetOrderHandler,
        ListOrdersHandler,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    commands = module.get(CommandBus);
    queries = module.get(QueryBus);
    repo = module.get(PrismaOrderRepository);
    for (const id of [U1, U2]) {
      await prisma.user.upsert({ where: { id }, update: {}, create: { id } });
    }
  });

  const clean = async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.order.deleteMany({ where: { userId: { in: [U1, U2] } } });
  };
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.user.deleteMany({ where: { id: { in: [U1, U2] } } });
    await module.close();
  });

  const place = async (
    userId = U1,
    options: { createdAt?: Date; method?: PaymentMethod } = {},
  ) => {
    const order = Order.create({
      userId,
      idempotencyKey: `view-key-${randomUUID()}`,
      paymentMethod: options.method ?? PaymentMethod.COD,
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
          attributes: { color: 'White' },
          unitPrice: 100,
          quantity: 2,
        },
      ],
      expiresAt: new Date(Date.now() + 15 * 60_000),
      now: options.createdAt,
    });
    await repo.create(order, orderCreatedEvent(order));
    return order;
  };
  const confirmed = async () => {
    const order = await place();
    await repo.transition(
      order.id,
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      orderStatusChangedEvent(
        order,
        OrderStatus.PENDING,
        OrderStatus.CONFIRMED,
      ),
    );
    return order;
  };
  const ship = (orderId: string) =>
    commands.execute<ShipOrderCommand, Order>(new ShipOrderCommand(orderId));
  const deliver = (orderId: string) =>
    commands.execute<DeliverOrderCommand, Order>(
      new DeliverOrderCommand(orderId),
    );
  const failureOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return error.code as string;
    }
    throw new Error('should have failed');
  };
  const statusChanges = async (orderId: string) =>
    (
      await prisma.outboxEvent.findMany({
        where: { aggregateId: orderId, type: 'order.status_changed' },
        orderBy: { seq: 'asc' },
      })
    ).map((e) => `${(e.payload as any).from}>${(e.payload as any).to}`);

  describe('shipping (AC-13)', () => {
    it('takes a CONFIRMED order to SHIPPING and then DELIVERED, one event each', async () => {
      const order = await confirmed();

      const shipping = await ship(order.id);
      const delivered = await deliver(order.id);

      expect(shipping).toMatchObject({ status: 'SHIPPING', version: 3 });
      expect(delivered).toMatchObject({ status: 'DELIVERED', version: 4 });
      expect(await statusChanges(order.id)).toEqual([
        'PENDING>CONFIRMED',
        'CONFIRMED>SHIPPING',
        'SHIPPING>DELIVERED',
      ]);
    });

    it('works for an online order that was paid too', async () => {
      const order = await place(U1, { method: PaymentMethod.ONLINE });
      for (const [from, to] of [
        [OrderStatus.PENDING, OrderStatus.PAYMENT_PROCESSING],
        [OrderStatus.PAYMENT_PROCESSING, OrderStatus.CONFIRMED],
      ] as const) {
        await repo.transition(
          order.id,
          from,
          to,
          orderStatusChangedEvent(order, from, to),
        );
      }

      expect((await ship(order.id)).status).toBe('SHIPPING');
    });

    it('refuses the wrong status with ORD-006 and changes nothing', async () => {
      const pending = await place();
      const shipped = await confirmed();
      await ship(shipped.id);
      const delivered = await confirmed();
      await ship(delivered.id);
      await deliver(delivered.id);

      expect(await failureOf(ship(pending.id))).toBe('ORD-006'); // not confirmed yet
      expect(await failureOf(deliver(pending.id))).toBe('ORD-006');
      expect(await failureOf(ship(shipped.id))).toBe('ORD-006'); // already shipping
      expect(await failureOf(ship(delivered.id))).toBe('ORD-006');
      expect(await failureOf(deliver(delivered.id))).toBe('ORD-006');
      expect((await repo.findById(pending.id))?.status).toBe('PENDING');
      expect((await repo.findById(shipped.id))?.status).toBe('SHIPPING');
      expect((await repo.findById(delivered.id))?.version).toBe(4);
    });

    it('refuses a cancelled or expired order, and an order that does not exist with ORD-002', async () => {
      const cancelled = await place();
      await repo.transition(
        cancelled.id,
        OrderStatus.PENDING,
        OrderStatus.CANCELLED,
        orderStatusChangedEvent(
          cancelled,
          OrderStatus.PENDING,
          OrderStatus.CANCELLED,
        ),
      );

      expect(await failureOf(ship(cancelled.id))).toBe('ORD-006');
      expect(await failureOf(ship(randomUUID()))).toBe('ORD-002');
      expect(await failureOf(deliver(randomUUID()))).toBe('ORD-002');
    });

    it('5 shipments of the same order at once: one wins, four get ORD-006, one event', async () => {
      const order = await confirmed();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => ship(order.id)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason.code).toBe('ORD-006');
      }
      expect(await statusChanges(order.id)).toEqual([
        'PENDING>CONFIRMED',
        'CONFIRMED>SHIPPING',
      ]);
    });
  });

  describe('viewing one order (AC-14)', () => {
    it('gives the owner the whole order', async () => {
      const order = await place(U1);

      const read = await queries.execute<GetOrderQuery, Order>(
        new GetOrderQuery(U1, order.id),
      );

      expect(read).toMatchObject({ id: order.id, userId: U1, total: 200 });
      expect(read.items).toHaveLength(1);
      expect(read.shippingAddress.street).toBe('1 Đường Thử');
    });

    it("answers ORD-002 for another user's order and for one that does not exist, alike", async () => {
      const order = await place(U1);

      const theirs = await failureOf(
        queries.execute(new GetOrderQuery(U2, order.id)),
      );
      const nothing = await failureOf(
        queries.execute(new GetOrderQuery(U1, randomUUID())),
      );

      expect(theirs).toBe('ORD-002');
      expect(nothing).toBe('ORD-002');
    });
  });

  describe('listing orders (AC-14)', () => {
    const list = (userId: string, limit: number, cursor?: string) =>
      queries.execute<ListOrdersQuery, PaginatedResult<Order>>(
        new ListOrdersQuery(userId, limit, cursor),
      );

    it("shows only the user's own orders, newest first", async () => {
      const base = Date.now() - 60_000;
      const first = await place(U1, { createdAt: new Date(base) });
      const second = await place(U1, { createdAt: new Date(base + 1000) });
      await place(U2, { createdAt: new Date(base + 2000) });

      const page = await list(U1, 20);

      expect(page.data.map((o) => o.id)).toEqual([second.id, first.id]);
      expect(page.meta).toEqual({ hasMore: false, nextCursor: null });
      expect((await list(U2, 20)).data).toHaveLength(1);
    });

    it('pages through all orders without repeating or missing one, even when new orders arrive meanwhile', async () => {
      const base = Date.now() - 600_000;
      const ids: string[] = [];
      for (let i = 0; i < 7; i++)
        ids.push(
          (await place(U1, { createdAt: new Date(base + i * 1000) })).id,
        );
      const newestFirst = [...ids].reverse();

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list(U1, 3, cursor);
        seen.push(...page.data.map((o) => o.id));
        pages++;
        if (pages === 1) await place(U1); // a new order lands between two pages
        cursor = page.meta.nextCursor ?? undefined;
        if (!page.meta.hasMore) break;
      } while (cursor);

      expect(seen).toEqual(newestFirst); // no duplicate, none missing, the new one is simply not in this walk
      expect(pages).toBe(3);
    });

    it("refuses a cursor that is another user's order, or none at all, and never returns their data", async () => {
      const theirs = await place(U2);
      await place(U1);

      expect(await failureOf(list(U1, 10, theirs.id))).toBe('ORD-000');
      expect(await failureOf(list(U1, 10, randomUUID()))).toBe('ORD-000');
    });

    it.each([0, -1, 51, 1.5, Number.NaN])(
      'refuses a page size of %s',
      async (limit) => {
        expect(await failureOf(list(U1, limit))).toBe('ORD-000');
      },
    );

    it.each([1, 50])('accepts a page size of %s', async (limit) => {
      await expect(list(U1, limit)).resolves.toBeDefined();
    });
  });
});
