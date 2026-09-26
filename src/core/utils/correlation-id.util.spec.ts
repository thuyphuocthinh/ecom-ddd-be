import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveCorrelationId } from './correlation-id.util.js';

function reqWith(header: string | string[] | undefined): Request {
  return { headers: { 'x-correlation-id': header } } as unknown as Request;
}

describe('resolveCorrelationId', () => {
  it('reuses a well-formed correlation id from the request header', () => {
    const id = resolveCorrelationId(reqWith('abc-123-XYZ'));
    expect(id).toBe('abc-123-XYZ');
  });

  it('generates a fresh id when the header is missing', () => {
    const id = resolveCorrelationId(reqWith(undefined));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates a fresh id when the header contains unsafe characters', () => {
    const id = resolveCorrelationId(reqWith('bad\nvalue'));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates a fresh id when the header is unreasonably long', () => {
    const id = resolveCorrelationId(reqWith('a'.repeat(100)));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
