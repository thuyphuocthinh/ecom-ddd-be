import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { TokenStore } from './token.store.js';
import type { RedisService } from '../redis/redis.service.js';
import { CACHE } from '../cache/cache.constants.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('TokenStore', () => {
  let store: TokenStore;
  let client: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    incr: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    client = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      eval: vi.fn(),
    };
    store = new TokenStore({
      getClient: () => client,
    } as unknown as RedisService);
  });

  describe('Redis failures are never swallowed (a silent failure = revoked token treated as valid)', () => {
    const down = new Error('ECONNREFUSED');

    it('isAccessTokenBlacklisted rejects instead of answering "not blacklisted"', async () => {
      client.get.mockRejectedValue(down);
      await expect(store.isAccessTokenBlacklisted('at')).rejects.toThrow(
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

    it('blacklistAccessToken rejects so logout cannot report success without writing', async () => {
      client.set.mockRejectedValue(down);
      await expect(store.blacklistAccessToken('at', 60)).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    it('storeRefreshToken rejects so login cannot hand out an RT that was never stored', async () => {
      client.set.mockRejectedValue(down);
      await expect(store.storeRefreshToken('rt', 'u1', 0, 60)).rejects.toThrow(
        'ECONNREFUSED',
      );
    });
  });

  describe('basic operations', () => {
    it('getTokenVersion defaults to 0 when nothing is stored', async () => {
      client.get.mockResolvedValue(null);
      await expect(store.getTokenVersion('u1')).resolves.toBe(0);
    });

    it('stores only the sha256 of a refresh token, never the raw token', async () => {
      await store.storeRefreshToken('raw-rt', 'u1', 2, 600);

      const [key, value, mode, ttl] = client.set.mock.calls[0];
      expect(key).toBe(CACHE.AUTH.KEYS.REFRESH_TOKEN(sha256('raw-rt')));
      expect(key).not.toContain('raw-rt');
      expect(JSON.parse(value)).toEqual({ userId: 'u1', version: 2 });
      expect([mode, ttl]).toEqual(['EX', 600]);
    });
  });

  describe('rotateRefreshToken', () => {
    const params = {
      oldRefreshToken: 'old-rt',
      newRefreshToken: 'new-rt',
      userId: 'u1',
      version: 3,
      ttl: 604800,
      newTokens: { accessToken: 'new.at', refreshToken: 'new-rt' },
    };

    it('runs one atomic script over old RT, new RT and grace keys', async () => {
      client.eval.mockResolvedValue(1);

      await expect(store.rotateRefreshToken(params)).resolves.toBe(true);

      const args = client.eval.mock.calls[0];
      expect(args[1]).toBe(3);
      expect(args.slice(2, 5)).toEqual([
        CACHE.AUTH.KEYS.REFRESH_TOKEN(sha256('old-rt')),
        CACHE.AUTH.KEYS.REFRESH_TOKEN(sha256('new-rt')),
        CACHE.AUTH.KEYS.ROTATION_GRACE(sha256('old-rt')),
      ]);
      expect(JSON.parse(args[5])).toEqual({ userId: 'u1', version: 3 });
      expect(args[6]).toBe(604800);
      expect(args[8]).toBe(CACHE.AUTH.SETTINGS.ROTATION_GRACE_TTL);
    });

    it('returns false when the old RT was already rotated by a concurrent request', async () => {
      client.eval.mockResolvedValue(0);
      await expect(store.rotateRefreshToken(params)).resolves.toBe(false);
    });

    it('rejects if Redis is unreachable', async () => {
      client.eval.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(store.rotateRefreshToken(params)).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    describe('grace entry', () => {
      const rotateAndCapture = async () => {
        client.eval.mockResolvedValue(1);
        await store.rotateRefreshToken(params);
        return client.eval.mock.calls[0][7] as string;
      };

      it('is readable by the holder of the old RT', async () => {
        client.get.mockResolvedValue(await rotateAndCapture());

        await expect(store.getRotationGrace('old-rt')).resolves.toEqual(
          params.newTokens,
        );
      });

      it('never contains the new tokens in plain text', async () => {
        const stored = await rotateAndCapture();

        expect(stored).not.toContain('new.at');
        expect(stored).not.toContain('new-rt');
        expect(Buffer.from(stored, 'base64').toString('utf8')).not.toContain(
          'new.at',
        );
      });

      it('cannot be decrypted with a different RT (e.g. someone who only has a Redis dump)', async () => {
        client.get.mockResolvedValue(await rotateAndCapture());

        await expect(
          store.getRotationGrace('some-other-rt'),
        ).resolves.toBeNull();
      });

      it('returns null for a tampered entry', async () => {
        const stored = await rotateAndCapture();
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
});
