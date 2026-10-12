import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  GatewayRejected,
  GatewayUnavailable,
  InvalidWebhookPayload,
  InvalidWebhookSignature,
  signWebhook,
  type WebhookRequest,
} from '../../domain/index.js';
import type { PaymentsConfig } from '../../payments.config.js';
import {
  FAKE_SIGNATURE_HEADER,
  FakePaymentGateway,
} from './fake-payment.gateway.js';
import { createPaymentGateway } from './payment-gateway.factory.js';
import {
  paymentGatewayContract,
  type GatewayHarness,
} from './payment-gateway.contract.js';

const SECRET = 'a-fake-gateway-secret-of-length';

/** The fake gateway against the contract every gateway must keep (AC-18). */
paymentGatewayContract('fake', (): GatewayHarness => {
  const gateway = new FakePaymentGateway({ secret: SECRET });
  return {
    gateway,
    payCharge: async (providerRef, collected) =>
      gateway.markPaid(providerRef, collected),
    failCharge: async (providerRef) => gateway.markFailed(providerRef),
    signNotice: (notice, now) => gateway.signNotice(notice, now),
    tamper: (request) => {
      const rawBody = Buffer.from(request.rawBody);
      rawBody[rawBody.length - 2] ^= 0x01;
      return { ...request, rawBody };
    },
    unsign: (request) => {
      const headers = { ...request.headers };
      delete headers[FAKE_SIGNATURE_HEADER];
      return { ...request, headers };
    },
    replayWindow: true,
    canPayOtherAmount: true,
  };
});

describe('FakePaymentGateway', () => {
  let gateway: FakePaymentGateway;
  const input = (amount = 150000) => ({
    paymentId: randomUUID(),
    orderId: 'order-1',
    amount,
  });

  beforeEach(() => {
    gateway = new FakePaymentGateway({ secret: SECRET, toleranceSeconds: 300 });
  });

  describe('counting, for tests', () => {
    it('counts the charges that were made, and a repeated create does not count again', async () => {
      const one = input();
      await gateway.createCharge(one);
      await gateway.createCharge(one);
      await Promise.all([gateway.createCharge(one), gateway.createCharge(one)]);
      await gateway.createCharge(input());

      expect(gateway.chargeCount).toBe(2);
    });

    it('counts the payments that were refunded, and a repeated refund does not count again', async () => {
      const one = input();
      const { providerRef } = await gateway.createCharge(one);
      gateway.markPaid(providerRef);
      for (let i = 0; i < 4; i++) {
        await gateway.refund({
          paymentId: one.paymentId,
          providerRef,
          amount: one.amount,
        });
      }

      expect(gateway.refundCount).toBe(1);
    });

    it('finds the charge of a payment', async () => {
      const one = input();
      const { providerRef } = await gateway.createCharge(one);

      expect(gateway.chargeFor(one.paymentId)).toMatchObject({
        providerRef,
        state: 'PENDING',
      });
      expect(gateway.chargeFor('nope')).toBeUndefined();
    });
  });

  describe('failing on purpose', () => {
    it('fails the next calls of one operation with GatewayUnavailable, then works again', async () => {
      gateway.failNext('createCharge', 2);

      await expect(gateway.createCharge(input())).rejects.toBeInstanceOf(
        GatewayUnavailable,
      );
      await expect(gateway.createCharge(input())).rejects.toBeInstanceOf(
        GatewayUnavailable,
      );
      await expect(gateway.createCharge(input())).resolves.toBeDefined();
      expect(gateway.chargeCount).toBe(1); // the failed ones created nothing
    });

    it('fails only the operation asked for', async () => {
      const one = input();
      const { providerRef } = await gateway.createCharge(one);
      gateway.failNext('queryCharge');

      await expect(gateway.queryCharge(providerRef)).rejects.toBeInstanceOf(
        GatewayUnavailable,
      );
      await expect(gateway.createCharge(one)).resolves.toBeDefined();
    });

    it('pretends to be down for every call while told to, then comes back', async () => {
      const one = input();
      const { providerRef } = await gateway.createCharge(one);
      gateway.markPaid(providerRef);
      gateway.setUnavailable(true);

      await expect(gateway.createCharge(input())).rejects.toBeInstanceOf(
        GatewayUnavailable,
      );
      await expect(gateway.queryCharge(providerRef)).rejects.toBeInstanceOf(
        GatewayUnavailable,
      );
      await expect(
        gateway.refund({
          paymentId: one.paymentId,
          providerRef,
          amount: one.amount,
        }),
      ).rejects.toBeInstanceOf(GatewayUnavailable);
      gateway.setUnavailable(false);
      await expect(gateway.queryCharge(providerRef)).resolves.toMatchObject({
        status: 'PAID',
      });
      expect(gateway.refundCount).toBe(0); // the refund that failed refunded nothing
    });

    it('forgets everything on reset', async () => {
      const one = input();
      await gateway.createCharge(one);
      gateway.setUnavailable(true);

      gateway.reset();

      expect(gateway.chargeCount).toBe(0);
      await expect(gateway.createCharge(one)).resolves.toBeDefined();
    });
  });

  describe('what the "customer" does', () => {
    it('pays another amount than asked, and says so when asked', async () => {
      const { providerRef } = await gateway.createCharge(input(150000));
      gateway.markPaid(providerRef, 1000);

      expect(await gateway.queryCharge(providerRef)).toEqual({
        status: 'PAID',
        amount: 1000,
      });
      expect(gateway.noticeFor(providerRef, 'PAID').amount).toBe(1000);
    });

    it('builds the webhook it would send, each with its own id', async () => {
      const { providerRef } = await gateway.createCharge(input(150000));

      const a = gateway.noticeFor(providerRef, 'PAID');
      const b = gateway.noticeFor(providerRef, 'PAID');

      expect(a).toMatchObject({ providerRef, status: 'PAID', amount: 150000 });
      expect(a.eventId).not.toBe(b.eventId);
      expect(gateway.noticeFor(providerRef, 'FAILED').status).toBe('FAILED');
    });

    it('refuses a charge it does not know', () => {
      expect(() => gateway.markPaid('nope')).toThrow(GatewayRejected);
      expect(() => gateway.markFailed('nope')).toThrow(GatewayRejected);
      expect(() => gateway.noticeFor('nope', 'PAID')).toThrow(GatewayRejected);
    });

    it('gives a payment link that the dev endpoints know', async () => {
      const { providerRef, payUrl } = await gateway.createCharge(input());

      expect(payUrl).toBe(`/dev/fake-gateway/charges/${providerRef}`);
    });
  });

  describe('verifyWebhook, beyond the contract', () => {
    const signed = (body: string, now = new Date()): WebhookRequest => {
      const rawBody = Buffer.from(body);
      return {
        rawBody,
        headers: { [FAKE_SIGNATURE_HEADER]: signWebhook(SECRET, rawBody, now) },
        query: {},
      };
    };
    const body = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        eventId: 'e1',
        providerRef: 'r1',
        status: 'PAID',
        amount: 1000,
        occurredAt: '2026-10-12T10:00:00.000Z',
        ...overrides,
      });

    it('checks the signature BEFORE it reads anything: garbage with a bad signature is a signature failure', () => {
      const request: WebhookRequest = {
        rawBody: Buffer.from('not even JSON'),
        headers: { [FAKE_SIGNATURE_HEADER]: 't=1,v1=' + 'a'.repeat(64) },
        query: {},
      };

      expect(() => gateway.verifyWebhook(request)).toThrow(
        InvalidWebhookSignature,
      );
    });

    it('refuses a signed message that is not JSON, or not an object (InvalidWebhookPayload)', () => {
      for (const text of ['not JSON', 'null', '42', '"text"']) {
        expect(() => gateway.verifyWebhook(signed(text))).toThrow(
          InvalidWebhookPayload,
        );
      }
    });

    it.each([
      ['no eventId', { eventId: undefined }],
      ['an empty eventId', { eventId: '' }],
      ['an eventId that is too long', { eventId: 'e'.repeat(201) }],
      ['no providerRef', { providerRef: undefined }],
      ['a providerRef that is too long', { providerRef: 'r'.repeat(101) }],
      ['a status that is neither PAID nor FAILED', { status: 'REFUNDED' }],
      ['an amount that is not a number', { amount: '1000' }],
      ['a negative amount', { amount: -1 }],
      ['a time that is not a time', { occurredAt: 'yesterday' }],
      ['no time', { occurredAt: undefined }],
    ])(
      'refuses a signed message with %s (InvalidWebhookPayload)',
      (_, change) => {
        expect(() => gateway.verifyWebhook(signed(body(change)))).toThrow(
          InvalidWebhookPayload,
        );
      },
    );

    it('accepts an amount of 0 for a failed payment', () => {
      const read = gateway.verifyWebhook(
        signed(body({ status: 'FAILED', amount: 0 })),
      );

      expect(read.amount).toBe(0);
    });

    it('uses the tolerance it was built with', () => {
      const tight = new FakePaymentGateway({
        secret: SECRET,
        toleranceSeconds: 10,
      });
      const now = new Date();
      const request = signed(body(), new Date(now.getTime() - 60_000));

      expect(() => tight.verifyWebhook(request, now)).toThrow(/too old/);
      expect(() => gateway.verifyWebhook(request, now)).not.toThrow();
    });

    it('refuses what a gateway with another key signed', async () => {
      const other = new FakePaymentGateway({
        secret: 'some-other-secret-of-length-1',
      });
      const { providerRef } = await gateway.createCharge(input());

      const forged = other.signNotice(gateway.noticeFor(providerRef, 'PAID'));

      expect(() => gateway.verifyWebhook(forged)).toThrow(
        InvalidWebhookSignature,
      );
    });
  });
});

describe('createPaymentGateway', () => {
  const config = (overrides: Partial<PaymentsConfig> = {}): PaymentsConfig => ({
    gateway: 'fake',
    windowMinutes: 15,
    maintenanceIntervalSeconds: 60,
    webhookToleranceSeconds: 300,
    fakeWebhookSecret: SECRET,
    ...overrides,
  });

  it('builds the fake gateway for PAYMENT_GATEWAY=fake, signing with the configured key', () => {
    const gateway = createPaymentGateway(config());

    expect(gateway).toBeInstanceOf(FakePaymentGateway);
    expect(gateway.name).toBe('fake');
    const fake = gateway as FakePaymentGateway;
    const request = fake.signNotice({
      eventId: 'e1',
      providerRef: 'r1',
      status: 'PAID',
      amount: 1,
      occurredAt: new Date(),
    });
    expect(() => gateway.verifyWebhook(request)).not.toThrow();
    // a gateway built with another key does not trust it
    expect(() =>
      createPaymentGateway(
        config({ fakeWebhookSecret: 'another-key-of-sixteen-chars' }),
      ).verifyWebhook(request),
    ).toThrow(InvalidWebhookSignature);
  });

  it('refuses a gateway it does not know instead of silently picking one', () => {
    expect(() => createPaymentGateway(config({ gateway: 'stripe' }))).toThrow(
      /Unknown PAYMENT_GATEWAY/,
    );
  });
});
