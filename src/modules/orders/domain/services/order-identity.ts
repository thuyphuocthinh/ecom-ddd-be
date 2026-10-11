import { createHash } from 'crypto';

/**
 * The id of an order, worked out from who placed it and the Idempotency-Key they sent: the same
 * user with the same key always gets the same id, so a retry of a request meets the order it
 * already created (and the stock already held for it, which uses this id too). Another user with
 * the same key gets another id. Written like a UUID (version 5 bits set) so it looks like every
 * other id.
 */
export function deriveOrderId(userId: string, idempotencyKey: string): string {
  const hash = createHash('sha256')
    .update(`${userId}\u0000${idempotencyKey}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 8 to 100 characters from A-Z a-z 0-9 _ - (a UUID fits). */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(key);
}

// Money is added in hundredths, as whole numbers, so 199000.50 x 3 has no rounding error
export const toCents = (amount: number): number => Math.round(amount * 100);
export const fromCents = (cents: number): number => cents / 100;

/** unit price x quantity, exact to the hundredth. */
export function lineTotal(unitPrice: number, quantity: number): number {
  return fromCents(toCents(unitPrice) * quantity);
}

/** The total of lines that each have a unit price and a quantity, exact to the hundredth. */
export function computeTotal(
  lines: ReadonlyArray<{ unitPrice: number; quantity: number }>,
): number {
  let cents = 0;
  for (const line of lines) cents += toCents(line.unitPrice) * line.quantity;
  return fromCents(cents);
}
