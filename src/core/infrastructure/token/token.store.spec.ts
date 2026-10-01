import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { TokenStore } from './token.store.js';
import type { RedisService } from '../redis/redis.service.js';
import { CACHE } from '../cache/cache.constants.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('TokenStore', () => {
  let store: TokenStore;
  let pipeline: {
    set: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
  let client: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    incr: ReturnType<typeof vi.fn>;
    pipeline: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    pipeline = {
      set: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 'OK']]),
    };
    client = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      incr: vi.fn().mockResolvedValue(1),
      pipeline: vi.fn().mockReturnValue(pipeline),
    };
    store = new TokenStore({
      getClient: () => client,
    } as unknown as RedisService);
  });

  describe('Redis failures are never swallowed (a silent failure = revoked session treated as valid)', () => {
    const down = new Error('ECONNREFUSED');

    it('isSessionRevoked rejects instead of answering "not revoked"', async () => {
      client.get.mockRejectedValue(down);
      await expect(store.isSessionRevoked('sid-1')).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    it('getTokenVersion rejects instead of answering 0', async () => {
      client.get.mockRejectedValue(down);
      await expect(store.getTokenVersion('u1')).rejects.toThrow('ECONNREFUSED');
    });

    it('bumpTokenVersion rejects so logout-all cannot report success without writing', async () => {
      client.incr.mockRejectedValue(down);
      await expect(store.bumpTokenVersion('u1')).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    it('markSessionsRevoked rejects when the pipeline cannot run', async () => {
      pipeline.exec.mockRejectedValue(down);
      await expect(store.markSessionsRevoked(['sid-1'], 900)).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    it('markSessionsRevoked rejects when a command inside the pipeline failed (exec() itself resolves)', async () => {
      pipeline.exec.mockResolvedValue([
        [null, 'OK'],
        [down, null],
      ]);
      await expect(
        store.markSessionsRevoked(['sid-1', 'sid-2'], 900),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('setRotationGrace rejects so a rotation cannot report success without a grace entry', async () => {
      client.set.mockRejectedValue(down);
      await expect(
        store.setRotationGrace('old-rt', {
          accessToken: 'new.at',
          refreshToken: 'new-rt',
        }),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('token version', () => {
    it('defaults to 0 when nothing is stored', async () => {
      client.get.mockResolvedValue(null);
      await expect(store.getTokenVersion('u1')).resolves.toBe(0);
    });

    it('reads the stored number', async () => {
      client.get.mockResolvedValue('4');
      await expect(store.getTokenVersion('u1')).resolves.toBe(4);
    });
  });

  describe('session revocation flag', () => {
    it('flags every given session with the given TTL in one pipeline', async () => {
      await store.markSessionsRevoked(['sid-1', 'sid-2'], 900);

      expect(pipeline.set).toHaveBeenCalledTimes(2);
      expect(pipeline.set).toHaveBeenCalledWith(
        CACHE.AUTH.KEYS.SESSION_REVOKED('sid-1'),
        '1',
        'EX',
        900,
      );
      expect(pipeline.set).toHaveBeenCalledWith(
        CACHE.AUTH.KEYS.SESSION_REVOKED('sid-2'),
        '1',
        'EX',
        900,
      );
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    it('does not touch Redis when there is nothing to flag', async () => {
      await store.markSessionsRevoked([], 900);
      expect(client.pipeline).not.toHaveBeenCalled();
    });

    it('isSessionRevoked is true only when the flag is set', async () => {
      client.get.mockResolvedValueOnce('1');
      await expect(store.isSessionRevoked('sid-1')).resolves.toBe(true);

      client.get.mockResolvedValueOnce(null);
      await expect(store.isSessionRevoked('sid-2')).resolves.toBe(false);

      expect(client.get).toHaveBeenCalledWith(
        CACHE.AUTH.KEYS.SESSION_REVOKED('sid-1'),
      );
    });
  });

  describe('rotation grace entry', () => {
    const newTokens = { accessToken: 'new.at', refreshToken: 'new-rt' };

    const setAndCapture = async () => {
      await store.setRotationGrace('old-rt', newTokens);
      return client.set.mock.calls[0][1] as string;
    };

    it('is stored under the sha256 of the OLD refresh token with the grace TTL', async () => {
      await store.setRotationGrace('old-rt', newTokens);

      const [key, , mode, ttl] = client.set.mock.calls[0];
      expect(key).toBe(CACHE.AUTH.KEYS.ROTATION_GRACE(sha256('old-rt')));
      expect(key).not.toContain('old-rt');
      expect([mode, ttl]).toEqual([
        'EX',
        CACHE.AUTH.SETTINGS.ROTATION_GRACE_TTL,
      ]);
    });

    it('is readable by the holder of the old RT', async () => {
      client.get.mockResolvedValue(await setAndCapture());

      await expect(store.getRotationGrace('old-rt')).resolves.toEqual(
        newTokens,
      );
    });

    it('never contains the new tokens in plain text', async () => {
      const stored = await setAndCapture();

      expect(stored).not.toContain('new.at');
      expect(stored).not.toContain('new-rt');
      expect(Buffer.from(stored, 'base64').toString('utf8')).not.toContain(
        'new.at',
      );
    });

    it('cannot be decrypted with a different RT (e.g. someone who only has a Redis dump)', async () => {
      client.get.mockResolvedValue(await setAndCapture());

      await expect(store.getRotationGrace('some-other-rt')).resolves.toBeNull();
    });

    it('returns null for a tampered entry', async () => {
      const stored = await setAndCapture();
      const raw = Buffer.from(stored, 'base64');
      raw[raw.length - 1] ^= 0xff;
      client.get.mockResolvedValue(raw.toString('base64'));

      await expect(store.getRotationGrace('old-rt')).resolves.toBeNull();
    });

    it('returns null when there is no grace entry', async () => {
      client.get.mockResolvedValue(null);
      await expect(store.getRotationGrace('old-rt')).resolves.toBeNull();
    });
  });
});
