import { describe, it, expect } from 'vitest';
import { ExecutionContext, PayloadTooLargeException } from '@nestjs/common';
import { MaxBodySizeGuard } from './max-body-size.guard.js';

const contextWith = (headers: Record<string, string>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe('MaxBodySizeGuard', () => {
  const guard = new (MaxBodySizeGuard(1000))();

  it('lets a request through that announces a size within the limit, exactly at it included', () => {
    expect(guard.canActivate(contextWith({ 'content-length': '10' }))).toBe(
      true,
    );
    expect(guard.canActivate(contextWith({ 'content-length': '1000' }))).toBe(
      true,
    );
  });

  it('refuses with 413, before anything is read, a request that announces more', () => {
    expect(() =>
      guard.canActivate(contextWith({ 'content-length': '1001' })),
    ).toThrow(PayloadTooLargeException);
  });

  it('lets a request through that announces no size (the upload limits still apply to it)', () => {
    expect(guard.canActivate(contextWith({}))).toBe(true);
  });

  it('lets a request through whose size is not a number (it is the upload limits that handle it)', () => {
    expect(guard.canActivate(contextWith({ 'content-length': 'abc' }))).toBe(
      true,
    );
  });

  it('each limit is its own: two guards do not share their number', () => {
    const small = new (MaxBodySizeGuard(5))();
    expect(() =>
      small.canActivate(contextWith({ 'content-length': '6' })),
    ).toThrow();
    expect(guard.canActivate(contextWith({ 'content-length': '6' }))).toBe(
      true,
    );
  });
});
