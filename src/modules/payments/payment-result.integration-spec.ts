import { vi } from 'vitest';
import {
  ExpireOrderCommand,
  ReopenOrderCommand,
} from '../orders/application/index.js';
import { ReleaseReservationCommand } from '../inventory/application/index.js';
import { PaymentStatus, paymentFailedEvent } from './domain/index.js';
import {
  ApplyPaymentResultCommand,
  FinishPaidPaymentCommand,
  RefundPaymentCommand,
  type FinishPaidResult,
  type RefundResult,
} from './application/index.js';
import {
  buildPaymentFlow,
  type PaymentFlow,
} from './testing/payment-flow.fixture.js';

/**
 * What happens when the gateway says how a payment went (AC-6 to AC-10), with the real catalog,
 * stock, orders and payments and the fake gateway, through the command bus.
 */
describe('Results from the gateway (Integration)', () => {
  let f: PaymentFlow;

  beforeAll(async () => {
    f = await buildPaymentFlow();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await f.reset();
  });
  afterAll(async () => {
    await f.close();
  });

  const refTo = (payment: { providerRef: string | null }) =>
    payment.providerRef!;

  // ── AC-6: paid ────────────────────────────────────────────────────────────

  describe('the money came in (AC-6)', () => {
    it('confirms the order: stock taken out of the warehouse, payment SUCCEEDED, both events written', async () => {
      const { order, skuId, payment } = await f.paying();

      const result = await f.apply(refTo(payment), 'PAID', 150000);

      expect(result).toBe('APPLIED');
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'SUCCEEDED',
        paidAmount: 150000,
        version: 2,
      });
      expect(await f.orderOf(order.id)).toMatchObject({
        status: 'CONFIRMED',
        version: 3,
      });
      expect((await f.holds(order.id))[0].status).toBe('CONFIRMED');
      expect(await f.onHand(skuId)).toBe(7);
      expect(await f.available(skuId)).toBe(7);
      expect(await f.orderChanges(order.id)).toEqual([
        'PENDING>PAYMENT_PROCESSING',
        'PAYMENT_PROCESSING>CONFIRMED',
      ]);
      const events = await f.eventsOf(payment.id);
      expect(events.map((e) => e.type)).toEqual(['payment.succeeded']);
      expect(events[0].payload).toEqual({
        paymentId: payment.id,
        orderId: order.id,
        amount: 150000,
      });
      expect(f.gateway.refundCount).toBe(0);
    });

    it('does not touch the gateway again, and writes the event of the order and of the payment once each', async () => {
      const { payment } = await f.paying();

      await f.apply(refTo(payment), 'PAID', 150000);

      expect(f.gateway.chargeCount).toBe(1);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.succeeded',
      ]);
    });
  });

  // ── AC-7: a wrong amount, a charge that is not ours ──────────────────────

  describe('the wrong amount, and a charge we do not know (AC-7)', () => {
    it.each([
      ['less than the order costs', 1000],
      ['more than the order costs', 200000],
    ])(
      '%s: the order is NOT confirmed, the money that really came in goes back, and the order is open again',
      async (_, collected) => {
        const { order, skuId, payment } = await f.paying();
        const refund = vi.spyOn(f.gateway, 'refund');

        const result = await f.apply(refTo(payment), 'PAID', collected);

        expect(result).toBe('APPLIED');
        expect(await f.paymentOf(payment.id)).toMatchObject({
          status: 'REFUNDED',
          amount: 150000,
          paidAmount: collected,
        });
        expect(refund).toHaveBeenCalledTimes(1);
        expect(refund).toHaveBeenCalledWith({
          paymentId: payment.id,
          providerRef: refTo(payment),
          amount: collected,
        });
        expect(await f.orderOf(order.id)).toMatchObject({ status: 'PENDING' });
        expect((await f.holds(order.id))[0].status).toBe('RESERVED'); // nothing was taken out
        expect(await f.onHand(skuId)).toBe(10);
        expect(await f.paymentEventTypes(payment.id)).toEqual([
          'payment.succeeded',
          'payment.refunded',
        ]);
        const events = await f.eventsOf(payment.id);
        expect(events.map((e) => (e.payload as any).amount)).toEqual([
          collected,
          collected,
        ]);
        expect(f.gateway.refundCount).toBe(1);
      },
    );

    it('the same wrong-amount webhook again (same id): handled once; another with a new id: nothing changes; one refund', async () => {
      const { payment } = await f.paying();

      const first = await f.apply(refTo(payment), 'PAID', 1000, 'evt-wrong-1');
      const sameId = await f.apply(refTo(payment), 'PAID', 1000, 'evt-wrong-1');
      const newId = await f.apply(refTo(payment), 'PAID', 1000, 'evt-wrong-2');

      expect([first, sameId, newId]).toEqual([
        'APPLIED',
        'DUPLICATE',
        'IGNORED',
      ]);
      expect(f.gateway.refundCount).toBe(1);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.succeeded',
        'payment.refunded',
      ]);
    });

    it('the customer can try again after a wrong amount, with a new key, up to the limit', async () => {
      const { order, payment } = await f.paying();
      await f.apply(refTo(payment), 'PAID', 1000);

      const again = await f.pay(order.id, 'pay-attempt-0002');

      expect(again.payment.status).toBe('INITIATED');
      expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
    });

    it('a report about a charge that is not ours is answered as received and changes nothing', async () => {
      const { order, payment } = await f.paying();

      const result = await f.apply('fake_not-ours', 'PAID', 150000);

      expect(result).toBe('UNKNOWN_PAYMENT');
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'INITIATED',
      });
      expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
    });

    it('a report of a payment for an amount of nothing is ignored (a refund of nothing means nothing)', async () => {
      const { payment } = await f.paying();

      expect(await f.apply(refTo(payment), 'PAID', 0)).toBe('IGNORED');
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'INITIATED',
      });
    });
  });

  // ── AC-8: repeats and the wrong order ─────────────────────────────────────

  describe('the same news twice, or in the wrong order (AC-8)', () => {
    it('the same webhook three times: the order is confirmed once, the stock is taken out once, one event', async () => {
      const { order, skuId, payment } = await f.paying();

      const results = [
        await f.apply(refTo(payment), 'PAID', 150000, 'evt-1'),
        await f.apply(refTo(payment), 'PAID', 150000, 'evt-1'),
        await f.apply(refTo(payment), 'PAID', 150000, 'evt-1'),
      ];

      expect(results).toEqual(['APPLIED', 'DUPLICATE', 'DUPLICATE']);
      expect(await f.orderOf(order.id)).toMatchObject({
        status: 'CONFIRMED',
        version: 3,
      });
      expect(await f.onHand(skuId)).toBe(7);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.succeeded',
      ]);
    });

    it('the same webhook three times at the same moment: exactly one is applied', async () => {
      const { order, skuId, payment } = await f.paying();

      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          f.apply(refTo(payment), 'PAID', 150000, 'evt-same'),
        ),
      );

      expect(results.filter((r) => r === 'APPLIED')).toHaveLength(1);
      expect(results.filter((r) => r === 'DUPLICATE')).toHaveLength(2);
      expect(await f.orderOf(order.id)).toMatchObject({
        status: 'CONFIRMED',
        version: 3,
      });
      expect(await f.onHand(skuId)).toBe(7);
    });

    it('five webhooks at the same moment with DIFFERENT ids (the gateway sent it again under new ids): one is applied, the rest change nothing', async () => {
      const { order, skuId, payment } = await f.paying();

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          f.apply(refTo(payment), 'PAID', 150000, `evt-new-${i}`),
        ),
      );

      expect(results.filter((r) => r === 'APPLIED')).toHaveLength(1);
      expect(results.filter((r) => r === 'IGNORED')).toHaveLength(4);
      expect(await f.orderOf(order.id)).toMatchObject({
        status: 'CONFIRMED',
        version: 3,
      });
      expect(await f.onHand(skuId)).toBe(7);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.succeeded',
      ]);
      expect(f.gateway.refundCount).toBe(0);
    });

    it('a failure reported AFTER the money came in changes nothing: payment SUCCEEDED, order CONFIRMED', async () => {
      const { order, payment } = await f.paying();
      await f.apply(refTo(payment), 'PAID', 150000);

      const late = await f.apply(refTo(payment), 'FAILED', 150000);

      expect(late).toBe('IGNORED');
      expect((await f.paymentOf(payment.id)).status).toBe('SUCCEEDED');
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
    });

    it('money that turns up after a failure was reported: the payment becomes SUCCEEDED, and because the order was opened again the money goes back', async () => {
      const { order, payment } = await f.paying();
      await f.apply(refTo(payment), 'FAILED', 150000);
      expect((await f.orderOf(order.id)).status).toBe('PENDING');

      const late = await f.apply(refTo(payment), 'PAID', 150000);

      expect(late).toBe('APPLIED');
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'REFUNDED',
        paidAmount: 150000,
      });
      expect((await f.orderOf(order.id)).status).toBe('PENDING');
      expect(f.gateway.refundCount).toBe(1);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.failed',
        'payment.succeeded',
        'payment.refunded',
      ]);
    });

    it('money that turns up after the payment was expired and the order too: it goes back, the order stays expired', async () => {
      const { order, skuId, payment } = await f.paying();
      await f.payments.transition(
        payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.EXPIRED,
        null,
      );
      await f.commands.execute(new ExpireOrderCommand(order.id));

      await f.apply(refTo(payment), 'PAID', 150000);

      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'REFUNDED',
      });
      expect((await f.orderOf(order.id)).status).toBe('EXPIRED');
      expect(await f.onHand(skuId)).toBe(10);
      expect(f.gateway.refundCount).toBe(1);
    });
  });

  // ── AC-9: failed ──────────────────────────────────────────────────────────

  describe('the payment failed (AC-9)', () => {
    it('opens the order again, with its stock still held, and writes the event', async () => {
      const { order, skuId, payment } = await f.paying();

      const result = await f.apply(refTo(payment), 'FAILED', 150000);

      expect(result).toBe('APPLIED');
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'FAILED',
        paidAmount: null,
      });
      expect(await f.orderOf(order.id)).toMatchObject({ status: 'PENDING' });
      expect((await f.holds(order.id))[0].status).toBe('RESERVED');
      expect(await f.available(skuId)).toBe(7);
      expect(await f.paymentEventTypes(payment.id)).toEqual(['payment.failed']);
      expect(await f.orderChanges(order.id)).toEqual([
        'PENDING>PAYMENT_PROCESSING',
        'PAYMENT_PROCESSING>PENDING',
      ]);
    });

    it('the customer can then pay again with a new key, three attempts in all, and the fourth is refused', async () => {
      const { order, payment } = await f.paying();
      await f.apply(refTo(payment), 'FAILED', 150000);

      for (const key of ['pay-attempt-0002', 'pay-attempt-0003']) {
        const next = await f.pay(order.id, key);
        expect(next.payment.status).toBe('INITIATED');
        await f.apply(refTo(next.payment), 'FAILED', 150000);
      }

      expect(await f.failureOf(f.pay(order.id, 'pay-attempt-0004'))).toBe(
        'PAY-004',
      );
      expect(await f.payments.countByOrder(order.id)).toBe(3);
    });

    it('a failure reported twice opens the order once', async () => {
      const { order, payment } = await f.paying();

      const results = [
        await f.apply(refTo(payment), 'FAILED', 150000, 'evt-f'),
        await f.apply(refTo(payment), 'FAILED', 150000, 'evt-f'),
        await f.apply(refTo(payment), 'FAILED', 150000, 'evt-f2'),
      ];

      expect(results).toEqual(['APPLIED', 'DUPLICATE', 'IGNORED']);
      expect((await f.orderOf(order.id)).version).toBe(3);
      expect(await f.paymentEventTypes(payment.id)).toEqual(['payment.failed']);
    });

    it('a failure of an old attempt does not disturb the attempt that is running now', async () => {
      const { order, payment: first } = await f.paying();
      await f.apply(refTo(first), 'FAILED', 150000);
      const second = (await f.pay(order.id, 'pay-attempt-0002')).payment;

      const late = await f.apply(refTo(first), 'FAILED', 150000, 'evt-late');

      expect(late).toBe('IGNORED');
      expect((await f.paymentOf(second.id)).status).toBe('INITIATED');
      expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
    });
  });

  // ── AC-10: paid, but the order cannot be confirmed ────────────────────────

  describe('money came in but the order cannot be delivered (AC-10)', () => {
    it('the held stock was already given back: the order expires, the money goes back, the customer loses nothing', async () => {
      const { order, skuId, payment } = await f.paying();
      await f.commands.execute(new ReleaseReservationCommand(order.id));

      await f.apply(refTo(payment), 'PAID', 150000);

      expect(await f.orderOf(order.id)).toMatchObject({ status: 'EXPIRED' });
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'REFUNDED',
        paidAmount: 150000,
      });
      expect(await f.onHand(skuId)).toBe(10);
      expect(await f.available(skuId)).toBe(10);
      expect(f.gateway.refundCount).toBe(1);
      expect(await f.orderChanges(order.id)).toEqual([
        'PENDING>PAYMENT_PROCESSING',
        'PAYMENT_PROCESSING>EXPIRED',
      ]);
      expect(await f.paymentEventTypes(payment.id)).toEqual([
        'payment.succeeded',
        'payment.refunded',
      ]);
    });

    it('a second payment for an order that another payment already confirmed goes back; the order stays confirmed, the stock is out once', async () => {
      const { order, skuId, payment: first } = await f.paying();
      await f.apply(refTo(first), 'FAILED', 150000); // the first attempt is reported failed
      const second = (await f.pay(order.id, 'pay-attempt-0002')).payment;
      await f.apply(refTo(second), 'PAID', 150000); // the second one pays and confirms
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');

      await f.apply(refTo(first), 'PAID', 150000, 'evt-first-late'); // and then the first one turns out to have been paid too

      expect(await f.paymentOf(first.id)).toMatchObject({ status: 'REFUNDED' });
      expect(await f.paymentOf(second.id)).toMatchObject({
        status: 'SUCCEEDED',
      });
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
      expect(await f.onHand(skuId)).toBe(7);
      expect(f.gateway.refundCount).toBe(1);
    });

    it('when the refund cannot be done now the payment waits as REFUND_PENDING, and a later try sends it once', async () => {
      const { order, skuId, payment } = await f.paying();
      await f.commands.execute(new ReleaseReservationCommand(order.id));
      f.gateway.failNext('refund');

      await f.apply(refTo(payment), 'PAID', 150000);

      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'REFUND_PENDING',
      });
      expect(f.gateway.refundCount).toBe(0);
      expect(await f.onHand(skuId)).toBe(10);

      const again = await f.commands.execute<
        RefundPaymentCommand,
        RefundResult
      >(new RefundPaymentCommand(payment.id));

      expect(again).toEqual({ kind: 'REFUNDED' });
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'REFUNDED',
      });
      expect(f.gateway.refundCount).toBe(1);
    });
  });

  // ── when something fails in the middle ───────────────────────────────────

  describe('when something fails in the middle', () => {
    it('the order cannot be confirmed right now: the payment is still recorded as paid, the webhook is answered as handled, and finishing later confirms the order once', async () => {
      const { order, skuId, payment } = await f.paying();
      const real = f.commands.execute.bind(f.commands);
      vi.spyOn(f.commands, 'execute').mockImplementation((command: any) =>
        command.constructor.name === 'ConfirmOrderCommand'
          ? Promise.reject(new Error('Postgres down'))
          : real(command),
      );

      const result = await f.apply(refTo(payment), 'PAID', 150000);
      vi.restoreAllMocks();

      expect(result).toBe('APPLIED');
      expect((await f.paymentOf(payment.id)).status).toBe('SUCCEEDED');
      expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
      expect(await f.onHand(skuId)).toBe(10);
      // The gateway sends it again: nothing changes (the payment is already paid), finishing is the sweep's job
      expect(await f.apply(refTo(payment), 'PAID', 150000, 'evt-again')).toBe(
        'IGNORED',
      );
      expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');

      const finished = await f.commands.execute<
        FinishPaidPaymentCommand,
        FinishPaidResult
      >(new FinishPaidPaymentCommand(payment.id));

      expect(finished).toEqual({ kind: 'CONFIRMED' });
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
      expect(await f.onHand(skuId)).toBe(7);
    });

    it('the payment cannot be recorded: the webhook fails so the gateway sends it again, and the second delivery is handled (the note in the inbox was taken back)', async () => {
      const { order, payment } = await f.paying();
      vi.spyOn(f.payments, 'transition').mockRejectedValueOnce(
        new Error('connection lost'),
      );

      await expect(
        f.apply(refTo(payment), 'PAID', 150000, 'evt-retry'),
      ).rejects.toThrow('connection lost');

      expect(
        await f.prisma.inboxMessage.count({
          where: { source: 'webhook:fake', messageId: 'evt-retry' },
        }),
      ).toBe(0);
      expect((await f.paymentOf(payment.id)).status).toBe('INITIATED');
      const retry = await f.apply(refTo(payment), 'PAID', 150000, 'evt-retry');
      expect(retry).toBe('APPLIED');
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
    });

    it('a message that was handled stays in the inbox, so the next one with its id is a duplicate', async () => {
      const { payment } = await f.paying();
      await f.apply(refTo(payment), 'PAID', 150000, 'evt-kept');

      expect(
        await f.prisma.inboxMessage.count({
          where: { source: 'webhook:fake', messageId: 'evt-kept' },
        }),
      ).toBe(1);
    });

    it('a report from a sweep that asked the gateway itself (no message id) is applied the same way and leaves nothing in the inbox', async () => {
      const { order, payment } = await f.paying();

      const result = await f.commands.execute(
        new ApplyPaymentResultCommand('fake', refTo(payment), 'PAID', 150000),
      );

      expect(result).toBe('APPLIED');
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
      expect(
        await f.prisma.inboxMessage.count({
          where: { source: 'webhook:fake' },
        }),
      ).toBe(0);
    });
  });

  // ── finishing and refunding by themselves ────────────────────────────────

  describe('finishing a paid payment', () => {
    it('does nothing for a payment that is not paid, or does not exist', async () => {
      const { payment } = await f.paying();

      for (const id of [payment.id, 'no-such-payment']) {
        expect(
          await f.commands.execute(new FinishPaidPaymentCommand(id)),
        ).toEqual({ kind: 'NOTHING_TO_DO' });
      }
      expect((await f.orderOf(payment.orderId)).status).toBe(
        'PAYMENT_PROCESSING',
      );
    });

    it('does nothing more when it is repeated after the order was confirmed', async () => {
      const { order, skuId, payment } = await f.paying();
      await f.apply(refTo(payment), 'PAID', 150000);

      const again = await f.commands.execute(
        new FinishPaidPaymentCommand(payment.id),
      );

      expect(again).toEqual({ kind: 'NOTHING_TO_DO' });
      expect((await f.orderOf(order.id)).version).toBe(3);
      expect(await f.onHand(skuId)).toBe(7);
    });

    it('ten at the same moment confirm the order once', async () => {
      const { order, skuId, payment } = await f.paying();
      await f.payments.transition(
        payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.SUCCEEDED,
        null,
        { paidAmount: 150000 },
      );

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          f.commands.execute<FinishPaidPaymentCommand, FinishPaidResult>(
            new FinishPaidPaymentCommand(payment.id),
          ),
        ),
      );

      expect(
        results.every(
          (r) => r.kind === 'CONFIRMED' || r.kind === 'NOTHING_TO_DO',
        ),
      ).toBe(true);
      expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
      expect(await f.onHand(skuId)).toBe(7);
      expect(f.gateway.refundCount).toBe(0);
    });
  });

  describe('refunding', () => {
    const paidAndClosed = async () => {
      const { order, skuId, payment } = await f.paying();
      await f.apply(refTo(payment), 'PAID', 150000);
      return { order, skuId, payment };
    };

    it('sends what was collected back, marks the payment REFUNDED and writes the event', async () => {
      const { payment } = await f.paying();
      f.gateway.markPaid(refTo(payment), 90000); // the gateway took the money
      await f.payments.transition(
        payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.SUCCEEDED,
        null,
        { paidAmount: 90000 },
      );
      await f.payments.transition(
        payment.id,
        [PaymentStatus.SUCCEEDED],
        PaymentStatus.REFUND_PENDING,
        null,
      );

      const result = await f.commands.execute(
        new RefundPaymentCommand(payment.id),
      );

      expect(result).toEqual({ kind: 'REFUNDED' });
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'REFUNDED',
      });
      expect((await f.eventsOf(payment.id)).pop()!.payload).toMatchObject({
        amount: 90000,
      });
    });

    it('ten at the same moment refund once: one charge back at the gateway, one event', async () => {
      const { payment } = await f.paying();
      f.gateway.markPaid(refTo(payment), 150000); // the gateway took the money
      await f.payments.transition(
        payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.SUCCEEDED,
        null,
        { paidAmount: 150000 },
      );
      await f.payments.transition(
        payment.id,
        [PaymentStatus.SUCCEEDED],
        PaymentStatus.REFUND_PENDING,
        null,
      );

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          f.commands.execute<RefundPaymentCommand, RefundResult>(
            new RefundPaymentCommand(payment.id),
          ),
        ),
      );

      expect(results.every((r) => r.kind === 'REFUNDED')).toBe(true);
      expect(f.gateway.refundCount).toBe(1);
      expect(
        (await f.paymentEventTypes(payment.id)).filter(
          (t) => t === 'payment.refunded',
        ),
      ).toHaveLength(1);
    });

    it('a repeat after it is done answers REFUNDED and sends nothing more', async () => {
      const { payment } = await f.paying();
      f.gateway.markPaid(refTo(payment), 150000); // the gateway took the money
      await f.payments.transition(
        payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.SUCCEEDED,
        null,
        { paidAmount: 150000 },
      );
      await f.commands.execute(
        new RefundPaymentCommand(payment.id, { markFirst: true }),
      );

      const again = await f.commands.execute(
        new RefundPaymentCommand(payment.id, { markFirst: true }),
      );

      expect(again).toEqual({ kind: 'REFUNDED' });
      expect(f.gateway.refundCount).toBe(1);
    });

    it('refuses to refund a payment that is only SUCCEEDED unless told the order is closed (markFirst)', async () => {
      const { payment } = await paidAndClosed();

      expect(
        await f.commands.execute(new RefundPaymentCommand(payment.id)),
      ).toEqual({ kind: 'NOTHING_TO_DO' });
      expect(await f.paymentOf(payment.id)).toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(f.gateway.refundCount).toBe(0);
    });

    it('does nothing for a payment that was never paid, and for one that does not exist', async () => {
      const { payment } = await f.paying();

      for (const id of [payment.id, 'nothing']) {
        expect(
          await f.commands.execute(
            new RefundPaymentCommand(id, { markFirst: true }),
          ),
        ).toEqual({ kind: 'NOTHING_TO_DO' });
      }
      expect(f.gateway.refundCount).toBe(0);
    });

    it('a gateway that is down leaves the payment REFUND_PENDING (RETRY_LATER); a gateway that refuses leaves it too, as REFUSED', async () => {
      const { payment } = await f.paying();
      await f.payments.transition(
        payment.id,
        [PaymentStatus.INITIATED],
        PaymentStatus.SUCCEEDED,
        null,
        { paidAmount: 150000 },
      );
      await f.payments.transition(
        payment.id,
        [PaymentStatus.SUCCEEDED],
        PaymentStatus.REFUND_PENDING,
        null,
      );

      f.gateway.failNext('refund');
      expect(
        await f.commands.execute(new RefundPaymentCommand(payment.id)),
      ).toEqual({ kind: 'RETRY_LATER' });
      expect((await f.paymentOf(payment.id)).status).toBe('REFUND_PENDING');
      // the gateway never collected anything for this charge (the test wrote the payment as paid by hand), so it refuses
      expect(
        await f.commands.execute(new RefundPaymentCommand(payment.id)),
      ).toEqual({ kind: 'REFUSED' });
      expect((await f.paymentOf(payment.id)).status).toBe('REFUND_PENDING');
    });
  });

  // ── the order of things that matters ─────────────────────────────────────

  it('takes the stock out of the warehouse BEFORE it confirms the order: a payment that dies in between leaves an order that can be confirmed again, never a confirmed order without stock', async () => {
    const { order, skuId, payment } = await f.paying();
    vi.spyOn(f.orders, 'transition').mockRejectedValueOnce(
      new Error('died between the two steps'),
    );

    await f.apply(refTo(payment), 'PAID', 150000);
    vi.restoreAllMocks();

    expect((await f.orderOf(order.id)).status).toBe('PAYMENT_PROCESSING');
    expect((await f.holds(order.id))[0].status).toBe('CONFIRMED'); // the stock is out
    expect(await f.onHand(skuId)).toBe(7);

    const finished = await f.commands.execute(
      new FinishPaidPaymentCommand(payment.id),
    );

    expect(finished).toEqual({ kind: 'CONFIRMED' });
    expect((await f.orderOf(order.id)).status).toBe('CONFIRMED');
    expect(await f.onHand(skuId)).toBe(7); // not taken out twice
  });

  it('writes the failure of a payment that failed through the repository the same way as through a webhook', async () => {
    const { payment } = await f.paying();
    const stored = (await f.payments.findById(payment.id))!;

    const moved = await f.payments.transition(
      payment.id,
      [PaymentStatus.INITIATED],
      PaymentStatus.FAILED,
      paymentFailedEvent(stored),
    );
    await f.commands.execute(new ReopenOrderCommand(payment.orderId));

    expect(moved?.status).toBe('FAILED');
    expect((await f.orderOf(payment.orderId)).status).toBe('PENDING');
  });
});
