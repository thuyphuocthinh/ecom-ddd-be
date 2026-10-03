import { describe, it, expect, vi } from 'vitest';
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

  it('should generate OTP with correct length, digits only', () => {
    for (let i = 0; i < 200; i++) {
      expect(HashUtil.generateOTP(6)).toMatch(/^\d{6}$/);
    }
  });

  it('should use the whole 10^6 space, leading zeros included', () => {
    // P(no code starts with 0 in 5000 draws) = 0.9^5000, i.e. never
    const codes = Array.from({ length: 5000 }, () => HashUtil.generateOTP(6));
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('should draw OTPs from the CSPRNG, never from Math.random', () => {
    const math = vi.spyOn(Math, 'random');
    HashUtil.generateOTP(6);
    expect(math).not.toHaveBeenCalled();
    math.mockRestore();
  });

  it('should compute a keyed HMAC-SHA256 digest', () => {
    // RFC 4231 test case 2
    expect(HashUtil.hmacSha256('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(HashUtil.hmacSha256('key-a', 'value')).not.toBe(
      HashUtil.hmacSha256('key-b', 'value'),
    );
  });
});
