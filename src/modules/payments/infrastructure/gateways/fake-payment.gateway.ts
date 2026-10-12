import { randomUUID } from 'crypto';
import {
  GatewayRejected,
  GatewayUnavailable,
  InvalidWebhookPayload,
  signWebhook,
  verifyWebhookSignature,
  type ChargeResult,
  type ChargeStatus,
  type ChargeStatusResult,
  type CreateChargeInput,
  type IPaymentGateway,
  type RefundInput,
  type RefundResult,
  type WebhookNotice,
  type WebhookReply,
  type WebhookReplyKind,
  type WebhookRequest,
} from '../../domain/index.js';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;

type Operation = 'createCharge' | 'queryCharge' | 'refund';

interface FakeCharge {
  providerRef: string;
  paymentId: string;
  orderId: string;
  amount: number;
  state: ChargeStatus;
  /** What the "customer" really paid (set when the charge is paid). */
  collected: number | null;
}

/**
 * A stand-in for a real payment gateway, so the whole payment flow runs without an account. It
 * keeps its ledger in memory (one process only; a real gateway keeps its own) and signs its
 * webhooks the way `webhook-signature.ts` describes. Nothing here moves money.
 *
 * Beyond the gateway interface it has hooks for tests and for the dev endpoints: pay or fail a
 * charge, make the next calls fail, pretend to be down, count what was charged and refunded, and
 * build a signed webhook.
 */
export class FakePaymentGateway implements IPaymentGateway {
  readonly name = 'fake';

  private readonly byRef = new Map<string, FakeCharge>();
  private readonly byPayment = new Map<string, FakeCharge>();
  private readonly refunds = new Map<string, string>();
  private readonly failures = new Map<Operation, number>();
  private unavailable = false;

  constructor(
    private readonly options: {
      secret: string;
      toleranceSeconds?: number;
    },
  ) {}

  // ── the gateway interface ─────────────────────────────────────────────────

  async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
    this.guard('createCharge');
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new GatewayRejected('the amount must be more than 0');
    }
    // Safe to repeat: the same payment is the same charge
    const existing = this.byPayment.get(input.paymentId);
    if (existing) return this.resultOf(existing);

    const charge: FakeCharge = {
      providerRef: `fake_${randomUUID()}`,
      paymentId: input.paymentId,
      orderId: input.orderId,
      amount: input.amount,
      state: 'PENDING',
      collected: null,
    };
    this.byRef.set(charge.providerRef, charge);
    this.byPayment.set(charge.paymentId, charge);
    return this.resultOf(charge);
  }

  async queryCharge(providerRef: string): Promise<ChargeStatusResult> {
    this.guard('queryCharge');
    const charge = this.chargeOf(providerRef);
    return {
      status: charge.state,
      amount:
        charge.state === 'PAID'
          ? (charge.collected ?? charge.amount)
          : charge.amount,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    this.guard('refund');
    // Safe to repeat: the same payment is refunded once
    const done = this.refunds.get(input.paymentId);
    if (done) return { refundRef: done };

    const charge = this.chargeOf(input.providerRef);
    if (charge.state !== 'PAID') {
      throw new GatewayRejected('only a paid charge can be refunded');
    }
    if (
      Math.round(input.amount * 100) >
      Math.round((charge.collected ?? charge.amount) * 100)
    ) {
      throw new GatewayRejected('more than was collected cannot be refunded');
    }
    const refundRef = `fake_refund_${randomUUID()}`;
    this.refunds.set(input.paymentId, refundRef);
    return { refundRef };
  }

  verifyWebhook(
    request: WebhookRequest,
    now: Date = new Date(),
  ): WebhookNotice {
    verifyWebhookSignature(
      this.options.secret,
      request.headers[FAKE_SIGNATURE_HEADER],
      request.rawBody,
      now,
      this.options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
    );
    return this.read(request.rawBody);
  }

  webhookReply(kind: WebhookReplyKind): WebhookReply {
    switch (kind) {
      case 'RECEIVED':
        return { httpStatus: 200, body: { received: true } };
      case 'INVALID_SIGNATURE':
        return { httpStatus: 401, body: { error: 'invalid signature' } };
      case 'BAD_REQUEST':
        return { httpStatus: 400, body: { error: 'bad request' } };
      case 'ERROR':
        return { httpStatus: 500, body: { error: 'try again later' } };
    }
  }

  // ── what tests and the dev endpoints use ──────────────────────────────────

  /** How many different charges were created (a repeated create does not count). */
  get chargeCount(): number {
    return this.byRef.size;
  }

  /** How many different payments were refunded (a repeated refund does not count). */
  get refundCount(): number {
    return this.refunds.size;
  }

  /** The charge the gateway has for a payment, if any. */
  chargeFor(paymentId: string): Readonly<FakeCharge> | undefined {
    return this.byPayment.get(paymentId);
  }

  /** The "customer" pays. `collected` defaults to the amount asked; give another to test a wrong amount. */
  markPaid(providerRef: string, collected?: number): void {
    const charge = this.chargeOf(providerRef);
    charge.state = 'PAID';
    charge.collected = collected ?? charge.amount;
  }

  /** The payment does not work (card declined...). */
  markFailed(providerRef: string): void {
    this.chargeOf(providerRef).state = 'FAILED';
  }

  /** The next `times` calls of `operation` fail as if the gateway could not be reached. */
  failNext(operation: Operation, times = 1): void {
    this.failures.set(operation, times);
  }

  /** While true every call fails as if the gateway could not be reached. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  /** A webhook for this notice, signed as the gateway would sign it at `now`. */
  signNotice(notice: WebhookNotice, now: Date = new Date()): WebhookRequest {
    const rawBody = Buffer.from(
      JSON.stringify({
        ...notice,
        occurredAt: notice.occurredAt.toISOString(),
      }),
    );
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: signWebhook(this.options.secret, rawBody, now),
      },
      query: {},
    };
  }

  /** The webhook this gateway would send now for a charge (what the dev endpoints send). */
  noticeFor(providerRef: string, status: 'PAID' | 'FAILED'): WebhookNotice {
    const charge = this.chargeOf(providerRef);
    return {
      eventId: `fake_evt_${randomUUID()}`,
      providerRef,
      status,
      amount:
        status === 'PAID' ? (charge.collected ?? charge.amount) : charge.amount,
      occurredAt: new Date(),
    };
  }

  /** Forgets everything. */
  reset(): void {
    this.byRef.clear();
    this.byPayment.clear();
    this.refunds.clear();
    this.failures.clear();
    this.unavailable = false;
  }

  // ── inside ────────────────────────────────────────────────────────────────

  private guard(operation: Operation): void {
    if (this.unavailable) throw new GatewayUnavailable();
    const left = this.failures.get(operation) ?? 0;
    if (left > 0) {
      this.failures.set(operation, left - 1);
      throw new GatewayUnavailable();
    }
  }

  private chargeOf(providerRef: string): FakeCharge {
    const charge = this.byRef.get(providerRef);
    if (!charge) throw new GatewayRejected('no such charge');
    return charge;
  }

  private resultOf(charge: FakeCharge): ChargeResult {
    return {
      providerRef: charge.providerRef,
      payUrl: `/dev/fake-gateway/charges/${charge.providerRef}`,
    };
  }

  private read(rawBody: Buffer): WebhookNotice {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidWebhookPayload('the body is not JSON');
    }
    if (!body || typeof body !== 'object') {
      throw new InvalidWebhookPayload('the body is not an object');
    }
    const { eventId, providerRef, status, amount, occurredAt } = body;
    if (typeof eventId !== 'string' || eventId === '' || eventId.length > 200) {
      throw new InvalidWebhookPayload('eventId is missing');
    }
    if (
      typeof providerRef !== 'string' ||
      providerRef === '' ||
      providerRef.length > 100
    ) {
      throw new InvalidWebhookPayload('providerRef is missing');
    }
    if (status !== 'PAID' && status !== 'FAILED') {
      throw new InvalidWebhookPayload('status must be PAID or FAILED');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new InvalidWebhookPayload('amount is not a number');
    }
    const when =
      typeof occurredAt === 'string'
        ? new Date(occurredAt)
        : new Date(Number.NaN);
    if (Number.isNaN(when.getTime())) {
      throw new InvalidWebhookPayload('occurredAt is not a time');
    }
    return { eventId, providerRef, status, amount, occurredAt: when };
  }
}
