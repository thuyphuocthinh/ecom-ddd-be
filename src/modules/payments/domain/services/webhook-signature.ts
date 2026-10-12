import { createHmac, timingSafeEqual } from 'crypto';
import { InvalidWebhookSignature } from '../ports/payment-gateway.port.js';

/**
 * The signature scheme of the FAKE gateway, kept apart because it is plain and shows how a signed
 * webhook is checked; a real gateway has its own scheme and its adapter does its own checking
 * (VNPay signs the parameters of the URL, ZaloPay signs one field of the body).
 *
 * The header is `t=<unix seconds>,v1=<hex>` where `v1` is HMAC-SHA256, with the shared key, of
 * `<t>.<raw body>`. Signing the time too means a recorded webhook cannot be played again later:
 * it is refused once `t` is further from now than the tolerance.
 */
export function signWebhook(
  secret: string,
  rawBody: Buffer,
  now: Date,
): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${macOf(secret, t, rawBody)}`;
}

/**
 * Throws `InvalidWebhookSignature` unless the header is well formed, the time is within
 * `toleranceSeconds` of `now` (in either direction), and the signature is the one the raw body
 * should have. The comparison takes the same time however many characters match.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | string[] | undefined,
  rawBody: Buffer,
  now: Date,
  toleranceSeconds: number,
): void {
  if (typeof header !== 'string' || header === '') {
    throw new InvalidWebhookSignature('there is no signature');
  }
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const at = piece.indexOf('=');
    if (at > 0)
      parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
  }
  const timeText = parts.get('t');
  const given = parts.get('v1');
  if (!timeText || !/^\d{1,12}$/.test(timeText) || !given) {
    throw new InvalidWebhookSignature('the signature is malformed');
  }

  const t = Number(timeText);
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) {
    throw new InvalidWebhookSignature(
      'the message is too old or from the future',
    );
  }

  const expected = Buffer.from(macOf(secret, t, rawBody), 'hex');
  let received: Buffer;
  try {
    received = Buffer.from(given, 'hex');
  } catch {
    received = Buffer.alloc(0);
  }
  // timingSafeEqual needs equal lengths; a wrong length is wrong without comparing anything secret
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    throw new InvalidWebhookSignature('the signature does not match');
  }
}

function macOf(secret: string, t: number, rawBody: Buffer): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${t}.`), rawBody]))
    .digest('hex');
}
