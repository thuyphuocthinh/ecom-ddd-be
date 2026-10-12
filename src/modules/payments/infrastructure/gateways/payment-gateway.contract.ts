import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import {
  GatewayRejected,
  InvalidWebhookSignature,
  type IPaymentGateway,
  type WebhookNotice,
  type WebhookRequest,
} from '../../domain/index.js';

/**
 * What the contract test needs besides the gateway itself: ways to do what a customer and the
 * gateway do outside our code. For the fake gateway these are method calls; for a real gateway
 * they are its sandbox (pay a test charge through its test API, sign a webhook with the sandbox
 * key). The contract itself never changes.
 */
export interface GatewayHarness {
  gateway: IPaymentGateway;
  /** The customer pays the charge. `collected` is what the gateway really takes (default: the amount asked). */
  payCharge(providerRef: string, collected?: number): Promise<void>;
  /** The payment of the charge does not work (declined...). */
  failCharge(providerRef: string): Promise<void>;
  /** A webhook for this notice, signed as the gateway signs it at `now`. */
  signNotice(notice: WebhookNotice, now?: Date): WebhookRequest;
  /** The same request with ONE byte of what is signed changed. */
  tamper(request: WebhookRequest): WebhookRequest;
  /** The same request without its signature. */
  unsign(request: WebhookRequest): WebhookRequest;
  /** Whether the scheme dates the signature and refuses old ones (a replay window). */
  replayWindow: boolean;
  /** Whether a charge can be paid for another amount than asked (a test of a wrong amount). */
  canPayOtherAmount: boolean;
  /** Called after each test. */
  cleanup?(): Promise<void> | void;
}

const charge = (amount = 3990000) => ({
  paymentId: randomUUID(),
  orderId: `order-${randomUUID()}`,
  amount,
});

/**
 * The contract every adapter of `IPaymentGateway` must keep. The payment module relies on each of
 * these: that a repeated request does not charge or refund twice, that the answers about a charge
 * are right, that a webhook is trusted only when its signature is right, and that the reply to the
 * gateway has the shape it expects. Run it against every adapter, the fake one and each real one:
 * a gateway that passes it works with the module as it is.
 *
 *   paymentGatewayContract('vnpay (sandbox)', () => makeVnpaySandboxHarness());
 */
export function paymentGatewayContract(
  name: string,
  setUp: () => GatewayHarness | Promise<GatewayHarness>,
): void {
  describe(`IPaymentGateway contract: ${name}`, () => {
    let harness: GatewayHarness;
    let gateway: IPaymentGateway;

    beforeEach(async () => {
      harness = await setUp();
      gateway = harness.gateway;
    });
    afterEach(async () => {
      await harness.cleanup?.();
    });

    const NOTICE = (
      providerRef: string,
      status: 'PAID' | 'FAILED' = 'PAID',
      amount = 3990000,
    ): WebhookNotice => ({
      eventId: `evt-${randomUUID()}`,
      providerRef,
      status,
      amount,
      occurredAt: new Date('2026-10-12T10:00:00.000Z'),
    });

    it('has a name that is stored with every payment (1 to 30 characters)', () => {
      expect(typeof gateway.name).toBe('string');
      expect(gateway.name.length).toBeGreaterThan(0);
      expect(gateway.name.length).toBeLessThanOrEqual(30);
    });

    describe('createCharge', () => {
      it('gives the gateway reference and where the customer pays', async () => {
        const result = await gateway.createCharge(charge());

        expect(typeof result.providerRef).toBe('string');
        expect(result.providerRef.length).toBeGreaterThan(0);
        expect(result.providerRef.length).toBeLessThanOrEqual(100);
        expect(typeof result.payUrl).toBe('string');
        expect(result.payUrl.length).toBeGreaterThan(0);
        expect(result.payUrl.length).toBeLessThanOrEqual(2000);
      });

      it('is safe to repeat: the same payment is the same charge, with the same reference and link', async () => {
        const input = charge();

        const first = await gateway.createCharge(input);
        const again = await gateway.createCharge(input);
        const [a, b, c] = await Promise.all([
          gateway.createCharge(input),
          gateway.createCharge(input),
          gateway.createCharge(input),
        ]);

        expect(again).toEqual(first);
        expect([a, b, c]).toEqual([first, first, first]);
      });

      it('gives another charge for another payment', async () => {
        const first = await gateway.createCharge(charge());
        const second = await gateway.createCharge(charge());

        expect(second.providerRef).not.toBe(first.providerRef);
      });

      it.each([0, -1])(
        'refuses a charge of %s money with GatewayRejected',
        async (amount) => {
          await expect(
            gateway.createCharge(charge(amount)),
          ).rejects.toBeInstanceOf(GatewayRejected);
        },
      );
    });

    describe('queryCharge', () => {
      it('says PENDING, with the amount, for a charge nobody has paid', async () => {
        const { providerRef } = await gateway.createCharge(charge(150000));

        expect(await gateway.queryCharge(providerRef)).toEqual({
          status: 'PENDING',
          amount: 150000,
        });
      });

      it('says PAID, with the amount taken, once the customer paid', async () => {
        const { providerRef } = await gateway.createCharge(charge(150000));
        await harness.payCharge(providerRef);

        expect(await gateway.queryCharge(providerRef)).toEqual({
          status: 'PAID',
          amount: 150000,
        });
      });

      it('says FAILED when the payment did not work', async () => {
        const { providerRef } = await gateway.createCharge(charge());
        await harness.failCharge(providerRef);

        expect((await gateway.queryCharge(providerRef)).status).toBe('FAILED');
      });

      it('reports the amount really taken, when it is not the amount asked', async (context) => {
        if (!harness.canPayOtherAmount) return context.skip();
        const { providerRef } = await gateway.createCharge(charge(150000));
        await harness.payCharge(providerRef, 1000);

        expect(await gateway.queryCharge(providerRef)).toEqual({
          status: 'PAID',
          amount: 1000,
        });
      });

      it('refuses a reference it does not know with GatewayRejected', async () => {
        await expect(
          gateway.queryCharge('no-such-charge'),
        ).rejects.toBeInstanceOf(GatewayRejected);
      });
    });

    describe('refund', () => {
      it('gives a reference for the refund of a paid charge', async () => {
        const input = charge(150000);
        const { providerRef } = await gateway.createCharge(input);
        await harness.payCharge(providerRef);

        const result = await gateway.refund({
          paymentId: input.paymentId,
          providerRef,
          amount: 150000,
        });

        expect(typeof result.refundRef).toBe('string');
        expect(result.refundRef.length).toBeGreaterThan(0);
      });

      it('is safe to repeat: the same payment is refunded once, whatever is asked after', async () => {
        const input = charge(150000);
        const { providerRef } = await gateway.createCharge(input);
        await harness.payCharge(providerRef);
        const ask = () =>
          gateway.refund({
            paymentId: input.paymentId,
            providerRef,
            amount: 150000,
          });

        const first = await ask();
        const again = await ask();
        const together = await Promise.all([ask(), ask(), ask()]);

        expect(again).toEqual(first);
        expect(together).toEqual([first, first, first]);
      });

      it('refuses to refund a charge that was not paid, with GatewayRejected', async () => {
        const input = charge();
        const { providerRef } = await gateway.createCharge(input);

        await expect(
          gateway.refund({
            paymentId: input.paymentId,
            providerRef,
            amount: input.amount,
          }),
        ).rejects.toBeInstanceOf(GatewayRejected);
      });

      it('refuses to refund more than was taken, with GatewayRejected', async () => {
        const input = charge(150000);
        const { providerRef } = await gateway.createCharge(input);
        await harness.payCharge(providerRef);

        await expect(
          gateway.refund({
            paymentId: input.paymentId,
            providerRef,
            amount: 150001,
          }),
        ).rejects.toBeInstanceOf(GatewayRejected);
      });

      it('refuses a charge it does not know, with GatewayRejected', async () => {
        await expect(
          gateway.refund({
            paymentId: randomUUID(),
            providerRef: 'no-such-charge',
            amount: 1000,
          }),
        ).rejects.toBeInstanceOf(GatewayRejected);
      });
    });

    describe('verifyWebhook', () => {
      const NOW = new Date('2026-10-12T10:00:00.000Z');

      it.each(['PAID', 'FAILED'] as const)(
        'accepts a webhook the gateway signed (%s) and reads it',
        (status) => {
          const notice = NOTICE('ref-123', status, 150000);

          const read = gateway.verifyWebhook(
            harness.signNotice(notice, NOW),
            NOW,
          );

          expect(read).toEqual(notice);
        },
      );

      it('refuses a webhook with ONE signed byte changed (InvalidWebhookSignature)', () => {
        const request = harness.signNotice(NOTICE('ref-123'), NOW);

        expect(() =>
          gateway.verifyWebhook(harness.tamper(request), NOW),
        ).toThrow(InvalidWebhookSignature);
      });

      it('refuses a webhook without a signature (InvalidWebhookSignature)', () => {
        const request = harness.signNotice(NOTICE('ref-123'), NOW);

        expect(() =>
          gateway.verifyWebhook(harness.unsign(request), NOW),
        ).toThrow(InvalidWebhookSignature);
      });

      it('refuses a webhook that was signed long ago: a recorded one cannot be replayed', async (context) => {
        if (!harness.replayWindow) return context.skip();
        const longAgo = new Date(NOW.getTime() - 24 * 3_600_000);
        const request = harness.signNotice(NOTICE('ref-123'), longAgo);

        expect(() => gateway.verifyWebhook(request, NOW)).toThrow(
          InvalidWebhookSignature,
        );
      });

      it('does not change the request it was given', () => {
        const request = harness.signNotice(NOTICE('ref-123'), NOW);
        const body = Buffer.from(request.rawBody);

        gateway.verifyWebhook(request, NOW);

        expect(request.rawBody.equals(body)).toBe(true);
      });
    });

    describe('webhookReply', () => {
      it('answers RECEIVED with a success, so the gateway stops sending that message', () => {
        const reply = gateway.webhookReply('RECEIVED');

        expect(reply.httpStatus).toBeGreaterThanOrEqual(200);
        expect(reply.httpStatus).toBeLessThan(300);
        expect(reply.body).toBeDefined();
      });

      it.each(['INVALID_SIGNATURE', 'BAD_REQUEST'] as const)(
        'answers %s with a client error',
        (kind) => {
          const reply = gateway.webhookReply(kind);

          expect(reply.httpStatus).toBeGreaterThanOrEqual(400);
          expect(reply.httpStatus).toBeLessThan(500);
          expect(reply.body).toBeDefined();
        },
      );

      it('answers ERROR with a server error, so the gateway sends the message again later', () => {
        const reply = gateway.webhookReply('ERROR');

        expect(reply.httpStatus).toBeGreaterThanOrEqual(500);
        expect(reply.body).toBeDefined();
      });
    });
  });
}
