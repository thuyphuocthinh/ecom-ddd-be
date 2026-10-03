import * as argon2 from 'argon2';
import { createHash, createHmac, randomBytes, randomInt } from 'crypto';

export class HashUtil {
  /** Deterministic hex digest for high-entropy values (tokens), where a slow password hash isn't needed. */
  static sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  static async hashPassword(plainText: string): Promise<string> {
    // Standard config: Cân bằng tốc độ và bảo mật cho web (Khoảng 200-300ms)
    return argon2.hash(plainText, {
      type: argon2.argon2id,
      memoryCost: 19456, // 19 MB RAM
      timeCost: 2, // 2 iterations
      parallelism: 1, // 1 thread
    });
  }

  static async comparePassword(
    plainText: string,
    hash: string,
  ): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainText);
    } catch {
      return false;
    }
  }

  static generateRandomToken(length = 32): string {
    return randomBytes(length).toString('hex');
  }

  /** Keyed hex digest: unlike a plain hash, it can't be brute-forced offline without the key. */
  static hmacSha256(key: string | Buffer, value: string): string {
    return createHmac('sha256', key).update(value).digest('hex');
  }

  /**
   * A numeric one-time code of `length` digits (leading zeros allowed), drawn from
   * the OS CSPRNG so it can't be predicted from earlier codes.
   */
  static generateOTP(length = 6): string {
    return randomInt(0, Math.pow(10, length)).toString().padStart(length, '0');
  }
}
