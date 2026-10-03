import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { OtpStore } from './otp.store.js';
import type { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';

const EMAIL = 'new@example.com';
const SUBJECT = HashUtil.sha256(EMAIL);
const CLIENT = '203.0.113.7';

describe('OtpStore', () => {
  let store: OtpStore;
  let client: {
    eval: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    client = { eval: vi.fn(), del: vi.fn() };
    store = new OtpStore({
      getClient: () => client,
    } as unknown as RedisService);
  });

  describe('reserveSend', () => {
    it.each([
      [[1, 0], 'RESERVED', 0],
      [[0, 240], 'COOLDOWN', 240],
      [[-1, 1800], 'LIMIT', 1800],
    ])(
      'maps the script result %j to %s and reports the wait',
      async (result, status, retryAfterSeconds) => {
        client.eval.mockResolvedValue(result);

        await expect(
          store.reserveSend('REGISTER_EMAIL', EMAIL),
        ).resolves.toEqual({ status, retryAfterSeconds });
      },
    );

    it('runs one atomic script over the cooldown and the hourly counter of that address', async () => {
      client.eval.mockResolvedValue([1, 0]);

      await store.reserveSend('REGISTER_EMAIL', EMAIL);

      const args = client.eval.mock.calls[0];
      expect(args[1]).toBe(2);
      expect(args.slice(2, 4)).toEqual([
        CACHE.AUTH.KEYS.OTP_COOLDOWN('REGISTER_EMAIL', SUBJECT),
        CACHE.AUTH.KEYS.OTP_SENT('REGISTER_EMAIL', SUBJECT),
      ]);
      expect(args.slice(4)).toEqual([
        CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
        CACHE.AUTH.SETTINGS.OTP_MAX_SENDS_PER_HOUR,
        CACHE.AUTH.SETTINGS.OTP_SENDS_WINDOW,
      ]);
    });

    it('keeps the address itself out of every Redis key', async () => {
      client.eval.mockResolvedValue([1, 0]);

      await store.reserveSend('REGISTER_EMAIL', EMAIL);

      expect(JSON.stringify(client.eval.mock.calls[0].slice(1))).not.toContain(
        EMAIL,
      );
    });
  });

  describe('saveCode', () => {
    it('stores the hash with the code lifetime under the address key', async () => {
      client.eval.mockResolvedValue(1);

      await store.saveCode('REGISTER_EMAIL', EMAIL, 'hash-of-code');

      const args = client.eval.mock.calls[0];
      expect(args[2]).toBe(CACHE.AUTH.KEYS.OTP('REGISTER_EMAIL', SUBJECT));
      expect(args[3]).toBe('hash-of-code');
      expect(args[4]).toBe(CACHE.AUTH.SETTINGS.OTP_TTL);
    });
  });

  describe('releaseSend', () => {
    it('runs one script over the cooldown and the hourly counter of that address', async () => {
      client.eval.mockResolvedValue(1);

      await store.releaseSend('REGISTER_EMAIL', EMAIL);

      const args = client.eval.mock.calls[0];
      expect(args[1]).toBe(2);
      expect(args.slice(2)).toEqual([
        CACHE.AUTH.KEYS.OTP_COOLDOWN('REGISTER_EMAIL', SUBJECT),
        CACHE.AUTH.KEYS.OTP_SENT('REGISTER_EMAIL', SUBJECT),
      ]);
    });
  });

  describe('fetchAndCountAttempt', () => {
    it('returns the stored hash and the client attempt number', async () => {
      client.eval.mockResolvedValue(['hash-of-code', 2, 7]);

      await expect(
        store.fetchAndCountAttempt('REGISTER_EMAIL', EMAIL, CLIENT),
      ).resolves.toEqual({ hash: 'hash-of-code', attempts: 2 });
    });

    it('passes both limits and a hash of the client, never the raw IP', async () => {
      client.eval.mockResolvedValue(['hash-of-code', 1, 1]);

      await store.fetchAndCountAttempt('REGISTER_EMAIL', EMAIL, CLIENT);

      const args = client.eval.mock.calls[0];
      expect(args.slice(3)).toEqual([
        CACHE.AUTH.SETTINGS.OTP_MAX_ATTEMPTS,
        CACHE.AUTH.SETTINGS.OTP_MAX_ATTEMPTS_TOTAL,
        HashUtil.sha256(CLIENT),
      ]);
      expect(JSON.stringify(args)).not.toContain(CLIENT);
    });

    it('returns null when there is no live code, the client is locked out or the total was passed', async () => {
      client.eval.mockResolvedValue(null);

      await expect(
        store.fetchAndCountAttempt('REGISTER_EMAIL', EMAIL, CLIENT),
      ).resolves.toBeNull();
    });
  });

  describe('consume', () => {
    it('is true only when this call actually deleted the code (one winner)', async () => {
      client.del.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      await expect(store.consume('REGISTER_EMAIL', EMAIL)).resolves.toBe(true);
      await expect(store.consume('REGISTER_EMAIL', EMAIL)).resolves.toBe(false);
      expect(client.del).toHaveBeenCalledWith(
        CACHE.AUTH.KEYS.OTP('REGISTER_EMAIL', SUBJECT),
      );
    });
  });

  describe('when Redis fails (AC-13)', () => {
    const down = new Error('ECONNREFUSED');

    it('answers 503 instead of pretending there was no code', async () => {
      client.eval.mockRejectedValue(down);
      client.del.mockRejectedValue(down);

      await expect(
        store.reserveSend('REGISTER_EMAIL', EMAIL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        store.saveCode('REGISTER_EMAIL', EMAIL, 'h'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        store.fetchAndCountAttempt('REGISTER_EMAIL', EMAIL, CLIENT),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        store.releaseSend('REGISTER_EMAIL', EMAIL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        store.consume('REGISTER_EMAIL', EMAIL),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
