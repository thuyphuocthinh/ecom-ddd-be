import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { GoogleTokenStore } from './google-token.store.js';
import type { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';

describe('GoogleTokenStore', () => {
  let set: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let store: GoogleTokenStore;
  const NOW = new Date('2026-10-04T10:00:00Z');
  const expires = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

  beforeEach(() => {
    set = vi.fn().mockResolvedValue('OK');
    del = vi.fn().mockResolvedValue(1);
    store = new GoogleTokenStore({
      getClient: () => ({ set, del }),
    } as unknown as RedisService);
  });

  it('is true the first time a token is seen, using SET NX so only one caller wins (AC-6)', async () => {
    await expect(store.claim('tok', expires(600), NOW)).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith(
      CACHE.AUTH.KEYS.GOOGLE_TOKEN(HashUtil.sha256('tok')),
      '1',
      'EX',
      660,
      'NX',
    );
  });

  it('is false when the token was seen before (Redis answers null for NX that did not set)', async () => {
    set.mockResolvedValue(null);

    await expect(store.claim('tok', expires(600), NOW)).resolves.toBe(false);
  });

  it('keeps a token only until it expires plus a minute, and for at least a second', async () => {
    await store.claim('tok', expires(3600), NOW);
    expect(set.mock.calls[0][3]).toBe(3660);

    await store.claim('tok2', expires(-500), NOW);
    expect(set.mock.calls[1][3]).toBe(1);
  });

  it('never puts the token itself in Redis, only its hash (AC-15)', async () => {
    await store.claim('very-secret-token', expires(600), NOW);

    expect(JSON.stringify(set.mock.calls)).not.toContain('very-secret-token');
  });

  it('gives a token back by deleting its mark, so it can be used again after a failure that was not the person fault', async () => {
    await store.release('tok');

    expect(del).toHaveBeenCalledWith(
      CACHE.AUTH.KEYS.GOOGLE_TOKEN(HashUtil.sha256('tok')),
    );
  });

  it('never throws when giving a token back fails: the original error matters more', async () => {
    del.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(store.release('tok')).resolves.toBeUndefined();
  });

  it('answers 503 when Redis fails, rather than letting the token through (AC-14)', async () => {
    set.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(store.claim('tok', expires(600), NOW)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
