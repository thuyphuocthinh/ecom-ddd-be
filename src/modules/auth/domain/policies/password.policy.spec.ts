import { describe, it, expect } from 'vitest';
import { findPasswordWeakness } from './password.policy.js';

const weakness = (
  password: string,
  email = 'jane.doe@example.com',
  appName = 'Ecommerce Platform',
) => findPasswordWeakness({ password, email, appName });

describe('findPasswordWeakness', () => {
  describe('common passwords', () => {
    it.each([
      'password',
      'Password',
      'PASSWORD',
      'qwertyuiop',
      '12345678',
      'iloveyou',
      'matkhau123',
    ])('refuses "%s", whatever its capitalisation', (password) => {
      expect(weakness(password)).not.toBeNull();
    });

    it.each([
      'password123!',
      'Password2026',
      'iloveyou2026!',
      'Welcome1',
      'letmein99',
    ])(
      'refuses "%s": a common word with digits or symbols tacked on',
      (password) => {
        expect(weakness(password)).toBe('COMMON');
      },
    );

    it('does not refuse a password just because it contains a common word in the middle', () => {
      expect(weakness('my-dragon-eats-7-apples')).toBeNull();
      expect(weakness('correct horse battery staple')).toBeNull();
    });
  });

  describe('repeated and sequential', () => {
    it.each(['aaaaaaaa', 'zzzzzzzzzz', 'bcdefghij', '87654321', 'hgfedcba'])(
      'refuses "%s"',
      (password) => {
        expect(weakness(password)).not.toBeNull();
      },
    );

    it('allows a password that only partly follows a pattern', () => {
      expect(weakness('abcdefgh!7Kq')).toBeNull();
      expect(weakness('11111112x')).toBeNull();
    });
  });

  describe("the user's own details", () => {
    it('refuses the email itself', () => {
      expect(weakness('jane.doe@example.com')).toBe('CONTAINS_EMAIL');
    });

    it('refuses a password containing the name part of the email', () => {
      expect(weakness('xx-jane.doe-xx', 'jane.doe@example.com')).toBe(
        'CONTAINS_EMAIL',
      );
    });

    it('ignores a name part too short to mean anything', () => {
      expect(weakness('abc-unrelated-9z', 'abc@example.com')).toBeNull();
    });
  });

  describe("the shop's name", () => {
    it.each(['I love Ecommerce 2026', 'platformfan-77x'])(
      'refuses "%s": it contains a word of the shop name',
      (password) => {
        expect(weakness(password)).toBe('CONTAINS_APP_NAME');
      },
    );

    it('copes with a name that has accents and short words', () => {
      expect(weakness('xin chào cửa hàng 9Z', 'a@b.com', 'Cửa hàng An')).toBe(
        'CONTAINS_APP_NAME',
      );
      expect(
        weakness('some other 9Z phrase', 'a@b.com', 'Cửa hàng An'),
      ).toBeNull();
    });
  });

  it('accepts an ordinary reasonable password', () => {
    expect(weakness('7-purple-Giraffes-dance')).toBeNull();
    expect(weakness('k9#Tq2$vLm8x')).toBeNull();
  });
});
