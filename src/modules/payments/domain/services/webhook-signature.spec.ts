import { describe, it, expect } from 'vitest';
import { InvalidWebhookSignature } from '../ports/payment-gateway.port.js';
import { signWebhook, verifyWebhookSignature } from './webhook-signature.js';

const SECRET = 'a-shared-secret-of-sixteen-or-more';
const NOW = new Date('2026-10-12T10:00:00.000Z');
const BODY = Buffer.from(
  JSON.stringify({
    eventId: 'e1',
    providerRef: 'r1',
    status: 'PAID',
    amount: 3990000,
  }),
);
const verify =
  (
    header: string | string[] | undefined,
    body: Buffer = BODY,
    now: Date = NOW,
    tolerance = 300,
    secret = SECRET,
  ) =>
  () =>
    verifyWebhookSignature(secret, header, body, now, tolerance);

describe('signWebhook and verifyWebhookSignature', () => {
  it('accepts a webhook signed with the shared key, read at the moment it was signed', () => {
    expect(verify(signWebhook(SECRET, BODY, NOW))).not.toThrow();
  });

  it('writes the header as t=<seconds>,v1=<hex>', () => {
    expect(signWebhook(SECRET, BODY, NOW)).toMatch(
      /^t=1\d{9},v1=[0-9a-f]{64}$/,
    );
  });

  it('accepts it a little later, within the tolerance, and a little before (clocks differ)', () => {
    const header = signWebhook(SECRET, BODY, NOW);

    expect(
      verify(header, BODY, new Date(NOW.getTime() + 299_000)),
    ).not.toThrow();
    expect(
      verify(header, BODY, new Date(NOW.getTime() - 299_000)),
    ).not.toThrow();
  });

  it('refuses a message that is older than the tolerance: a recorded webhook cannot be played again', () => {
    const header = signWebhook(SECRET, BODY, NOW);

    expect(verify(header, BODY, new Date(NOW.getTime() + 301_000))).toThrow(
      InvalidWebhookSignature,
    );
    expect(verify(header, BODY, new Date(NOW.getTime() + 301_000))).toThrow(
      /too old/,
    );
  });

  it('refuses a message dated in the future beyond the tolerance', () => {
    const header = signWebhook(
      SECRET,
      BODY,
      new Date(NOW.getTime() + 3_600_000),
    );

    expect(verify(header)).toThrow(/future/);
  });

  it('uses the tolerance it is given', () => {
    const header = signWebhook(SECRET, BODY, NOW);
    const later = new Date(NOW.getTime() + 30_000);

    expect(verify(header, BODY, later, 60)).not.toThrow();
    expect(verify(header, BODY, later, 10)).toThrow(InvalidWebhookSignature);
  });

  it('refuses a body changed by ONE byte after it was signed', () => {
    const header = signWebhook(SECRET, BODY, NOW);
    for (let i = 0; i < BODY.length; i++) {
      const changed = Buffer.from(BODY);
      changed[i] = changed[i] ^ 0x01;
      expect(verify(header, changed), `byte ${i}`).toThrow(/does not match/);
    }
  });

  it('refuses a body with one byte added or taken away', () => {
    const header = signWebhook(SECRET, BODY, NOW);

    expect(verify(header, Buffer.concat([BODY, Buffer.from(' ')]))).toThrow(
      InvalidWebhookSignature,
    );
    expect(verify(header, BODY.subarray(0, BODY.length - 1))).toThrow(
      InvalidWebhookSignature,
    );
    expect(verify(header, Buffer.alloc(0))).toThrow(InvalidWebhookSignature);
  });

  it('is about the RAW bytes: the same JSON written with other spacing does not match', () => {
    const header = signWebhook(SECRET, BODY, NOW);
    const rewritten = Buffer.from(
      JSON.stringify(JSON.parse(BODY.toString()), null, 2),
    );

    expect(verify(header, rewritten)).toThrow(/does not match/);
  });

  it('refuses a signature made with another key', () => {
    expect(
      verify(signWebhook('another-key-of-sixteen-chars', BODY, NOW)),
    ).toThrow(/does not match/);
  });

  it('refuses a time that was changed (the time is signed too)', () => {
    const header = signWebhook(SECRET, BODY, NOW);
    const [, mac] = header.split(',');
    const fresher = `t=${Math.floor(NOW.getTime() / 1000) + 100},${mac}`;

    expect(verify(fresher)).toThrow(/does not match/);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['a header given twice', ['t=1,v1=aa', 't=1,v1=bb']],
    ['no time', 'v1=' + 'a'.repeat(64)],
    ['no signature', 't=1789000000'],
    ['a time that is not a number', 't=yesterday,v1=' + 'a'.repeat(64)],
    ['a negative time', 't=-5,v1=' + 'a'.repeat(64)],
    ['garbage', 'hello world'],
    [
      'a signature that is not hex',
      `t=${Math.floor(NOW.getTime() / 1000)},v1=${'z'.repeat(64)}`,
    ],
    [
      'a signature of the wrong length',
      `t=${Math.floor(NOW.getTime() / 1000)},v1=abcd`,
    ],
  ])('refuses %s', (_, header) => {
    expect(verify(header as never)).toThrow(InvalidWebhookSignature);
  });

  it('never lets a refusal through as an ordinary Error: the caller can tell it apart', () => {
    try {
      verify('nonsense')();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWebhookSignature);
      expect((error as Error).name).toBe('InvalidWebhookSignature');
      return;
    }
    throw new Error('should have thrown');
  });
});
