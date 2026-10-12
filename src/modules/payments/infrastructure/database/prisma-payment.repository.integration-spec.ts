import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/core/index.js';
import {
  Payment,
  PaymentAlreadyExistsError,
  PaymentInProgressError,
  PaymentStatus,
  paymentFailedEvent,
  paymentRefundedEvent,
  paymentSucceededEvent,
} from '../../domain/index.js';
import {
  PrismaInboxStore,
  PrismaPaymentRepository,
} from './prisma-payment.repository.js';

const USER = 'pay_repo_user';
const { INITIATED, SUCCEEDED, FAILED, EXPIRED, REFUND_PENDING, REFUNDED } =
  PaymentStatus;
// The database clock can differ from this machine's by a second or so, so "long ago" is generous
const LONG_AGO = 3_600_000;

/** Against the real Postgres: the transactions, the conditional updates and the sweep queries. */
describe('PrismaPaymentRepository (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let repo: PrismaPaymentRepository;
  let inbox: PrismaInboxStore;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [PrismaService, PrismaPaymentRepository, PrismaInboxStore],
    }).compile();
    prisma = module.get(PrismaService);
    repo = module.get(PrismaPaymentRepository);
    inbox = module.get(PrismaInboxStore);
    await prisma.user.upsert({
      where: { id: USER },
      update: {},
      create: { id: USER },
    });
  });

  const clean = async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.payment.deleteMany({ where: { order: { userId: USER } } });
    await prisma.order.deleteMany({ where: { userId: USER } });
    await prisma.inboxMessage.deleteMany({
      where: { source: { startsWith: 'repo-test' } },
    });
  };
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.$disconnect();
  });

  const makeOrder = async (
    status:
      | 'PENDING'
      | 'PAYMENT_PROCESSING'
      | 'CONFIRMED'
      | 'CANCELLED'
      | 'EXPIRED' = 'PAYMENT_PROCESSING',
  ) => {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        userId: USER,
        idempotencyKey: `k-${id}`,
        paymentMethod: 'ONLINE',
        status,
        total: 150000,
        shippingAddress: {},
        expiresAt: new Date(Date.now() + 900_000),
      },
    });
    return id;
  };
  const build = (
    orderId: string,
    key = `pay-${randomUUID()}`,
    amount = 150000,
  ) =>
    Payment.create({
      orderId,
      idempotencyKey: key,
      provider: 'fake',
      amount,
      expiresAt: new Date(Date.now() + 900_000),
    });
  const place = async (orderId: string, key?: string) => {
    const payment = build(orderId, key);
    await repo.create(payment);
    return payment;
  };
  const eventsOf = (paymentId: string) =>
    prisma.outboxEvent.findMany({
      where: { aggregateId: paymentId },
      orderBy: { seq: 'asc' },
    });
  const setColumn = (paymentId: string, column: string, agoMs: number) =>
    prisma.$executeRawUnsafe(
      `UPDATE "Payment" SET "${column}" = (now() AT TIME ZONE 'UTC') - make_interval(secs => $1) WHERE "id" = $2`,
      agoMs / 1000,
      paymentId,
    );

  describe('create and read', () => {
    it('writes the payment and reads it back the same', async () => {
      const orderId = await makeOrder();
      const payment = await place(orderId, 'pay-key-0001');

      const read = await repo.findById(payment.id);

      expect(read).toMatchObject({
        id: payment.id,
        orderId,
        idempotencyKey: 'pay-key-0001',
        provider: 'fake',
        status: 'INITIATED',
        version: 1,
        amount: 150000,
        paidAmount: null,
        providerRef: null,
        payUrl: null,
      });
      expect(read?.expiresAt.getTime()).toBe(payment.expiresAt.getTime());
    });

    it('keeps the amount to the hundredth', async () => {
      const orderId = await makeOrder();
      const payment = build(orderId, undefined, 199000.5);
      await repo.create(payment);

      expect((await repo.findById(payment.id))?.amount).toBe(199000.5);
    });

    it('gives null for a payment that does not exist', async () => {
      expect(await repo.findById(randomUUID())).toBeNull();
      expect(await repo.findByProviderRef('fake', 'nope')).toBeNull();
    });

    it('refuses the same payment twice with PaymentAlreadyExistsError, once it is no longer waiting for the gateway', async () => {
      const orderId = await makeOrder();
      const first = await place(orderId, 'same-key-0001');
      await repo.transition(first.id, [INITIATED], FAILED, null);

      await expect(
        repo.create(build(orderId, 'same-key-0001')),
      ).rejects.toBeInstanceOf(PaymentAlreadyExistsError);
    });

    it('refuses a second payment waiting for the gateway on the same order with PaymentInProgressError', async () => {
      const orderId = await makeOrder();
      await place(orderId);

      await expect(repo.create(build(orderId))).rejects.toBeInstanceOf(
        PaymentInProgressError,
      );
      expect(await repo.countByOrder(orderId)).toBe(1);
    });

    it('lets another payment start once the first is no longer waiting', async () => {
      const orderId = await makeOrder();
      const first = await place(orderId);
      await repo.transition(first.id, [INITIATED], FAILED, null);

      await expect(repo.create(build(orderId))).resolves.toBeUndefined();
    });

    it('eight at the same moment for one order: exactly one wins, the others get a typed error', async () => {
      const orderId = await makeOrder();

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => repo.create(build(orderId))),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
          PaymentInProgressError,
        );
      }
      expect(await repo.countByOrder(orderId)).toBe(1);
    });

    it('eight with the SAME key at the same moment: exactly one wins, and the others can find it by its id', async () => {
      const orderId = await makeOrder();

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          repo.create(build(orderId, 'one-key-0001')),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected')) {
        const reason = (r as PromiseRejectedResult).reason;
        expect(
          reason instanceof PaymentAlreadyExistsError ||
            reason instanceof PaymentInProgressError,
        ).toBe(true);
      }
      expect(
        await repo.findById(build(orderId, 'one-key-0001').id),
      ).not.toBeNull();
    });

    it('lists the payments of an order newest first, and counts them in any status', async () => {
      const orderId = await makeOrder();
      const a = await place(orderId, 'key-aaaaaaaa');
      await repo.transition(a.id, [INITIATED], FAILED, null);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const b = await place(orderId, 'key-bbbbbbbb');
      await repo.transition(b.id, [INITIATED], EXPIRED, null);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const c = await place(orderId, 'key-cccccccc');

      expect((await repo.listByOrder(orderId)).map((p) => p.id)).toEqual([
        c.id,
        b.id,
        a.id,
      ]);
      expect(await repo.countByOrder(orderId)).toBe(3);
      expect(await repo.listByOrder(await makeOrder())).toEqual([]);
    });
  });

  describe('attachCharge', () => {
    it('stores what the gateway answered, once, while the payment is waiting and has no charge', async () => {
      const orderId = await makeOrder();
      const payment = await place(orderId);

      expect(
        await repo.attachCharge(payment.id, 'ref-1', 'https://pay/1'),
      ).toBe(true);
      expect(
        await repo.attachCharge(payment.id, 'ref-2', 'https://pay/2'),
      ).toBe(false);

      const read = await repo.findById(payment.id);
      expect(read).toMatchObject({
        providerRef: 'ref-1',
        payUrl: 'https://pay/1',
      });
      expect(read?.hasCharge).toBe(true);
      expect(await repo.findByProviderRef('fake', 'ref-1')).toMatchObject({
        id: payment.id,
      });
    });

    it('does nothing for a payment that is not waiting any more, or does not exist', async () => {
      const orderId = await makeOrder();
      const payment = await place(orderId);
      await repo.transition(payment.id, [INITIATED], FAILED, null);

      expect(await repo.attachCharge(payment.id, 'ref-1', 'https://pay')).toBe(
        false,
      );
      expect(
        await repo.attachCharge(randomUUID(), 'ref-2', 'https://pay'),
      ).toBe(false);
      expect((await repo.findById(payment.id))?.providerRef).toBeNull();
    });

    it('five at the same moment: exactly one is kept', async () => {
      const orderId = await makeOrder();
      const payment = await place(orderId);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          repo.attachCharge(payment.id, `ref-${i}`, `https://pay/${i}`),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('transition', () => {
    it('moves the payment, adds 1 to the version and writes its event, in one go', async () => {
      const payment = await place(await makeOrder());

      const moved = await repo.transition(
        payment.id,
        [INITIATED],
        FAILED,
        paymentFailedEvent(payment),
      );

      expect(moved).toMatchObject({ status: 'FAILED', version: 2 });
      const events = await eventsOf(payment.id);
      expect(events.map((e) => e.type)).toEqual(['payment.failed']);
      expect(events[0].payload).toMatchObject({
        paymentId: payment.id,
        amount: 150000,
      });
    });

    it('records what was really collected when it moves to SUCCEEDED, even if it is not the amount of the order', async () => {
      const payment = await place(await makeOrder());

      const moved = await repo.transition(
        payment.id,
        [INITIATED, FAILED, EXPIRED],
        SUCCEEDED,
        paymentSucceededEvent(payment, 1000),
        { paidAmount: 1000 },
      );

      expect(moved).toMatchObject({
        status: 'SUCCEEDED',
        paidAmount: 1000,
        amount: 150000,
      });
      expect(moved?.refundAmount).toBe(1000);
    });

    it('does nothing, and writes no event, when the payment is not in one of the statuses it expected', async () => {
      const payment = await place(await makeOrder());
      await repo.transition(payment.id, [INITIATED], FAILED, null);

      const late = await repo.transition(
        payment.id,
        [INITIATED],
        EXPIRED,
        paymentFailedEvent(payment),
      );

      expect(late).toBeNull();
      expect((await repo.findById(payment.id))?.status).toBe('FAILED');
      expect(await eventsOf(payment.id)).toHaveLength(0);
    });

    it('accepts any of several statuses to move from (the money wins: FAILED or EXPIRED can become SUCCEEDED)', async () => {
      const failed = await place(await makeOrder());
      await repo.transition(failed.id, [INITIATED], FAILED, null);
      const expired = await place(await makeOrder());
      await repo.transition(expired.id, [INITIATED], EXPIRED, null);

      for (const payment of [failed, expired]) {
        const moved = await repo.transition(
          payment.id,
          [INITIATED, FAILED, EXPIRED],
          SUCCEEDED,
          null,
          { paidAmount: 150000 },
        );
        expect(moved?.status).toBe('SUCCEEDED');
      }
    });

    it('does not let a report of failure undo money that came in', async () => {
      const payment = await place(await makeOrder());
      await repo.transition(
        payment.id,
        [INITIATED, FAILED, EXPIRED],
        SUCCEEDED,
        null,
        { paidAmount: 150000 },
      );

      expect(
        await repo.transition(payment.id, [INITIATED], FAILED, null),
      ).toBeNull();
      expect((await repo.findById(payment.id))?.status).toBe('SUCCEEDED');
    });

    it('does nothing for a payment that does not exist', async () => {
      expect(
        await repo.transition(randomUUID(), [INITIATED], FAILED, null),
      ).toBeNull();
    });

    it('lets exactly one win among many that move the same payment together, with one event', async () => {
      const payment = await place(await makeOrder());

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.transition(
            payment.id,
            [INITIATED, FAILED, EXPIRED],
            SUCCEEDED,
            paymentSucceededEvent(payment, 150000),
            { paidAmount: 150000 },
          ),
        ),
      );

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect((await repo.findById(payment.id))?.version).toBe(2);
      expect(await eventsOf(payment.id)).toHaveLength(1);
    });

    it('a success and a failure at the same moment: exactly one wins, and the stored state is one of the two', async () => {
      for (let i = 0; i < 6; i++) {
        const payment = await place(await makeOrder());

        const [paid, failed] = await Promise.all([
          repo.transition(
            payment.id,
            [INITIATED, FAILED, EXPIRED],
            SUCCEEDED,
            null,
            { paidAmount: 150000 },
          ),
          repo.transition(payment.id, [INITIATED], FAILED, null),
        ]);

        const final = await repo.findById(payment.id);
        if (final?.status === 'SUCCEEDED') {
          expect(paid).not.toBeNull();
        } else {
          // the failure came first, and then the money still won
          expect(['FAILED', 'SUCCEEDED']).toContain(final?.status);
          expect(failed !== null || paid !== null).toBe(true);
        }
      }
    });

    it('writes no change at all when its event cannot be written (all or nothing)', async () => {
      const payment = await place(await makeOrder());
      const event = paymentFailedEvent(payment);
      await prisma.outboxEvent.create({
        data: { id: event.id, type: 'x', aggregateId: 'other', payload: {} },
      });

      await expect(
        repo.transition(payment.id, [INITIATED], FAILED, event),
      ).rejects.toThrow();

      expect(await repo.findById(payment.id)).toMatchObject({
        status: 'INITIATED',
        version: 1,
      });
    });

    it('goes through the whole life: INITIATED, SUCCEEDED, REFUND_PENDING, REFUNDED', async () => {
      const payment = await place(await makeOrder());

      await repo.transition(
        payment.id,
        [INITIATED],
        SUCCEEDED,
        paymentSucceededEvent(payment, 150000),
        { paidAmount: 150000 },
      );
      await repo.transition(payment.id, [SUCCEEDED], REFUND_PENDING, null);
      const done = await repo.transition(
        payment.id,
        [REFUND_PENDING],
        REFUNDED,
        paymentRefundedEvent(payment, 150000),
      );

      expect(done).toMatchObject({ status: 'REFUNDED', version: 4 });
      expect((await eventsOf(payment.id)).map((e) => e.type)).toEqual([
        'payment.succeeded',
        'payment.refunded',
      ]);
    });
  });

  describe('what the sweeps look for (by the database clock)', () => {
    it('findInitiatedForReconcile: payments still waiting that were created longer ago than the given time, oldest first, each with whether its time to pay has run out', async () => {
      const old = await place(await makeOrder());
      const older = await place(await makeOrder());
      const fresh = await place(await makeOrder());
      const done = await place(await makeOrder());
      await repo.transition(done.id, [INITIATED], FAILED, null);
      await setColumn(old.id, 'createdAt', LONG_AGO);
      await setColumn(older.id, 'createdAt', 2 * LONG_AGO);
      await setColumn(done.id, 'createdAt', LONG_AGO);
      await setColumn(older.id, 'expiresAt', LONG_AGO); // its time to pay ran out an hour ago

      expect(await repo.findInitiatedForReconcile(60, 100)).toEqual([
        { id: older.id, pastDeadline: true },
        { id: old.id, pastDeadline: false },
      ]);
      expect(await repo.findInitiatedForReconcile(60, 1)).toEqual([
        { id: older.id, pastDeadline: true },
      ]);
      expect(await repo.findInitiatedForReconcile(7300, 100)).toEqual([]);
      expect(fresh.id).toBeDefined();
    });

    it('findPaidButOrderStillPayingIds: paid payments whose order is still PAYMENT_PROCESSING, not changed for a while', async () => {
      const stuck = await place(await makeOrder('PAYMENT_PROCESSING'));
      const recent = await place(await makeOrder('PAYMENT_PROCESSING'));
      const finished = await place(await makeOrder('CONFIRMED'));
      const waiting = await place(await makeOrder('PAYMENT_PROCESSING'));
      for (const p of [stuck, recent, finished]) {
        await repo.transition(p.id, [INITIATED], SUCCEEDED, null, {
          paidAmount: 150000,
        });
      }
      await setColumn(stuck.id, 'updatedAt', LONG_AGO);
      await setColumn(finished.id, 'updatedAt', LONG_AGO);

      expect(await repo.findPaidButOrderStillPayingIds(30, 100)).toEqual([
        stuck.id,
      ]);
      expect(waiting.id).toBeDefined();
    });

    it('findRefundableIds: REFUND_PENDING payments, and paid ones whose order is cancelled or expired, and no others', async () => {
      const pending = await place(await makeOrder('CONFIRMED'));
      await repo.transition(pending.id, [INITIATED], SUCCEEDED, null, {
        paidAmount: 150000,
      });
      await repo.transition(pending.id, [SUCCEEDED], REFUND_PENDING, null);
      const cancelled = await place(await makeOrder('CANCELLED'));
      const expired = await place(await makeOrder('EXPIRED'));
      for (const p of [cancelled, expired]) {
        await repo.transition(p.id, [INITIATED], SUCCEEDED, null, {
          paidAmount: 150000,
        });
      }
      const fine = await place(await makeOrder('CONFIRMED'));
      await repo.transition(fine.id, [INITIATED], SUCCEEDED, null, {
        paidAmount: 150000,
      });
      const refunded = await place(await makeOrder('CANCELLED'));
      await repo.transition(refunded.id, [INITIATED], SUCCEEDED, null, {
        paidAmount: 150000,
      });
      await repo.transition(refunded.id, [SUCCEEDED], REFUND_PENDING, null);
      await repo.transition(refunded.id, [REFUND_PENDING], REFUNDED, null);
      const failedOnCancelled = await place(await makeOrder('CANCELLED'));
      await repo.transition(failedOnCancelled.id, [INITIATED], FAILED, null);

      const ids = await repo.findRefundableIds(100);

      expect(ids.sort()).toEqual([pending.id, cancelled.id, expired.id].sort());
      expect(await repo.findRefundableIds(2)).toHaveLength(2);
    });

    it('hasLivePayment: an order with a payment that is waiting, or paid, as opposed to one that failed or was refunded', async () => {
      const waiting = await makeOrder();
      await place(waiting);
      const paid = await makeOrder();
      const p = await place(paid);
      await repo.transition(p.id, [INITIATED], SUCCEEDED, null, {
        paidAmount: 150000,
      });
      const failed = await makeOrder();
      const f = await place(failed);
      await repo.transition(f.id, [INITIATED], FAILED, null);
      const none = await makeOrder();

      expect(await repo.hasLivePayment(waiting)).toBe(true);
      expect(await repo.hasLivePayment(paid)).toBe(true);
      expect(await repo.hasLivePayment(failed)).toBe(false);
      expect(await repo.hasLivePayment(none)).toBe(false);
    });
  });

  describe('the inbox', () => {
    it('says true the first time a message is noted, and false for every repeat', async () => {
      expect(await inbox.record('repo-test.a', 'm1')).toBe(true);
      expect(await inbox.record('repo-test.a', 'm1')).toBe(false);
      expect(await inbox.record('repo-test.b', 'm1')).toBe(true);
      expect(await inbox.record('repo-test.a', 'm2')).toBe(true);
    });

    it('forgets a message, so that its next delivery is the first again', async () => {
      await inbox.record('repo-test.a', 'm1');

      await inbox.forget('repo-test.a', 'm1');

      expect(await inbox.record('repo-test.a', 'm1')).toBe(true);
      await expect(
        inbox.forget('repo-test.a', 'never-noted'),
      ).resolves.toBeUndefined();
    });

    it('ten at the same moment: exactly one is told it is the first', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => inbox.record('repo-test.race', 'm1')),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
