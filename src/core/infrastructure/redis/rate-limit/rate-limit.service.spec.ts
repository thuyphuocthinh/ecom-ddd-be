import { describe, it, expect, vi } from 'vitest';
import { RateLimitService } from './rate-limit.service.js';
import type { RedisService } from '../redis.service.js';

const serviceReturning = (count: number | Error) => {
  const evalFn = vi.fn();
  if (count instanceof Error) evalFn.mockRejectedValue(count);
  else evalFn.mockResolvedValue(count);
  const service = new RateLimitService({
    getClient: () => ({ eval: evalFn }),
  } as unknown as RedisService);
  return { service, evalFn };
};

describe('RateLimitService.isAllowed', () => {
  // limit = 5 means "5 requests allowed, the 6th is blocked" (spec SC-5).
  // `count <= limit` — NOT `count >= limit`, which would block the 5th request.
  it.each([1, 2, 3, 4, 5])('allows hit number %i of 5', async (count) => {
    const { service } = serviceReturning(count);
    await expect(service.isAllowed('k', 5, 900)).resolves.toBe(true);
  });

  it.each([6, 7, 100])('blocks hit number %i of 5', async (count) => {
    const { service } = serviceReturning(count);
    await expect(service.isAllowed('k', 5, 900)).resolves.toBe(false);
  });

  it('sends the bucket key and window to the atomic script', async () => {
    const { service, evalFn } = serviceReturning(1);

    await service.isAllowed('bucket-key', 3, 3600);

    const [script, numKeys, key, window] = evalFn.mock.calls[0];
    expect(script).toContain('INCR');
    expect(script).toContain('EXPIRE');
    expect([numKeys, key, window]).toEqual([1, 'bucket-key', 3600]);
  });

  it('rejects when Redis fails, so the caller decides whether to fail open', async () => {
    const { service } = serviceReturning(new Error('ECONNREFUSED'));
    await expect(service.isAllowed('k', 5, 900)).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});
