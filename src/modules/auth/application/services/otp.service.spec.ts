import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OtpService } from './otp.service.js';
import { AuthErrorCodes, CACHE } from '@/core/index.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { OtpStore } from '../../infrastructure/index.js';

const PER_CLIENT = CACHE.AUTH.SETTINGS.OTP_MAX_ATTEMPTS;
const TOTAL = CACHE.AUTH.SETTINGS.OTP_MAX_ATTEMPTS_TOTAL;
const EMAIL = 'new@example.com';
const ME = '203.0.113.7';
const SOMEONE_ELSE = '198.51.100.9';

/**
 * In-memory stand-in for OtpStore that behaves like the Redis scripts do: guesses are
 * counted per client and in total, a client over its own limit is refused without
 * touching the code, the total limit destroys the code, and consuming succeeds once.
 */
class FakeOtpStore {
  codes = new Map<
    string,
    { hash: string; total: number; perClient: Map<string, number> }
  >();
  reservation: 'RESERVED' | 'COOLDOWN' | 'LIMIT' = 'RESERVED';
  released = 0;
  private id = (purpose: string, email: string) => `${purpose}:${email}`;

  async reserveSend() {
    return {
      status: this.reservation,
      retryAfterSeconds: this.reservation === 'RESERVED' ? 0 : 217,
    };
  }
  async releaseSend() {
    this.released += 1;
  }
  async saveCode(purpose: string, email: string, hash: string) {
    this.codes.set(this.id(purpose, email), {
      hash,
      total: 0,
      perClient: new Map(),
    });
  }
  async fetchAndCountAttempt(purpose: string, email: string, client: string) {
    const entry = this.codes.get(this.id(purpose, email));
    if (!entry) return null;
    const mine = entry.perClient.get(client) ?? 0;
    if (mine >= PER_CLIENT) return null;
    entry.total += 1;
    if (entry.total > TOTAL) {
      this.codes.delete(this.id(purpose, email));
      return null;
    }
    entry.perClient.set(client, mine + 1);
    return { hash: entry.hash, attempts: mine + 1 };
  }
  async consume(purpose: string, email: string) {
    return this.codes.delete(this.id(purpose, email));
  }
}

const build = (jwtSecret = 's'.repeat(32)) => {
  const store = new FakeOtpStore();
  const service = new OtpService(
    { jwtSecret } as never,
    store as unknown as OtpStore,
  );
  return { service, store };
};

const wrongFor = (code: string) => (code === '000000' ? '000001' : '000000');

describe('OtpService', () => {
  let service: OtpService;
  let store: FakeOtpStore;

  beforeEach(() => {
    vi.restoreAllMocks();
    ({ service, store } = build());
  });

  describe('issue', () => {
    it('returns a 6-digit code', async () => {
      await expect(service.issue('REGISTER_EMAIL', EMAIL)).resolves.toMatch(
        /^\d{6}$/,
      );
    });

    it('stores only a keyed hash of the code, never the code (AC-11)', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);

      const stored = store.codes.get(`REGISTER_EMAIL:${EMAIL}`)!;
      expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.hash).not.toContain(code);
      expect(JSON.stringify([...store.codes.values()])).not.toContain(
        `"${code}"`,
      );
    });

    it('replaces the previous code and starts the new one with no wrong guesses (AC-5)', async () => {
      vi.spyOn(HashUtil, 'generateOTP')
        .mockReturnValueOnce('111111')
        .mockReturnValueOnce('222222');
      await service.issue('REGISTER_EMAIL', EMAIL);
      await service.verify('REGISTER_EMAIL', EMAIL, '000000', ME);
      await service.issue('REGISTER_EMAIL', EMAIL);

      expect(store.codes.get(`REGISTER_EMAIL:${EMAIL}`)!.total).toBe(0);
      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, '111111', ME),
      ).resolves.toBe(false);
      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, '222222', ME),
      ).resolves.toBe(true);
    });
  });

  describe('verify', () => {
    it('accepts the right code (AC-2)', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);

      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(true);
    });

    it('rejects a wrong code', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);

      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, wrongFor(code), ME),
      ).resolves.toBe(false);
    });

    it('rejects when no code was ever issued for the address (AC-4)', async () => {
      await expect(
        service.verify('REGISTER_EMAIL', 'nobody@example.com', '123456', ME),
      ).resolves.toBe(false);
    });

    it('does not accept the code of one address for another', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);
      // Put the first address's stored hash under another address
      const own = store.codes.get(`REGISTER_EMAIL:${EMAIL}`)!;
      await store.saveCode('REGISTER_EMAIL', 'other@example.com', own.hash);

      await expect(
        service.verify('REGISTER_EMAIL', 'other@example.com', code, ME),
      ).resolves.toBe(false);
      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(true);
    });

    it('binds the stored value to the server secret: another secret computes a different hash', async () => {
      const a = build('a'.repeat(32));
      const b = build('b'.repeat(32));
      const code = await a.service.issue('REGISTER_EMAIL', EMAIL);
      // Copy A's stored hash into B and try the real code there
      const hashFromA = a.store.codes.get(`REGISTER_EMAIL:${EMAIL}`)!.hash;
      await b.store.saveCode('REGISTER_EMAIL', EMAIL, hashFromA);

      await expect(
        b.service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(false);
    });

    it('locks a client out after its own wrong guesses, so even the right code fails for it (AC-3)', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);

      for (let i = 0; i < PER_CLIENT; i++) {
        await service.verify('REGISTER_EMAIL', EMAIL, wrongFor(code), ME);
      }

      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(false);
    });

    it('does not let one client lock the real owner out: another client can still use the code (AC-3)', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);
      for (let i = 0; i < PER_CLIENT; i++) {
        await service.verify(
          'REGISTER_EMAIL',
          EMAIL,
          wrongFor(code),
          SOMEONE_ELSE,
        );
      }

      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(true);
    });

    it('destroys the code once many clients together have guessed too often (AC-3)', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);

      for (let i = 0; i < TOTAL; i++) {
        await service.verify(
          'REGISTER_EMAIL',
          EMAIL,
          wrongFor(code),
          `10.0.0.${i}`,
        );
      }
      // one guess over the total, from yet another client
      await service.verify('REGISTER_EMAIL', EMAIL, wrongFor(code), 'last');

      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(false);
    });

    it('still accepts the right code on the last allowed attempt', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);
      for (let i = 0; i < PER_CLIENT - 1; i++) {
        await service.verify('REGISTER_EMAIL', EMAIL, wrongFor(code), ME);
      }

      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(true);
    });
  });

  describe('consume', () => {
    it('succeeds for exactly one caller (AC-12)', async () => {
      await service.issue('REGISTER_EMAIL', EMAIL);

      const results = await Promise.all([
        service.consume('REGISTER_EMAIL', EMAIL),
        service.consume('REGISTER_EMAIL', EMAIL),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('leaves nothing to verify afterwards (AC-4)', async () => {
      const code = await service.issue('REGISTER_EMAIL', EMAIL);
      await service.consume('REGISTER_EMAIL', EMAIL);

      await expect(
        service.verify('REGISTER_EMAIL', EMAIL, code, ME),
      ).resolves.toBe(false);
    });
  });

  describe('reserveSend', () => {
    it('lets a send through when the store reserves it', async () => {
      await expect(
        service.reserveSend('REGISTER_EMAIL', EMAIL),
      ).resolves.toBeUndefined();
    });

    it.each(['COOLDOWN', 'LIMIT'] as const)(
      'answers 429 when the store says %s, and says how long to wait (AC-5, AC-6)',
      async (reservation) => {
        store.reservation = reservation;

        await expect(
          service.reserveSend('REGISTER_EMAIL', EMAIL),
        ).rejects.toSatisfy(
          (e: any) =>
            e.code === AuthErrorCodes.RATE_LIMIT_EXCEEDED.code &&
            e.details.retryAfterSeconds === 217,
        );
      },
    );
  });

  describe('releaseSend', () => {
    it('gives the slot back (AC-10)', async () => {
      await service.releaseSend('REGISTER_EMAIL', EMAIL);

      expect(store.released).toBe(1);
    });

    it('never throws: failing to give a slot back must not hide the real outcome', async () => {
      store.releaseSend = async () => {
        throw new Error('redis down');
      };

      await expect(
        service.releaseSend('REGISTER_EMAIL', EMAIL),
      ).resolves.toBeUndefined();
    });
  });
});
