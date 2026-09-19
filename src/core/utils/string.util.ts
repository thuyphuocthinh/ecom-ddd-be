import slugify from 'slugify';
import { randomBytes } from 'crypto';

export class StringUtil {
  static slugify(text: string): string {
    return slugify(text, {
      replacement: '-',
      remove: undefined,
      lower: true,
      strict: true,
      locale: 'vi',
      trim: true,
    });
  }

  static generateOrderCode(prefix = 'ORD'): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = randomBytes(2).toString('hex').toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }
}
