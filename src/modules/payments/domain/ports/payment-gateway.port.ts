/** DI token for the active IPaymentGateway. */
export const PAYMENT_GATEWAY = 'IPaymentGateway';

/**
 * Everything the payment module needs from a payment gateway, and nothing more. The fake gateway
 * (development and tests) and every real one (VNPay, ZaloPay...) implement this; the payment module
 * never knows which one it talks to. Each gateway signs, names its fields and answers its webhooks
 * in its own way, so the ADAPTER does all of that (`verifyWebhook`, `webhookReply`) and hands the
 * module a plain notice.
 *
 * Amounts are the amounts of the order (VND here). An adapter turns them into whatever its gateway
 * wants (VNPay wants them multiplied by 100).
 */
export interface IPaymentGateway {
  /** The name stored with every payment, so a payment is always read by the gateway that made it. */
  readonly name: string;

  /**
   * Asks the gateway to create a charge the customer can pay. SAFE TO REPEAT: the same `paymentId`
   * always gives the same charge (a second call does not create a second one). Rejects with
   * `GatewayUnavailable` when the gateway cannot be reached (the caller may try again) and with
   * `GatewayRejected` when it refuses the request itself.
   */
  createCharge(input: CreateChargeInput): Promise<ChargeResult>;

  /** How the gateway says the charge is doing. Rejects like `createCharge`. */
  queryCharge(providerRef: string): Promise<ChargeStatusResult>;

  /**
   * Sends money back. SAFE TO REPEAT: the same `paymentId` is refunded once, however often it is
   * asked. `amount` is what was really collected. Rejects like `createCharge`.
   */
  refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Checks that a webhook really comes from the gateway and reads it. Throws
   * `InvalidWebhookSignature` when the signature is missing or wrong, when the content was changed
   * after it was signed, or when the message is too old (a replay); throws `InvalidWebhookPayload`
   * when the message is signed but is not one this module understands. The signature is checked
   * against the RAW body, byte for byte, in constant time.
   */
  verifyWebhook(request: WebhookRequest, now?: Date): WebhookNotice;

  /** The answer to send the gateway, in the shape it expects. */
  webhookReply(kind: WebhookReplyKind): WebhookReply;
}

export interface CreateChargeInput {
  /** Our id for the payment; the gateway recognises a repeat by it. */
  paymentId: string;
  orderId: string;
  amount: number;
}

export interface ChargeResult {
  /** The gateway's own id for the charge. */
  providerRef: string;
  /** Where the customer goes to pay. */
  payUrl: string;
}

export type ChargeStatus = 'PENDING' | 'PAID' | 'FAILED';

export interface ChargeStatusResult {
  status: ChargeStatus;
  /** What the gateway says it took (for PAID), otherwise what the charge was for. */
  amount: number;
}

export interface RefundInput {
  paymentId: string;
  providerRef: string;
  /** What was really collected, and so what goes back. */
  amount: number;
}

export interface RefundResult {
  refundRef: string;
}

/** What reached the webhook endpoint, untouched. */
export interface WebhookRequest {
  /** The body as it arrived, byte for byte. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}

/** What a verified webhook says, the same whatever the gateway. */
export interface WebhookNotice {
  /** The gateway's id for this message; the same message sent again has the same id. */
  eventId: string;
  providerRef: string;
  status: 'PAID' | 'FAILED';
  /** What the gateway says it took (or would have taken). */
  amount: number;
  occurredAt: Date;
}

export type WebhookReplyKind =
  /** Understood and dealt with (or already dealt with): the gateway can stop sending it. */
  | 'RECEIVED'
  | 'INVALID_SIGNATURE'
  | 'BAD_REQUEST'
  /** Our own failure: the gateway should send it again later. */
  | 'ERROR';

export interface WebhookReply {
  httpStatus: number;
  body: unknown;
}

/** The webhook is not from the gateway, or was changed, or is too old. */
export class InvalidWebhookSignature extends Error {
  constructor(reason: string) {
    super(`Invalid webhook signature: ${reason}`);
    this.name = 'InvalidWebhookSignature';
  }
}

/** The webhook is signed but is not a message this module understands. */
export class InvalidWebhookPayload extends Error {
  constructor(reason: string) {
    super(`Invalid webhook payload: ${reason}`);
    this.name = 'InvalidWebhookPayload';
  }
}

/** The gateway cannot be reached or did not answer in time. The same call may be tried again. */
export class GatewayUnavailable extends Error {
  constructor(reason = 'The payment gateway is unavailable') {
    super(reason);
    this.name = 'GatewayUnavailable';
  }
}

/** The gateway understood the request and refused it. Trying again will not change that. */
export class GatewayRejected extends Error {
  constructor(reason: string) {
    super(`The payment gateway refused the request: ${reason}`);
    this.name = 'GatewayRejected';
  }
}
