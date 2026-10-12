import { vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  CancelOrderCommand,
  StartOrderPaymentCommand,
} from '../orders/application/index.js';
import { ReleaseReservationCommand } from '../inventory/application/index.js';
import { PaymentStatus } from './domain/index.js';
import {
  FinishPaidPaymentsCommand,
  ReconcilePendingPaymentsCommand,
  RefundPendingPaymentsCommand,
  ReopenStuckOrdersCommand,
} from './application/index.js';
import {
  buildPaymentFlow,
  type PaymentFlow,
} from './testing/payment-flow.fixture.js';

// The database clock can differ from this machine's by a second or so, so "long ago" is generous
const LONG_AGO = 3_600_000;

/**
 * The safety net (AC-11 to AC-14): what the sweeps and the consumer of order events do when a
 * webhook is lost or a step was cut short. The real catalog, stock, orders and payments (Postgres
 * and Redis), the fake gateway, and the in-memory event bus with the outbox publisher.
 */
describe('The payment sweeps and the consumer of order events (Integration)', () => {
  let f: PaymentFlow;

  beforeAll(async () => {
    f = await buildPaymentFlow();
  }, 60_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await f.reset();
  }, 60_000);
  afterAll(async () => {
    await f.close();
  });

  const ref = (payment: { providerRef: string | null }) => payment.providerRef!;
  const reconcile = () =>
    f.commands.execute<ReconcilePendingPaymentsCommand, number>(
      new ReconcilePendingPaymentsCommand(),
    );
  const finishPaid = () =>
    f.commands.execute<FinishPaidPaymentsCommand, number>(
      new FinishPaidPaymentsCommand(),
    );
  const refundPending = () =>
    f.commands.execute<RefundPendingPaymentsCommand, number>(
      new RefundPendingPaymentsCommand(),
    );
  const reopenStuck = () =>
    f.commands.execute<ReopenStuckOrdersCommand, number>(
      new ReopenStuckOrdersCommand(),
    );
  /** A payment that has been waiting for the gateway for a while. */
  const waiting = async () => {
    const made = await f.paying();
    await f.setPaymentColumn(made.payment.id, 'createdAt', LONG_AGO);
    return made;
  };
  const timeIsUp = (paymentId: string) =>
    f.setPaymentColumn(paymentId, 'expiresAt', LONG_AGO);

  // ── A: a webhook that never came ──────────────────────────────────────────

  describe('asking the gateway about payments that have waited (A, AC-11)', () => {
    it('finds money that came in without a webhook, and applies it as a webhook would: payment SUCCEEDED, order CONFIRMED; nothing more on the next round', async () => {
      const { order, skuId, payment } = await waiting();
      f.gateway.markPaid(ref(payment)); // paid at the gateway; no webhook reached us

      expect(await reconcile()).toBe(1);

      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'SUCCEEDED',
        paidAmount: 150000,
      });
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
      expect(await f.onHand(skuId)).toBe(7);
      expect(await reconcile()).toBe(0);
      expect(await f.onHand(skuId)).toBe(7);
      // It had no message id, so nothing is noted in the inbox
      expect(
        await f.prisma.inboxMessage.count({
          where: { source: 'webhook:fake' },
        }),
      ).toBe(0);
    });

    it('finds a payment that failed: it is FAILED and the order is open again', async () => {
      const { order, payment } = await waiting();
      f.gateway.markFailed(ref(payment));

      expect(await reconcile()).toBe(1);

      expect((await f.paymentOf(payment.id)).status).toBe('FAILED');
      expect((await f.orderOf(order.id)).status).toBe('PENDING');
    });

    it('finds a wrong amount too, and handles it as a webhook would: the money goes back, the order is not confirmed', async () => {
      const { order, payment } = await waiting();
      f.gateway.markPaid(ref(payment), 1000);

      await reconcile();

      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'REFUNDED',
        paidAmount: 1000,
      });
      expect((await f.orderOf(order.id)).status).toBe('PENDING');
      expect(f.gateway.refundCount).toBe(1);
    });

    it('leaves a payment alone while the gateway says it is still pending and its time is not up', async () => {
      const { order, payment } = await waiting();
      const query = vi.spyOn(f.gateway, 'queryCharge');

      expect(await reconcile()).toBe(0);

      expect(query).toHaveBeenCalledTimes(1);
      expect((await f.paymentOf(payment.id)).status).toBe('INITIATED');
      expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
    });

    it('does not even ask about a payment younger than the grace period (a request may still be working on it)', async () => {
      const { payment } = await f.paying();
      const query = vi.spyOn(f.gateway, 'queryCharge');

      expect(await reconcile()).toBe(0);

      expect(query).not.toHaveBeenCalled();
      expect((await f.paymentOf(payment.id)).status).toBe('INITIATED');
    });

    it('when the time to pay is up and the gateway still says pending: the payment EXPIRES, the order expires, the stock goes back, both events are written', async () => {
      const { order, skuId, payment } = await waiting();
      await timeIsUp(payment.id);

      expect(await reconcile()).toBe(1);

      expect((await f.paymentOf(payment.id)).status).toBe('EXPIRED');
      expect((await f.orderOf(order.id)).status).toBe('EXPIRED');
      expect((await f.holds(order.id))[0].status).toBe('RELEASED');
      expect(await f.available(skuId)).toBe(10);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.expired',
      ]);
      expect(await f.orderChanges(order.id)).toEqual([
        'PENDING>PAYMENT_PROCESSING',
        'PAYMENT_PROCESSING>EXPIRED',
      ]);
      expect(await reconcile()).toBe(0);
    });

    it('asks the gateway even when the time is up, so a payment paid at the last moment is not expired on top of paid money', async () => {
      const { order, payment } = await waiting();
      await timeIsUp(payment.id);
      f.gateway.markPaid(ref(payment));

      await reconcile();

      expect((await f.paymentOf(payment.id)).status).toBe('SUCCEEDED');
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
    });

    it('a charge the gateway does not know: left alone while there is time, expired when time is up', async () => {
      const { order, payment } = await waiting();
      f.gateway.reset(); // the gateway has no record of it any more

      expect(await reconcile()).toBe(0);
      expect((await f.paymentOf(payment.id)).status).toBe('INITIATED');

      await timeIsUp(payment.id);
      expect(await reconcile()).toBe(1);
      expect((await f.paymentOf(payment.id)).status).toBe('EXPIRED');
      expect((await f.orderOf(order.id)).status).toBe('EXPIRED');
    });

    it('a payment that never got its charge (the process died before the gateway answered) expires when its time is up, without asking the gateway', async () => {
      const { order } = await f.placed();
      vi.spyOn(f.gateway, 'createCharge').mockRejectedValueOnce(
        new Error('the process died'),
      );
      await expect(f.pay(order.id)).rejects.toThrow('the process died');
      const [left] = await f.payments.listByOrder(order.id);
      expect(left.providerRef).toBeNull();
      await f.setPaymentColumn(left.id, 'createdAt', LONG_AGO);
      const query = vi.spyOn(f.gateway, 'queryCharge');

      expect(await reconcile()).toBe(0); // time is not up yet
      await timeIsUp(left.id);
      expect(await reconcile()).toBe(1);

      expect(query).not.toHaveBeenCalled();
      expect((await f.paymentOf(left.id)).status).toBe('EXPIRED');
      expect((await f.orderOf(order.id)).status).toBe('EXPIRED');
    });

    it('a gateway that cannot be reached leaves the payment for the next round, and one payment failing does not stop the others', async () => {
      const first = await waiting();
      const second = await waiting();
      f.gateway.markPaid(ref(first.payment));
      f.gateway.markPaid(ref(second.payment));
      f.gateway.failNext('queryCharge'); // the first question fails

      expect(await reconcile()).toBe(1);

      const statuses = [
        (await f.paymentOf(first.payment.id)).status,
        (await f.paymentOf(second.payment.id)).status,
      ];
      expect(statuses.sort()).toEqual(
        [PaymentStatus.INITIATED, PaymentStatus.SUCCEEDED].sort(),
      );
      expect(await reconcile()).toBe(1); // the next round gets the other one
      expect((await f.paymentOf(first.payment.id)).status).toBe('SUCCEEDED');
      expect((await f.paymentOf(second.payment.id)).status).toBe('SUCCEEDED');
    });

    it('does not touch payments that are not waiting any more', async () => {
      const { payment } = await waiting();
      f.gateway.markPaid(ref(payment));
      await f.apply(ref(payment), 'PAID', 150000);
      const query = vi.spyOn(f.gateway, 'queryCharge');

      expect(await reconcile()).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });
  });

  // ── B: a confirmation that was cut short ─────────────────────────────────

  describe('finishing paid payments whose order is still waiting (B, AC-12)', () => {
    const paidButNotConfirmed = async () => {
      const made = await f.paying();
      const real = f.commands.execute.bind(f.commands);
      vi.spyOn(f.commands, 'execute').mockImplementation((command: any) =>
        command.constructor.name === 'ConfirmOrderCommand'
          ? Promise.reject(new Error('Postgres down'))
          : real(command),
      );
      await f.apply(ref(made.payment), 'PAID', 150000);
      vi.restoreAllMocks();
      expect((await f.orderOf(made.order.id)).status).toBe(
        'PAYMENT_PROCESSING',
      );
      return made;
    };

    it('confirms the order once it has waited long enough (the stock is taken out once); not before', async () => {
      const { order, skuId, payment } = await paidButNotConfirmed();

      expect(await finishPaid()).toBe(0); // too fresh: the request that did it may still be working
      expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');

      await f.setPaymentColumn(payment.id, 'updatedAt', LONG_AGO);
      expect(await finishPaid()).toBe(1);

      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
      expect(await f.onHand(skuId)).toBe(7);
      expect(await finishPaid()).toBe(0);
      expect(await f.onHand(skuId)).toBe(7);
    });

    it('when the held stock was lost meanwhile, the order expires and the money goes back instead', async () => {
      const { order, payment } = await paidButNotConfirmed();
      await f.commands.execute(new ReleaseReservationCommand(order.id));
      await f.setPaymentColumn(payment.id, 'updatedAt', LONG_AGO);

      await finishPaid();

      expect((await f.orderOf(order.id)).status).toBe('EXPIRED');
      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
    });

    it('leaves alone a paid payment whose order is already confirmed', async () => {
      const { payment } = await f.paying();
      await f.apply(ref(payment), 'PAID', 150000);
      await f.setPaymentColumn(payment.id, 'updatedAt', LONG_AGO);

      expect(await finishPaid()).toBe(0);
    });
  });

  // ── C: money that has to go back ─────────────────────────────────────────

  describe('sending back money that has to go back (C, AC-13)', () => {
    it('sends a refund that could not be sent before, once', async () => {
      const { order, payment } = await f.paying();
      await f.commands.execute(new ReleaseReservationCommand(order.id));
      f.gateway.failNext('refund');
      await f.apply(ref(payment), 'PAID', 150000);
      expect((await f.paymentOf(payment.id)).status).toBe('REFUND_PENDING');

      expect(await refundPending()).toBe(1);

      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(f.gateway.refundCount).toBe(1);
      expect(await refundPending()).toBe(0);
      expect(f.gateway.refundCount).toBe(1);
    });

    it('refunds a paid payment whose order was cancelled, when no event told us', async () => {
      const { order, skuId, payment } = await f.paying();
      await f.apply(ref(payment), 'PAID', 150000);
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );
      expect((await f.paymentOf(payment.id)).status).toBe('SUCCEEDED'); // nobody refunded it yet

      expect(await refundPending()).toBe(1);

      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect((await f.orderOf(order.id)).status).toBe('CANCELLED');
      expect(await f.onHand(skuId)).toBe(10);
      expect(f.gateway.refundCount).toBe(1);
    });

    it('never touches a paid payment of an order that is alive', async () => {
      const { payment } = await f.paying();
      await f.apply(ref(payment), 'PAID', 150000);

      expect(await refundPending()).toBe(0);

      expect((await f.paymentOf(payment.id)).status).toBe('SUCCEEDED');
      expect(f.gateway.refundCount).toBe(0);
    });

    it('a gateway that is down leaves the money waiting, and a later round sends it', async () => {
      const { order, payment } = await f.paying();
      await f.apply(ref(payment), 'PAID', 150000);
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );
      f.gateway.setUnavailable(true);

      expect(await refundPending()).toBe(0);
      expect((await f.paymentOf(payment.id)).status).toBe('REFUND_PENDING');

      f.gateway.setUnavailable(false);
      expect(await refundPending()).toBe(1);
      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(f.gateway.refundCount).toBe(1);
    });
  });

  // ── D: an order with no payment behind it ────────────────────────────────

  describe('opening orders that are stuck (D, AC-12)', () => {
    const stuckOrder = async () => {
      const { order } = await f.placed();
      await f.commands.execute(
        new StartOrderPaymentCommand(
          order.id,
          new Date(Date.now() + 15 * 60_000),
        ),
      );
      await f.prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`,
        order.id,
      );
      return order;
    };

    it('opens an order that has been PAYMENT_PROCESSING for a while with no payment at all', async () => {
      const order = await stuckOrder();

      expect(await reopenStuck()).toBe(1);

      expect((await f.orderOf(order.id)).status).toBe('PENDING');
      expect(await reopenStuck()).toBe(0);
    });

    it('does not touch an order that is young, or one with a payment that is waiting or paid', async () => {
      const { order: young } = await f.placed();
      await f.commands.execute(
        new StartOrderPaymentCommand(young.id, new Date(Date.now() + 900_000)),
      );
      const withWaiting = await waiting();
      await f.prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`,
        withWaiting.order.id,
      );
      const withPaid = await f.paying();
      await f.payments.transition(
        withPaid.payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.SUCCEEDED,
        null,
        { paidAmount: 150000 },
      );
      await f.prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`,
        withPaid.order.id,
      );

      expect(await reopenStuck()).toBe(0);

      expect((await f.orderOf(young.id)).status).toBe('PAYMENT_PROCESSING');
      expect((await f.orderOf(withWaiting.order.id)).status).toBe(
        'PAYMENT_PROCESSING',
      );
      expect((await f.orderOf(withPaid.order.id)).status).toBe(
        'PAYMENT_PROCESSING',
      );
    });

    it('opens an order whose only payment failed but whose reopening never happened', async () => {
      const made = await f.paying();
      await f.payments.transition(
        made.payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.FAILED,
        null,
      );
      await f.prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`,
        made.order.id,
      );

      expect(await reopenStuck()).toBe(1);

      expect((await f.orderOf(made.order.id)).status).toBe('PENDING');
    });
  });

  // ── the round, as the application runs it ────────────────────────────────

  describe('the maintenance round', () => {
    it('does all four sweeps in one round, and a second round finds nothing left to do', async () => {
      const lost = await waiting();
      f.gateway.markPaid(ref(lost.payment)); // A: a webhook that never came
      const refundable = await f.paying();
      f.gateway.failNext('refund');
      await f.commands.execute(
        new ReleaseReservationCommand(refundable.order.id),
      );
      await f.apply(ref(refundable.payment), 'PAID', 150000); // C: a refund that could not be sent
      const { order: stuck } = await f.placed();
      await f.commands.execute(
        new StartOrderPaymentCommand(stuck.id, new Date(Date.now() + 900_000)),
      );
      await f.prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = $1`,
        stuck.id,
      ); // D

      await f.maintenance.runOnce();

      expect((await f.orderOf(lost.order.id)).status).toBe('CONFIRMED');
      expect((await f.paymentOf(refundable.payment.id)).status).toBe(
        'REFUNDED',
      );
      expect((await f.orderOf(stuck.id)).status).toBe('PENDING');
      const before = await f.prisma.outboxEvent.count();
      await f.maintenance.runOnce();
      expect(await f.prisma.outboxEvent.count()).toBe(before);
      expect(f.gateway.refundCount).toBe(1);
    });

    it('two rounds at the same moment: one works and the other skips, nothing is done twice', async () => {
      const lost = await waiting();
      f.gateway.markPaid(ref(lost.payment));

      await Promise.all([f.maintenance.runOnce(), f.maintenance.runOnce()]);

      expect((await f.orderOf(lost.order.id)).status).toBe('CONFIRMED');
      expect(await f.paymentEventTypes(lost.payment.id)).toEqual([
        'payment.succeeded',
      ]);
    });

    it('keeps going when one sweep fails: the others still run, and it never throws', async () => {
      const lost = await waiting();
      f.gateway.markPaid(ref(lost.payment));
      vi.spyOn(f.payments, 'findInitiatedForReconcile').mockRejectedValueOnce(
        new Error('Postgres hiccup'),
      );
      const { order, payment } = await f.paying();
      await f.commands.execute(new ReleaseReservationCommand(order.id));
      f.gateway.failNext('refund');
      await f.apply(ref(payment), 'PAID', 150000);

      await expect(f.maintenance.runOnce()).resolves.toBeUndefined();

      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED'); // sweep C ran although A failed
      expect((await f.orderOf(lost.order.id)).status).toBe(
        'PAYMENT_PROCESSING',
      ); // A will do it next round
    });
  });

  // ── the consumer of order events ─────────────────────────────────────────

  describe('the consumer of order events (AC-13, AC-14)', () => {
    const paidAndConfirmed = async () => {
      const made = await f.paying();
      await f.apply(ref(made.payment), 'PAID', 150000);
      expect((await f.orderOf(made.order.id)).status).toBe('CONFIRMED');
      return made;
    };
    const cancelEvents = () =>
      f.bus.published.filter(
        (e) =>
          e.name === 'order.status_changed' &&
          (e.data as any).to === 'CANCELLED',
      );
    const noted = () =>
      f.prisma.inboxMessage.count({
        where: { source: 'payments.order-events' },
      });

    it('refunds the money when a paid order is cancelled, once the event reaches it: the order is cancelled, the stock is back, the payment REFUNDED', async () => {
      const { order, skuId, payment } = await paidAndConfirmed();

      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );
      await f.publishOutbox();

      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(f.gateway.refundCount).toBe(1);
      expect((await f.orderOf(order.id)).status).toBe('CANCELLED');
      expect(await f.onHand(skuId)).toBe(10);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.succeeded',
        'payment.refunded',
      ]);
      expect(await noted()).toBe(1);
    });

    it('the same event delivered again refunds nothing more', async () => {
      const { order } = await paidAndConfirmed();
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );
      await f.publishOutbox();
      const [event] = cancelEvents();

      await f.bus.publish(event);
      await f.bus.publish(event);

      expect(f.gateway.refundCount).toBe(1);
      expect(await noted()).toBe(1);
    });

    it('ignores every other change of an order: nothing is refunded and nothing is noted', async () => {
      const { order } = await paidAndConfirmed();
      const { payment } = await f.paying();
      await f.publishOutbox(); // order.created, PENDING>PAYMENT_PROCESSING, PAYMENT_PROCESSING>CONFIRMED ...

      expect(f.gateway.refundCount).toBe(0);
      expect(await noted()).toBe(0);
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
      expect(payment.id).toBeDefined();
    });

    it('does nothing for a cancelled order that was never paid online (cash on delivery, or no payment)', async () => {
      const { order } = await f.placed();
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );
      const cod = (await f.placed('COD' as never)).order;
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', cod.id),
      );
      await f.publishOutbox();

      expect(f.gateway.refundCount).toBe(0);
    });

    it('ignores an event whose data is not what it expects, without failing', async () => {
      for (const data of [
        null,
        'text',
        42,
        {},
        { orderId: 5, from: 'CONFIRMED', to: 'CANCELLED' },
        { orderId: '', from: 'CONFIRMED', to: 'CANCELLED' },
      ]) {
        await f.bus.publish({
          id: randomUUID(),
          name: 'order.status_changed',
          occurredAt: new Date(),
          data,
        });
      }

      expect(await noted()).toBe(0);
      expect(f.gateway.refundCount).toBe(0);
    });

    it('when the refund fails in a way that is not the gateway being down, the note is taken back and the sweep refunds it instead', async () => {
      const { order, payment } = await paidAndConfirmed();
      vi.spyOn(f.gateway, 'refund').mockRejectedValueOnce(
        new Error('a bug in the adapter'),
      );
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );

      await f.publishOutbox();

      expect(await noted()).toBe(0); // so a redelivery would be handled
      expect((await f.paymentOf(payment.id)).status).toBe('REFUND_PENDING');

      await f.maintenance.runOnce();

      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(f.gateway.refundCount).toBe(1);
    });

    it('when the gateway is down the payment waits as REFUND_PENDING (the event is handled, the sweep sends the money)', async () => {
      const { order, payment } = await paidAndConfirmed();
      f.gateway.setUnavailable(true);
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );

      await f.publishOutbox();

      expect((await f.paymentOf(payment.id)).status).toBe('REFUND_PENDING');
      f.gateway.setUnavailable(false);
      await f.maintenance.runOnce();
      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(f.gateway.refundCount).toBe(1);
    });

    it('does not depend on the event at all: with no event the sweep refunds the cancelled order just the same', async () => {
      const { order, payment } = await paidAndConfirmed();
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );
      // no publishOutbox: the event is lost

      await f.maintenance.runOnce();

      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(f.gateway.refundCount).toBe(1);
    });

    it('the event and the sweep together refund once', async () => {
      const { order, payment } = await paidAndConfirmed();
      await f.commands.execute(
        new CancelOrderCommand('payflow_user_1', order.id),
      );

      await Promise.all([f.publishOutbox(), f.maintenance.runOnce()]);

      expect((await f.paymentOf(payment.id)).status).toBe('REFUNDED');
      expect(f.gateway.refundCount).toBe(1);
      expect(
        (await f.paymentEventTypes(payment.id)).filter(
          (t) => t === 'payment.refunded',
        ),
      ).toHaveLength(1);
    });
  });
});
