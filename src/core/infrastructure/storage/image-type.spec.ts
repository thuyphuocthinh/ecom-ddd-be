import { describe, it, expect } from 'vitest';
import { detectImageType } from './image-type.js';

const bytes = (...values: number[]) => Buffer.from(values);
const ascii = (text: string) => Buffer.from(text, 'latin1');

describe('detectImageType', () => {
  it('recognises JPEG, PNG and WebP by their first bytes', () => {
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe(
      'jpeg',
    );
    expect(
      detectImageType(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0),
      ),
    ).toBe('png');
    expect(
      detectImageType(
        Buffer.concat([ascii('RIFF'), bytes(10, 0, 0, 0), ascii('WEBPVP8 ')]),
      ),
    ).toBe('webp');
  });

  it.each([
    ['text renamed to .png', ascii('hello, I am not a picture')],
    [
      'SVG (it can carry scripts)',
      ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ],
    ['GIF', ascii('GIF89a......')],
    ['PDF', ascii('%PDF-1.7 ...')],
    ['a Windows program', ascii('MZ......')],
    ['an HTML page', ascii('<html><script>alert(1)</script>')],
    [
      'RIFF that is not WebP (a WAV sound)',
      Buffer.concat([ascii('RIFF'), bytes(10, 0, 0, 0), ascii('WAVEfmt ')]),
    ],
    ['a PNG cut inside its signature', bytes(0x89, 0x50, 0x4e, 0x47)],
    ['two bytes of a JPEG', bytes(0xff, 0xd8)],
    ['nothing', Buffer.alloc(0)],
  ])('refuses %s', (_name, content) => {
    expect(detectImageType(content)).toBeNull();
  });

  it('does not read past the end of a short RIFF header', () => {
    expect(detectImageType(ascii('RIFF1234WEB'))).toBeNull();
  });
});
