import { describe, it, expect } from 'vitest';
import { normalizeDisplayName } from './display-name.js';

describe('normalizeDisplayName', () => {
  it('keeps an ordinary name, including Vietnamese letters', () => {
    expect(normalizeDisplayName('Nguyễn Văn A')).toBe('Nguyễn Văn A');
  });

  it('writes composed and decomposed letters the same way (NFC)', () => {
    const decomposed = 'Nguyễn';
    expect(normalizeDisplayName(decomposed)).toBe('Nguyễn');
  });

  it('trims both ends and collapses repeated spaces and tabs', () => {
    expect(normalizeDisplayName('   Jane \t  Doe  ')).toBe('Jane Doe');
  });

  it('turns line breaks and other control characters into a space', () => {
    expect(normalizeDisplayName('Jane\nDoe\r\nSmith\u0000')).toBe(
      'Jane Doe Smith',
    );
    expect(normalizeDisplayName('Jane Doe')).toBe('Jane Doe');
  });

  it('drops zero-width and text-direction characters', () => {
    expect(normalizeDisplayName('Ja​ne')).toBe('Jane');
    expect(normalizeDisplayName('‮enaj')).toBe('enaj');
    expect(normalizeDisplayName('Jane﻿')).toBe('Jane');
  });

  it.each([
    '',
    '   ',
    '\n\t',
    '\u200B\u200B',
    '\u0000',
    '\u3164',
    '\u2800\u2800',
    '\u200D',
    '\uFE0F',
    '\u0301',
  ])('returns null when nothing visible is left (%j)', (raw) => {
    expect(normalizeDisplayName(raw)).toBeNull();
  });

  it('drops the invisible fillers that look like letters but show nothing', () => {
    expect(normalizeDisplayName('Jaㅤne')).toBe('Jane');
    expect(normalizeDisplayName('Ja⠀ne')).toBe('Jane');
    expect(normalizeDisplayName('Ja͏neᅟﾠ')).toBe('Jane');
    expect(normalizeDisplayName('Ja­ne')).toBe('Jane');
  });

  it('keeps the joiners that real writing needs: Persian, Hindi, family and flag emoji, red heart', () => {
    const persian = 'می‌خواهم';
    const hindi = 'क्‍ष';
    const family = '👨‍👩‍👧';
    const flag = '🇻🇳';
    const heart = '❤️';

    for (const name of [persian, hindi, family, flag, heart]) {
      expect(normalizeDisplayName(name)).toBe(name);
    }
  });

  it('drops joiners and variation selectors that are not inside text', () => {
    expect(normalizeDisplayName('‍Jane‌')).toBe('Jane');
    expect(normalizeDisplayName('Jane ‍ Doe')).toBe('Jane Doe');
    expect(normalizeDisplayName('Jane️')).toBe('Jane');
    expect(normalizeDisplayName('A‍‍B')).toBe('AB');
  });

  it('accepts exactly 100 characters and refuses 101, counting an emoji as one', () => {
    expect(normalizeDisplayName('a'.repeat(100))).toBe('a'.repeat(100));
    expect(normalizeDisplayName('a'.repeat(101))).toBeNull();
    expect(normalizeDisplayName('😀'.repeat(100))).toBe('😀'.repeat(100));
  });

  it('counts what a person sees as one character: 100 flags or family emoji fit, 101 do not', () => {
    expect(normalizeDisplayName('🇻🇳'.repeat(100))).not.toBeNull();
    expect(normalizeDisplayName('🇻🇳'.repeat(101))).toBeNull();
  });

  it('refuses a name that looks short but would not fit in the column (too many code points)', () => {
    // 40 family emoji = 40 characters to a reader, but 200+ code points
    const heavy = '👨‍👩‍👧‍👦'.repeat(40);
    expect(normalizeDisplayName(heavy)).toBeNull();
    expect(normalizeDisplayName('👨‍👩‍👧‍👦'.repeat(10))).not.toBeNull();
  });

  it('measures the length after cleaning, not before', () => {
    const padded = ' '.repeat(50) + 'a'.repeat(100) + ' '.repeat(50);
    expect(normalizeDisplayName(padded)).toBe('a'.repeat(100));
  });
});
