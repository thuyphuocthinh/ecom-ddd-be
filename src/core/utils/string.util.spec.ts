import { describe, it, expect } from 'vitest';
import { StringUtil } from './string.util.js';

describe('StringUtil', () => {
  it('should slugify vietnamese string correctly', () => {
    const input = 'Áo thun Nam Đẹp 2024!@#';
    const slug = StringUtil.slugify(input);

    expect(slug).toBe('ao-thun-nam-dep-2024');
  });

  it('should generate an order code with given prefix', () => {
    const code = StringUtil.generateOrderCode('SHOPEE');
    expect(code.startsWith('SHOPEE-')).toBe(true);

    const parts = code.split('-');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('SHOPEE');
  });
});
