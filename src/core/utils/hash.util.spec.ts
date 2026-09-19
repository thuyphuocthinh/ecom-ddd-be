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
