import { createHash } from 'crypto';

/**
 * The id of a payment, worked out from the order it pays and the Idempotency-Key the customer
 * sent: the same order with the same key always gets the same id, so a retry of a request meets the
 * payment it already created. The gateway is given this id too, so it recognises a request it has
 * already seen. The prefix keeps it apart from the id of an order made the same way. Written like
 * a UUID (version 5 bits set) so it looks like every other id.
 */
export function derivePaymentId(
  orderId: string,
  idempotencyKey: string,
): string {
  const hash = createHash('sha256')
    .update(`payment\u0000${orderId}\u0000${idempotencyKey}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether two amounts of money are the same, compared to the hundredth (so 0.1 + 0.2 equals 0.3). */
export function sameAmount(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}
