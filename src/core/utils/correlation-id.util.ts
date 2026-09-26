import { randomUUID } from 'crypto';
import type { Request } from 'express';

// Correlation ids are trusted to appear verbatim in logs and error
// responses, so an incoming x-correlation-id is only reused when it looks
// like a genuine id (letters/digits/hyphen, bounded length) — anything
// else (control characters, absurd lengths) falls back to a fresh UUID
// instead of being logged as-is.
const CORRELATION_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

export function resolveCorrelationId(req: Request): string {
  const header = req.headers['x-correlation-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && CORRELATION_ID_PATTERN.test(value) ? value : randomUUID();
}
