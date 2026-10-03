import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallHandler, ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import { of } from 'rxjs';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import { RateLimitService } from '../../infrastructure/redis/rate-limit/rate-limit.service.js';
import { CACHE } from '../../infrastructure/redis/cache.constants.js';

const makeContext = (req: object) =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => {},
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const makeRequest = (overrides: object = {}) => ({
  ip: '1.1.1.1',
  path: '/auth/login?x=1',
  route: { path: '/auth/login' },
  socket: { remoteAddress: '9.9.9.9' },
  ...overrides,
});

const bucket = (identifier: string) =>
  CACHE.RATE_LIMIT.KEYS.BUCKET('/auth/login', identifier);

describe('RateLimitInterceptor', () => {
  let interceptor: RateLimitInterceptor;
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };
  let service: { isAllowed: ReturnType<typeof vi.fn> };
  let next: CallHandler;

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() };
    service = { isAllowed: vi.fn().mockResolvedValue(true) };
    next = { handle: vi.fn().mockReturnValue(of('handled')) };
    interceptor = new RateLimitInterceptor(
      reflector as unknown as Reflector,
      service as unknown as RateLimitService,
    );
  });

  it('passes through without touching Redis when the route has no @RateLimit', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await interceptor.intercept(makeContext(makeRequest()), next);

    expect(service.isAllowed).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('calls the handler while under the limit, bucketed by route pattern + IP by default', async () => {
    reflector.getAllAndOverride.mockReturnValue({ limit: 5, window: 900 });

    await interceptor.intercept(makeContext(makeRequest()), next);

    expect(service.isAllowed).toHaveBeenCalledWith(
      bucket('ip:1.1.1.1'),
      5,
      900,
    );
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('throws 429 and does not call the handler when the limit is exceeded', async () => {
    reflector.getAllAndOverride.mockReturnValue({ limit: 5, window: 900 });
    service.isAllowed.mockResolvedValue(false);

    await expect(
      interceptor.intercept(makeContext(makeRequest()), next),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('falls back to the socket address when request.ip is missing', async () => {
    reflector.getAllAndOverride.mockReturnValue({ limit: 5, window: 900 });

    await interceptor.intercept(
      makeContext(makeRequest({ ip: undefined })),
      next,
    );

    expect(service.isAllowed).toHaveBeenCalledWith(
      bucket('ip:9.9.9.9'),
      5,
      900,
    );
  });

  it('never uses the raw URL (query string) in the bucket key', async () => {
    reflector.getAllAndOverride.mockReturnValue({ limit: 5, window: 900 });

    await interceptor.intercept(makeContext(makeRequest()), next);

    expect(service.isAllowed.mock.calls[0][0]).not.toContain('?x=1');
  });

  describe('key', () => {
    it("'user' counts against the authenticated user id", async () => {
      reflector.getAllAndOverride.mockReturnValue({
        limit: 5,
        window: 60,
        key: 'user',
      });

      await interceptor.intercept(
        makeContext(makeRequest({ user: { id: 'u1' } })),
        next,
      );

      expect(service.isAllowed).toHaveBeenCalledWith(bucket('user:u1'), 5, 60);
    });

    it("'user' falls back to IP on a public route", async () => {
      reflector.getAllAndOverride.mockReturnValue({
        limit: 5,
        window: 60,
        key: 'user',
      });

      await interceptor.intercept(makeContext(makeRequest()), next);

      expect(service.isAllowed).toHaveBeenCalledWith(
        bucket('ip:1.1.1.1'),
        5,
        60,
      );
    });

    it('a custom function is hashed so e.g. an email never lands in Redis as plain text', async () => {
      const custom = (req: any) => `${req.ip}:${req.body.email}`;
      reflector.getAllAndOverride.mockReturnValue({
        limit: 5,
        window: 60,
        key: custom,
      });

      await interceptor.intercept(
        makeContext(makeRequest({ body: { email: 'a@b.com' } })),
        next,
      );

      const hash = createHash('sha256').update('1.1.1.1:a@b.com').digest('hex');
      expect(service.isAllowed).toHaveBeenCalledWith(
        bucket(`key:${hash}`),
        5,
        60,
      );
      expect(service.isAllowed.mock.calls[0][0]).not.toContain('a@b.com');
    });

    it('a custom function returning undefined falls back to IP', async () => {
      reflector.getAllAndOverride.mockReturnValue({
        limit: 5,
        window: 60,
        key: () => undefined,
      });

      await interceptor.intercept(makeContext(makeRequest()), next);

      expect(service.isAllowed).toHaveBeenCalledWith(
        bucket('ip:1.1.1.1'),
        5,
        60,
      );
    });
  });

  it('fails open when Redis is unavailable', async () => {
    reflector.getAllAndOverride.mockReturnValue({ limit: 5, window: 900 });
    service.isAllowed.mockRejectedValue(new Error('ECONNREFUSED'));

    await interceptor.intercept(makeContext(makeRequest()), next);

    expect(next.handle).toHaveBeenCalledOnce();
  });
});
