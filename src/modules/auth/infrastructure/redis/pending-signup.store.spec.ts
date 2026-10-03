import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { PendingSignupStore } from './pending-signup.store.js';
import type { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import { CACHE } from '@/core/infrastructure/cache/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';

const EMAIL = 'new@example.com';
const KEY = CACHE.AUTH.KEYS.PENDING_SIGNUP(HashUtil.sha256(EMAIL));
const SIGNUP = { passwordHash: '$argon2id$hash', displayName: 'Jane' };

describe('PendingSignupStore', () => {
  let store: PendingSignupStore;
  let client: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    client = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
    };
    store = new PendingSignupStore({
      getClient: () => client,
    } as unknown as RedisService);
  });

  it('saves the registration under a key made from a hash of the address, with a lifetime', async () => {
    await store.save(EMAIL, SIGNUP);

    const [key, value, mode, ttl] = client.set.mock.calls[0];
    expect(key).toBe(KEY);
    expect(key).not.toContain(EMAIL);
    expect(JSON.parse(value)).toEqual(SIGNUP);
    expect([mode, ttl]).toEqual(['EX', CACHE.AUTH.SETTINGS.PENDING_SIGNUP_TTL]);
  });

  it('reads it back', async () => {
    client.get.mockResolvedValue(JSON.stringify(SIGNUP));

    await expect(store.get(EMAIL)).resolves.toEqual(SIGNUP);
    expect(client.get).toHaveBeenCalledWith(KEY);
  });

  it('returns null when nothing is waiting for the address', async () => {
    client.get.mockResolvedValue(null);

    await expect(store.get(EMAIL)).resolves.toBeNull();
  });

  it('deletes it', async () => {
    await store.delete(EMAIL);

    expect(client.del).toHaveBeenCalledWith(KEY);
  });

  it('answers 503 when Redis fails, rather than looking like "nothing waiting" (AC-13)', async () => {
    const down = new Error('ECONNREFUSED');
    client.set.mockRejectedValue(down);
    client.get.mockRejectedValue(down);
    client.del.mockRejectedValue(down);

    await expect(store.save(EMAIL, SIGNUP)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(store.get(EMAIL)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(store.delete(EMAIL)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
