import { vi } from 'vitest';
import {
  PlaceOrderCommand,
  type PlaceOrderResult,
} from '../orders/application/index.js';
import { ReleaseReservationCommand } from '../inventory/application/index.js';
import { PaymentMethod } from '../orders/domain/index.js';
import {
  StartPaymentCommand,
  type StartPaymentResult,
} from './application/index.js';
import {
  buildPaymentFlow,
  type PaymentFlow,
} from './testing/payment-flow.fixture.js';

const COUNT = 100;
const PRICE = 50_000;
const userId = (i: number) => `pburst_user_${i}`;
const addressId = (i: number) => `pburst_address_${i}`;
const SKU = 'PBURST_SKU';

/** A small deterministic shuffle, so a failure can be repeated. */
const shuffled = <T>(items: T[], seed = 12345): T[] => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A hundred customers pay at once, and the gateway's messages arrive in a mess: out of order,
 * some twice or three times at the same moment, some late, some lost (the sweep asks the gateway
 * instead). Against the real Postgres and Redis with a connection pool of only 10, so a slow step
 * inside a transaction would show up as failures. What must hold in the end: every order is what
 * its money says, nothing is sold twice, nothing is charged twice, no request fails in a way the
 * customer cannot understand, and what the gateway collected minus what it gave back is the total
 * of the confirmed orders.
 */
describe('Payments arriving in bursts (Integration)', () => {
  let f: PaymentFlow;
  const originalPoolMax = process.env.DATABASE_POOL_MAX;

  beforeAll(async () => {
    process.env.DATABASE_POOL_MAX = '10';
    f = await buildPaymentFlow();
    await f.prisma.user.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({ id: userId(i) })),
      skipDuplicates: true,
    });
  }, 60_000);
  afterAll(async () => {
    await clean();
    await f.prisma.user.deleteMany({
      where: { id: { startsWith: 'pburst_user_' } },
    });
    await f.close();
    if (originalPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = originalPoolMax;
  });

  const clean = async () => {
    await f.prisma.outboxEvent.deleteMany();
    await f.prisma.inboxMessage.deleteMany();
    await f.prisma.payment.deleteMany({
      where: { order: { userId: { startsWith: 'pburst_user_' } } },
    });
    await f.prisma.order.deleteMany({
      where: { userId: { startsWith: 'pburst_user_' } },
    });
    await f.prisma.address.deleteMany({
      where: { userId: { startsWith: 'pburst_user_' } },
    });
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    await clean();
    await f.reset();
    await f.prisma.sku.create({
      data: {
        id: SKU,
        productId: 'pay_prod',
        price: PRICE,
        attributes: { n: 'burst' },
        skuCode: 'PBURST-CODE',
      },
    });
    await f.prisma.skuStock.create({ data: { skuId: SKU, onHand: COUNT } });
    await f.prisma.address.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({
        id: addressId(i),
        userId: userId(i),
        recipientName: 'Nguyễn Văn A',
        phone: '0901234567',
        provinceCode: '97',
        provinceName: 'Tỉnh Thử Nghiệm',
        wardCode: '97001',
        wardName: 'Phường Thử Nghiệm',
        street: '12 Đường Thử',
      })),
    });
  }, 60_000);

  /** A hundred customers each place an online order for one unit and start paying. */
  const everyonePays = async () => {
    for (let i = 0; i < COUNT; i++)
      await f.cartStore.add(userId(i), SKU, 1, PRICE);
    const placed = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        f.commands.execute<PlaceOrderCommand, PlaceOrderResult>(
          new PlaceOrderCommand(
            userId(i),
            `pburst-order-${i}-xxxx`,
            addressId(i),
            PaymentMethod.ONLINE,
          ),
        ),
      ),
    );
    const started = await Promise.allSettled(
      placed.map(({ order }, i) =>
        f.commands.execute<StartPaymentCommand, StartPaymentResult>(
          new StartPaymentCommand(userId(i), order.id, `pburst-pay-${i}-xxxx`),
        ),
      ),
    );
    expect(started.filter((s) => s.status === 'rejected')).toEqual([]);
    return started.map((s, i) => ({
      order: placed[i].order,
      payment: (s as PromiseFulfilledResult<StartPaymentResult>).value.payment,
    }));
  };

  /**
   * The webhooks of all the payments, in a mess: shuffled, each at a random moment, every fifth one
   * three times at the same instant, every tenth one again later. The ones in `lost` never arrive.
   */
  const stormOfWebhooks = async (
    all: Awaited<ReturnType<typeof everyonePays>>,
    lost: Set<string>,
  ) => {
    const outcomes: PromiseSettledResult<unknown>[] = [];
    await Promise.all(
      shuffled(all).map(async ({ payment }, n) => {
        const ref = payment.providerRef as string;
        if (lost.has(payment.id)) {
          f.gateway.markPaid(ref); // the money came in; the message did not
          return;
        }
        await pause((n * 7) % 40);
        const eventId = `burst-event-${payment.id}`;
        const copies = n % 5 === 0 ? 3 : 1;
        outcomes.push(
          ...(await Promise.allSettled(
            Array.from({ length: copies }, () =>
              f.apply(ref, 'PAID', PRICE, eventId),
            ),
          )),
        );
        if (n % 10 === 0) {
          await pause(30);
          outcomes.push(
            ...(await Promise.allSettled([
              f.apply(ref, 'PAID', PRICE, eventId),
            ])),
          );
        }
      }),
    );
    return outcomes;
  };

  /** Sends everything the outbox holds, until there is nothing left. */
  const emptyOutbox = async () => {
    for (let round = 0; round < 50; round++) {
      const { sent } = await f.publisher.runOnce();
      if (sent === 0) break;
    }
    expect(
      await f.prisma.outboxEvent.count({ where: { publishedAt: null } }),
    ).toBe(0);
  };
  const countOrders = (status: string) =>
    f.prisma.order.count({
      where: {
        userId: { startsWith: 'pburst_user_' },
        status: status as never,
      },
    });
  const countPayments = (status: string) =>
    f.prisma.payment.count({
      where: {
        order: { userId: { startsWith: 'pburst_user_' } },
        status: status as never,
      },
    });

  it('100 customers pay, the messages come in a mess, some are lost: every order is confirmed, once each (AC-19)', async () => {
    const all = await everyonePays();
    expect(f.gateway.chargeCount).toBe(COUNT);
    // Every seventh message is lost; the sweep asks the gateway about those
    const lost = new Set(
      all.filter((_, i) => i % 7 === 3).map((a) => a.payment.id),
    );
    for (const id of lost) await f.setPaymentColumn(id, 'createdAt', 3_600_000);

    const [outcomes] = await Promise.all([
      stormOfWebhooks(all, lost),
      // a round of the sweep in the middle of the storm: it must not get in the way
      pause(50).then(() => f.maintenance.runOnce()),
    ]);
    await f.maintenance.runOnce();

    expect(outcomes.filter((o) => o.status === 'rejected')).toEqual([]);
    expect(await countOrders('CONFIRMED')).toBe(COUNT);
    expect(await countPayments('SUCCEEDED')).toBe(COUNT);
    expect(await f.onHand(SKU)).toBe(0); // each order took one unit, once
    expect(
      await f.prisma.reservation.count({ where: { status: 'CONFIRMED' } }),
    ).toBe(COUNT);
    expect(f.gateway.chargeCount).toBe(COUNT); // each payment is one charge at the gateway
    expect(f.gateway.refundCount).toBe(0);
    // One "payment succeeded" and one "order confirmed" for each, however many messages came
    expect(
      await f.prisma.outboxEvent.count({
        where: { type: 'payment.succeeded' },
      }),
    ).toBe(COUNT);
    for (const { order } of all.slice(0, 20)) {
      expect(await f.orderChanges(order.id)).toEqual([
        'PENDING>PAYMENT_PROCESSING',
        'PAYMENT_PROCESSING>CONFIRMED',
      ]);
    }
    await emptyOutbox();
  }, 120_000);

  it('only 60 of the 100 still have their stock held when the money arrives: 60 confirmed, 40 expired and refunded, and the books balance (AC-19)', async () => {
    const all = await everyonePays();
    // The holds of 40 of them ran out before their money came in
    const gone = all.filter((_, i) => i % 5 < 2); // 40 of the 100
    expect(gone).toHaveLength(40);
    for (const { order } of gone)
      await f.commands.execute(new ReleaseReservationCommand(order.id));

    const outcomes = await stormOfWebhooks(all, new Set());

    // The webhooks alone did it, without waiting for the sweep: the money is already back
    expect(outcomes.filter((o) => o.status === 'rejected')).toEqual([]);
    expect(await countPayments('REFUNDED')).toBe(40);
    expect(f.gateway.refundCount).toBe(40);
    await f.maintenance.runOnce(); // the safety net finds nothing left to do
    expect(await countOrders('CONFIRMED')).toBe(60);
    expect(await countOrders('EXPIRED')).toBe(40);
    expect(await countPayments('SUCCEEDED')).toBe(60);
    expect(await countPayments('REFUNDED')).toBe(40);
    expect(await f.onHand(SKU)).toBe(COUNT - 60);
    expect(f.gateway.chargeCount).toBe(COUNT);
    expect(f.gateway.refundCount).toBe(40);

    // What the gateway collected minus what it gave back is the total of the confirmed orders
    const collected = await f.prisma.payment.aggregate({
      _sum: { paidAmount: true },
      where: {
        order: { userId: { startsWith: 'pburst_user_' } },
        status: { in: ['SUCCEEDED', 'REFUNDED'] },
      },
    });
    const refunded = await f.prisma.payment.aggregate({
      _sum: { paidAmount: true },
      where: {
        order: { userId: { startsWith: 'pburst_user_' } },
        status: 'REFUNDED',
      },
    });
    const confirmed = await f.prisma.order.aggregate({
      _sum: { total: true },
      where: { userId: { startsWith: 'pburst_user_' }, status: 'CONFIRMED' },
    });
    expect(
      Number(collected._sum.paidAmount) - Number(refunded._sum.paidAmount),
    ).toBe(Number(confirmed._sum.total));
    expect(Number(confirmed._sum.total)).toBe(60 * PRICE);
    await emptyOutbox();
  }, 120_000);
});
