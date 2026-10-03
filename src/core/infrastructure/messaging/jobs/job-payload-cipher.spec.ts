import { describe, it, expect } from 'vitest';
import { JobPayloadCipher } from './job-payload-cipher.js';

const MESSAGE = {
  to: 'jane.doe@example.com',
  subject: 'Your code',
  text: 'Code: 482915',
  html: '<p>Code: <b>482915</b></p>',
};
const SECRET = 's'.repeat(32);

describe('JobPayloadCipher', () => {
  const cipher = new JobPayloadCipher(SECRET, 'test-v1');

  it('gives back exactly the message that was encrypted', () => {
    expect(cipher.decrypt(cipher.encrypt(MESSAGE))).toEqual(MESSAGE);
  });

  it('keeps the address, the code and the text out of the encrypted form (AC-5)', () => {
    const payload = cipher.encrypt(MESSAGE);

    expect(payload).not.toContain('jane.doe');
    expect(payload).not.toContain('482915');
    expect(payload).not.toContain('Your code');
    // base64 must not just be hiding the plain text
    for (const part of payload.split('.')) {
      const decoded = Buffer.from(part, 'base64').toString('latin1');
      expect(decoded).not.toContain('482915');
      expect(decoded).not.toContain('jane.doe');
    }
  });

  it('refuses a payload that was made with another label: each kind of job has its own key', () => {
    const other = new JobPayloadCipher(SECRET, 'other-v1');

    expect(() => cipher.decrypt(other.encrypt(MESSAGE))).toThrow();
  });

  it('works for any JSON value, not only emails', () => {
    expect(cipher.decrypt(cipher.encrypt({ email: 'a@example.com' }))).toEqual({
      email: 'a@example.com',
    });
  });

  it('produces a different result every time for the same message (fresh IV)', () => {
    expect(cipher.encrypt(MESSAGE)).not.toBe(cipher.encrypt(MESSAGE));
  });

  it('refuses a payload that was made with another secret', () => {
    const other = new JobPayloadCipher('t'.repeat(32), 'test-v1');

    expect(() => cipher.decrypt(other.encrypt(MESSAGE))).toThrow();
  });

  it('refuses a payload that was altered', () => {
    const [iv, tag, ciphertext] = cipher.encrypt(MESSAGE).split('.');
    const bytes = Buffer.from(ciphertext, 'base64');
    bytes[0] ^= 1;

    expect(() =>
      cipher.decrypt([iv, tag, bytes.toString('base64')].join('.')),
    ).toThrow();
  });

  it('refuses a payload whose authentication tag was cut short, which would otherwise still verify', () => {
    const [iv, tag, ciphertext] = cipher.encrypt(MESSAGE).split('.');
    const shortTag = Buffer.from(tag, 'base64').subarray(0, 4);

    expect(() =>
      cipher.decrypt([iv, shortTag.toString('base64'), ciphertext].join('.')),
    ).toThrow(/Malformed/);
  });

  it.each(['', 'abc', 'a.b', 'a.b.c.d'])(
    'refuses a malformed payload "%s"',
    (payload) => {
      expect(() => cipher.decrypt(payload)).toThrow();
    },
  );
});
