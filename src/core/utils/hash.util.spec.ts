import { describe, it, expect } from 'vitest';
import { HashUtil } from './hash.util.js';

describe('HashUtil', () => {
  it('should hash and compare passwords correctly', async () => {
    const plainText = 'my-super-secret-password';
    const hash = await HashUtil.hashPassword(plainText);

    expect(hash).not.toBe(plainText);

    const isMatch = await HashUtil.comparePassword(plainText, hash);
    expect(isMatch).toBe(true);

    const isFalseMatch = await HashUtil.comparePassword('wrong-password', hash);
    expect(isFalseMatch).toBe(false);
  });

  it('should hash with sha256 deterministically', () => {
    // Well-known digest of "abc"
    expect(HashUtil.sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(HashUtil.sha256('abc')).toBe(HashUtil.sha256('abc'));
    expect(HashUtil.sha256('abd')).not.toBe(HashUtil.sha256('abc'));
  });

  it('should generate random token of given length', () => {
    const token = HashUtil.generateRandomToken(16);
    // 16 bytes = 32 hex characters
    expect(token.length).toBe(32);
  });

  it('should generate OTP with correct length', () => {
    const otp = HashUtil.generateOTP(6);
    expect(otp.length).toBe(6);
    expect(Number.isNaN(Number(otp))).toBe(false); // Should be numeric
  });
});
