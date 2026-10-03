import type { ImageType } from './image-storage.port.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((value, index) => bytes[offset + index] === value);

const asciiAt = (bytes: Buffer, offset: number, text: string) =>
  bytes.length >= offset + text.length &&
  bytes.toString('latin1', offset, offset + text.length) === text;

/**
 * What kind of image these bytes are, from the first bytes of the file, or null when it is none
 * of the accepted kinds. The file name and the Content-Type are written by whoever sends the
 * file, so they prove nothing. SVG is left out on purpose: it can carry scripts.
 */
export function detectImageType(bytes: Buffer): ImageType | null {
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  // WebP is "RIFF", four bytes of size, then "WEBP"
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'webp';
  return null;
}
