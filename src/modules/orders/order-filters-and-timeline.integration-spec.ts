import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule, QueryBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import {
  DatabaseModule,
  PrismaService,
  type PaginatedResult,
} from '@/core/index.js';
import { PrismaOrderRepository } from './infrastructure/index.js';
import {
  CountOrdersByStatusHandler,
  CountOrdersByStatusQuery,
  GetOrderHandler,
  GetOrderQuery,
  ListOrdersHandler,
  ListOrdersQuery,
} from './application/index.js';
import {
  ALL_ORDER_STATUSES,
  Order,
  OrderStatus,
  PaymentMethod,
  orderCreatedEvent,
  orderStatusChangedEvent,
  type OrderListFilters,
  type OrderStatusCounts,
} from './domain/index.js';

const U1 = 'ord_filter_user_1';
const U2 = 'ord_filter_user_2';
const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

/**
 * Narrowing the customer's list of orders (status, time range, start of the id), counting them by
 * status, and the times an order reaches each status, against the real order tables.
 */
describe('Order list filters, counts and timeline (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let queries: QueryBus;
  let repo: PrismaOrderRepository;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule, CqrsModule],
      providers: [
        PrismaOrderRepository,
        { provide: 'IOrderRepository', useExisting: PrismaOrderRepository },
        GetOrderHandler,
        ListOrdersHandler,
        CountOrdersByStatusHandler,
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
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

  /** An order placed at `createdAt`, moved through `path` (each step a real conditional UPDATE). */
  const order = async (
    options: {
      userId?: string;
      createdAt?: Date;
      method?: PaymentMethod;
      path?: OrderStatus[];
    } = {},
  ) => {
    const placed = Order.create({
      userId: options.userId ?? U1,
      idempotencyKey: `filter-key-${randomUUID()}`,
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
    await repo.create(placed, orderCreatedEvent(placed));
    let from = OrderStatus.PENDING;
    for (const to of options.path ?? []) {
      await move(placed, from, to);
      from = to;
    }
    return placed;
  };
  const move = (placed: Order, from: OrderStatus, to: OrderStatus) =>
    repo.transition(
      placed.id,
      from,
      to,
      orderStatusChangedEvent(placed, from, to),
    );
  const list = async (
    filters: OrderListFilters = {},
    options: { userId?: string; limit?: number; cursor?: string } = {},
  ) =>
    queries.execute<ListOrdersQuery, PaginatedResult<Order>>(
      new ListOrdersQuery(
        options.userId ?? U1,
        options.limit ?? 50,
        options.cursor,
        filters,
      ),
    );
  const idsOf = async (
    filters: OrderListFilters = {},
    options: { userId?: string } = {},
  ) => (await list(filters, options)).data.map((o) => o.id);
  const counts = (filters: OrderListFilters = {}, userId = U1) =>
    queries.execute<CountOrdersByStatusQuery, OrderStatusCounts>(
      new CountOrdersByStatusQuery(userId, filters),
    );
  const failureOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return error.code as string;
    }
    throw new Error('should have failed');
  };

  // ── AC-21: the list ───────────────────────────────────────────────────────

  describe('narrowing the list (AC-21)', () => {
    it('by one or several statuses, newest first', async () => {
      const oldest = await order({ createdAt: day('2026-09-01') });
      const confirmed = await order({
        createdAt: day('2026-09-02'),
        path: [OrderStatus.CONFIRMED],
      });
      const cancelled = await order({
        createdAt: day('2026-09-03'),
        path: [OrderStatus.CANCELLED],
      });
      const newest = await order({ createdAt: day('2026-09-04') });

      expect(await idsOf({ statuses: [OrderStatus.PENDING] })).toEqual([
        newest.id,
        oldest.id,
      ]);
      expect(
        await idsOf({
          statuses: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
        }),
      ).toEqual([cancelled.id, confirmed.id]);
      expect(await idsOf({ statuses: [OrderStatus.DELIVERED] })).toEqual([]);
    });

    it('by a time range with both ends included, and with one end left open', async () => {
      const a = await order({ createdAt: day('2026-09-01') });
      const b = await order({ createdAt: day('2026-09-10') });
      const c = await order({ createdAt: day('2026-09-20') });

      expect(
        await idsOf({
          createdFrom: day('2026-09-01'),
          createdTo: day('2026-09-10'),
        }),
      ).toEqual([b.id, a.id]); // the first and the last moment are both in
      expect(await idsOf({ createdFrom: day('2026-09-02') })).toEqual([
        c.id,
        b.id,
      ]);
      expect(await idsOf({ createdTo: day('2026-09-09') })).toEqual([a.id]);
      expect(
        await idsOf({
          createdFrom: new Date('2026-09-10T12:00:00.001Z'),
          createdTo: day('2026-09-19'),
        }),
      ).toEqual([]);
    });

    it('a moment written with another time zone means the same instant', async () => {
      const placed = await order({
        createdAt: new Date('2026-09-10T20:30:00.000Z'),
      });
      // 2026-09-11 03:30 in Vietnam (+07:00) is that same instant
      const from = new Date('2026-09-11T03:30:00+07:00');
      const after = new Date('2026-09-11T03:30:01+07:00');

      expect(await idsOf({ createdFrom: from, createdTo: from })).toEqual([
        placed.id,
      ]);
      expect(await idsOf({ createdFrom: after })).toEqual([]);
    });

    it('by the start of the id, in lower case; a longer start narrows it more', async () => {
      const a = await order();
      const b = await order();

      expect(await idsOf({ code: a.id.slice(0, 8) })).toEqual([a.id]);
      expect(await idsOf({ code: a.id })).toEqual([a.id]);
      expect(await idsOf({ code: a.id.slice(0, 6) })).toContain(a.id);
      expect(await idsOf({ code: 'ffffffff' })).toEqual([]);
      expect(b.id).not.toEqual(a.id);
    });

    it('all together: only what holds every filter', async () => {
      const wanted = await order({
        createdAt: day('2026-09-10'),
        path: [OrderStatus.CONFIRMED],
      });
      await order({ createdAt: day('2026-09-10') }); // wrong status
      await order({
        createdAt: day('2026-08-10'),
        path: [OrderStatus.CONFIRMED],
      }); // wrong time

      expect(
        await idsOf({
          statuses: [OrderStatus.CONFIRMED],
          createdFrom: day('2026-09-01'),
          createdTo: day('2026-09-30'),
          code: wanted.id.slice(0, 8),
        }),
      ).toEqual([wanted.id]);
    });

    it('pages with a cursor through a filtered list: every match once, none missed', async () => {
      const matching: string[] = [];
      for (let i = 1; i <= 7; i++) {
        matching.push(
          (
            await order({
              createdAt: day(`2026-09-0${i}`),
              path: [OrderStatus.CONFIRMED],
            })
          ).id,
        );
        await order({ createdAt: day(`2026-09-0${i}`) }); // a PENDING one between them
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list(
          { statuses: [OrderStatus.CONFIRMED] },
          { limit: 3, cursor },
        );
        seen.push(...page.data.map((o) => o.id));
        cursor = page.meta.nextCursor ?? undefined;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toEqual([...matching].reverse());
    });

    it('a cursor is only a position: another filter on the next page still works', async () => {
      const a = await order({
        createdAt: day('2026-09-01'),
        path: [OrderStatus.CONFIRMED],
      });
      const b = await order({ createdAt: day('2026-09-02') });
      const c = await order({
        createdAt: day('2026-09-03'),
        path: [OrderStatus.CONFIRMED],
      });
      const first = await list({}, { limit: 1 });
      expect(first.data[0].id).toBe(c.id);

      const next = await list(
        { statuses: [OrderStatus.CONFIRMED] },
        { cursor: first.meta.nextCursor ?? undefined },
      );

      expect(next.data.map((o) => o.id)).toEqual([a.id]);
      expect(b.id).toBeDefined();
    });

    it('never shows an order of somebody else, whatever the filter says', async () => {
      const mine = await order({ path: [OrderStatus.CONFIRMED] });
      const theirs = await order({
        userId: U2,
        path: [OrderStatus.CONFIRMED],
      });

      expect(await idsOf({ statuses: [OrderStatus.CONFIRMED] })).toEqual([
        mine.id,
      ]);
      expect(await idsOf({ code: theirs.id })).toEqual([]);
      expect(await idsOf({ code: theirs.id.slice(0, 8) })).toEqual([]);
      expect(
        await idsOf({ createdFrom: day('2000-01-01') }, { userId: U2 }),
      ).toEqual([theirs.id]);
      // somebody else's order is no cursor either
      expect(await failureOf(list({}, { cursor: theirs.id }))).toBe('ORD-000');
    });

    it('refuses a filter that cannot mean anything, with ORD-000', async () => {
      expect(await failureOf(list({ statuses: [] }))).toBe('ORD-000');
      expect(
        await failureOf(list({ statuses: ['NOPE' as unknown as OrderStatus] })),
      ).toBe('ORD-000');
      expect(
        await failureOf(
          list({
            createdFrom: day('2026-09-10'),
            createdTo: day('2026-09-01'),
          }),
        ),
      ).toBe('ORD-000');
      expect(await failureOf(list({ createdFrom: new Date('nonsense') }))).toBe(
        'ORD-000',
      );
      for (const code of ['abc', 'a'.repeat(37), 'XYZ123', "abc123'; --"]) {
        expect(await failureOf(list({ code }))).toBe('ORD-000');
      }
    });

    it('with no filter the list is what it was before: all of mine, newest first, with their items', async () => {
      const a = await order({ createdAt: day('2026-09-01') });
      const b = await order({ createdAt: day('2026-09-02') });

      const page = await list();

      expect(page.data.map((o) => o.id)).toEqual([b.id, a.id]);
      expect(page.data[0].items).toHaveLength(1);
    });
  });

  // ── AC-22: the counts ─────────────────────────────────────────────────────

  describe('counting by status (AC-22)', () => {
    it('gives every status, 0 where there is none, and only my orders', async () => {
      await order();
      await order();
      await order({ path: [OrderStatus.CONFIRMED] });
      await order({ path: [OrderStatus.CANCELLED] });
      await order({ userId: U2, path: [OrderStatus.CONFIRMED] });

      const result = await counts();

      expect(Object.keys(result).sort()).toEqual(
        [...ALL_ORDER_STATUSES].sort(),
      );
      expect(result).toEqual({
        PENDING: 2,
        PAYMENT_PROCESSING: 0,
        CONFIRMED: 1,
        SHIPPING: 0,
        DELIVERED: 0,
        CANCELLED: 1,
        EXPIRED: 0,
      });
      expect((await counts({}, U2)).CONFIRMED).toBe(1);
    });

    it('is a user with no orders at all: every status is 0', async () => {
      const result = await counts({}, 'nobody');

      expect(Object.values(result).every((n) => n === 0)).toBe(true);
    });

    it('counts inside the time range and the start of the id the same way the list does', async () => {
      await order({ createdAt: day('2026-09-01') });
      await order({
        createdAt: day('2026-09-10'),
        path: [OrderStatus.CONFIRMED],
      });
      const late = await order({
        createdAt: day('2026-09-20'),
        path: [OrderStatus.CONFIRMED],
      });

      const range = await counts({ createdFrom: day('2026-09-05') });
      const byCode = await counts({ code: late.id.slice(0, 8) });

      expect(range).toMatchObject({ PENDING: 0, CONFIRMED: 2 });
      expect(byCode).toMatchObject({ PENDING: 0, CONFIRMED: 1 });
      // the total of the counts is the number of orders the list shows for the same filters
      expect(Object.values(range).reduce((sum, n) => sum + n, 0)).toBe(
        (await list({ createdFrom: day('2026-09-05') })).data.length,
      );
    });

    it('counts every status even if the repository is handed a status filter (the handler refuses it first)', async () => {
      await order();
      await order({ path: [OrderStatus.CONFIRMED] });

      const result = await repo.countByStatus(U1, {
        statuses: [OrderStatus.PENDING],
      });

      expect(result).toMatchObject({ PENDING: 1, CONFIRMED: 1 });
    });

    it('refuses a status filter and a bad range, with ORD-000', async () => {
      expect(await failureOf(counts({ statuses: [OrderStatus.PENDING] }))).toBe(
        'ORD-000',
      );
      expect(
        await failureOf(
          counts({
            createdFrom: day('2026-09-10'),
            createdTo: day('2026-09-01'),
          }),
        ),
      ).toBe('ORD-000');
      expect(await failureOf(counts({ code: 'xyz' }))).toBe('ORD-000');
    });
  });

  // ── AC-23: the timeline ───────────────────────────────────────────────────

  describe('the times an order reaches each status (AC-23)', () => {
    const NEVER = {
      confirmedAt: null,
      shippedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      expiredAt: null,
    };
    const timelineOf = async (id: string) =>
      (await repo.findById(id))?.timeline;
    const near = (time: Date | null | undefined) => {
      expect(time).toBeInstanceOf(Date);
      expect(Math.abs((time as Date).getTime() - Date.now())).toBeLessThan(
        60_000,
      );
    };

    it('a new order has no time yet', async () => {
      const placed = await order();

      expect(placed.timeline).toEqual(NEVER);
      expect(await timelineOf(placed.id)).toEqual(NEVER);
    });

    it('each move records its own time and no other', async () => {
      const placed = await order();

      await move(placed, OrderStatus.PENDING, OrderStatus.CONFIRMED);
      let timeline = await timelineOf(placed.id);
      near(timeline?.confirmedAt);
      expect({ ...timeline, confirmedAt: null }).toEqual(NEVER);

      await move(placed, OrderStatus.CONFIRMED, OrderStatus.SHIPPING);
      timeline = await timelineOf(placed.id);
      near(timeline?.shippedAt);
      expect(timeline?.deliveredAt).toBeNull();

      await move(placed, OrderStatus.SHIPPING, OrderStatus.DELIVERED);
      timeline = await timelineOf(placed.id);
      near(timeline?.deliveredAt);
      expect(timeline?.cancelledAt).toBeNull();
      expect(timeline?.expiredAt).toBeNull();
      // each time is not before the one that came earlier
      expect(
        (timeline?.confirmedAt as Date) <= (timeline?.shippedAt as Date),
      ).toBe(true);
      expect(
        (timeline?.shippedAt as Date) <= (timeline?.deliveredAt as Date),
      ).toBe(true);
    });

    it('cancelling and expiring record their times', async () => {
      const cancelled = await order({ path: [OrderStatus.CANCELLED] });
      const expired = await order({ path: [OrderStatus.EXPIRED] });
      const online = await order({
        method: PaymentMethod.ONLINE,
        path: [OrderStatus.PAYMENT_PROCESSING, OrderStatus.EXPIRED],
      });

      near((await timelineOf(cancelled.id))?.cancelledAt);
      expect((await timelineOf(cancelled.id))?.expiredAt).toBeNull();
      near((await timelineOf(expired.id))?.expiredAt);
      near((await timelineOf(online.id))?.expiredAt);
    });

    it('starting to pay and opening the order again record no time', async () => {
      const online = await order({
        method: PaymentMethod.ONLINE,
        path: [
          OrderStatus.PAYMENT_PROCESSING,
          OrderStatus.PENDING,
          OrderStatus.PAYMENT_PROCESSING,
        ],
      });

      expect(await timelineOf(online.id)).toEqual(NEVER);
    });

    it('a move that loses changes no time', async () => {
      const placed = await order({ path: [OrderStatus.CONFIRMED] });
      const before = await timelineOf(placed.id);

      const lost = await move(placed, OrderStatus.PENDING, OrderStatus.EXPIRED);

      expect(lost).toBeNull();
      expect(await timelineOf(placed.id)).toEqual(before);
    });

    it('a cancel and a ship at the same moment: one wins and only its time is written', async () => {
      const placed = await order({ path: [OrderStatus.CONFIRMED] });

      const results = await Promise.all([
        move(placed, OrderStatus.CONFIRMED, OrderStatus.CANCELLED),
        move(placed, OrderStatus.CONFIRMED, OrderStatus.SHIPPING),
      ]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const timeline = await timelineOf(placed.id);
      const written = [timeline?.cancelledAt, timeline?.shippedAt].filter(
        (t) => t !== null,
      );
      expect(written).toHaveLength(1);
    });

    it('is on the order the customer reads, and the times stay a moment in time', async () => {
      const placed = await order({ path: [OrderStatus.CONFIRMED] });

      const read = await queries.execute<GetOrderQuery, Order>(
        new GetOrderQuery(U1, placed.id),
      );

      near(read.timeline.confirmedAt);
      expect(read.timeline.shippedAt).toBeNull();
    });

    it('an order from before the columns existed reads as no times', async () => {
      const placed = await order({ path: [OrderStatus.CONFIRMED] });
      await prisma.$executeRaw`UPDATE "Order" SET "confirmedAt" = NULL WHERE "id" = ${placed.id}`;

      expect((await timelineOf(placed.id))?.confirmedAt).toBeNull();
    });
  });
});
