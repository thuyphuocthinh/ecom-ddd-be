import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

export class HashUtil {
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

  static generateOTP(length = 6): string {
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return Math.floor(min + Math.random() * (max - min + 1)).toString();
  }
}
