import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import { CACHE } from '@/core/infrastructure/cache/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { OtpPurpose } from '../../domain/index.js';
import { orServiceUnavailable } from './redis-failure.js';

// Allow a send only when the cooldown has passed and the hourly allowance is not used up.
// Both counters are keyed by the address, whether or not an account exists for it, and
// updated in one step, so concurrent requests can't slip past either limit.
// Replies { status, seconds }: status 1 = reserved, 0 = still in cooldown, -1 = hourly limit
// reached; seconds = how long until a new attempt can succeed (0 when reserved).
const RESERVE_SEND_SCRIPT = `
  local function wait_seconds(key)
    local ttl = redis.call("TTL", key)
    if ttl < 1 then
      return 1
    end
    return ttl
  end
  if redis.call("EXISTS", KEYS[1]) == 1 then
    return { 0, wait_seconds(KEYS[1]) }
  end
  local sent = redis.call("INCR", KEYS[2])
  if sent == 1 then
    redis.call("EXPIRE", KEYS[2], ARGV[3])
  end
  if sent > tonumber(ARGV[2]) then
    return { -1, wait_seconds(KEYS[2]) }
  end
  redis.call("SET", KEYS[1], "1", "EX", ARGV[1])
  return { 1, 0 }
`;

// Replace any previous code: the new one starts with zero wrong guesses.
const SAVE_CODE_SCRIPT = `
  redis.call("DEL", KEYS[1])
  redis.call("HSET", KEYS[1], "hash", ARGV[1], "attempts", 0)
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  return 1
`;

// Count this guess and hand back the stored hash, or nothing if there is no live code.
// The guess that goes over the limit destroys the code instead of being compared.
const COUNT_ATTEMPT_SCRIPT = `
  local hash = redis.call("HGET", KEYS[1], "hash")
  if not hash then
    return false
  end
  local attempts = redis.call("HINCRBY", KEYS[1], "attempts", 1)
  if attempts > tonumber(ARGV[1]) then
    redis.call("DEL", KEYS[1])
    return false
  end
  return { hash, attempts }
`;

export type SendReservation = 'RESERVED' | 'COOLDOWN' | 'LIMIT';

export interface SendReservationResult {
  status: SendReservation;
  /** Seconds until another send can be reserved; 0 when this one was reserved. */
  retryAfterSeconds: number;
}

/**
 * Redis state of one-time codes: the keyed hash of the code, its wrong-guess counter,
 * and the send cooldown/allowance. It never sees a raw code. Every method rejects
 * (as a 503) when Redis fails.
 */
@Injectable()
export class OtpStore {
  private readonly logger = new Logger(OtpStore.name);

  constructor(private readonly redis: RedisService) {}

  private get client(): Redis {
    return this.redis.getClient();
  }

  // Keys carry a hash of the address, so the address itself never sits in Redis keys
  private subject(email: string): string {
    return HashUtil.sha256(email);
  }

  async reserveSend(
    purpose: OtpPurpose,
    email: string,
  ): Promise<SendReservationResult> {
    const subject = this.subject(email);
    const result = await orServiceUnavailable(this.logger, () =>
      this.client.eval(
        RESERVE_SEND_SCRIPT,
        2,
        CACHE.AUTH.KEYS.OTP_COOLDOWN(purpose, subject),
        CACHE.AUTH.KEYS.OTP_SENT(purpose, subject),
        CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
        CACHE.AUTH.SETTINGS.OTP_MAX_SENDS_PER_HOUR,
        CACHE.AUTH.SETTINGS.OTP_SENDS_WINDOW,
      ),
    );
    const [code, seconds] = result as [number, number];
    if (code === 1) return { status: 'RESERVED', retryAfterSeconds: 0 };
    return {
      status: code === 0 ? 'COOLDOWN' : 'LIMIT',
      retryAfterSeconds: Number(seconds),
    };
  }

  async saveCode(
    purpose: OtpPurpose,
    email: string,
    codeHash: string,
  ): Promise<void> {
    await orServiceUnavailable(this.logger, () =>
      this.client.eval(
        SAVE_CODE_SCRIPT,
        1,
        CACHE.AUTH.KEYS.OTP(purpose, this.subject(email)),
        codeHash,
        CACHE.AUTH.SETTINGS.OTP_TTL,
      ),
    );
  }

  async fetchAndCountAttempt(
    purpose: OtpPurpose,
    email: string,
  ): Promise<{ hash: string; attempts: number } | null> {
    const result = await orServiceUnavailable(this.logger, () =>
      this.client.eval(
        COUNT_ATTEMPT_SCRIPT,
        1,
        CACHE.AUTH.KEYS.OTP(purpose, this.subject(email)),
        CACHE.AUTH.SETTINGS.OTP_MAX_ATTEMPTS,
      ),
    );
    if (!Array.isArray(result)) return null;
    return { hash: String(result[0]), attempts: Number(result[1]) };
  }

  /**
   * Uses the code up. `true` for exactly one caller: of several concurrent
   * redemptions of the same correct code, only one gets to create the account.
   */
  async consume(purpose: OtpPurpose, email: string): Promise<boolean> {
    const deleted = await orServiceUnavailable(this.logger, () =>
      this.client.del(CACHE.AUTH.KEYS.OTP(purpose, this.subject(email))),
    );
    return deleted === 1;
  }

  async invalidate(purpose: OtpPurpose, email: string): Promise<void> {
    await this.consume(purpose, email);
  }
}
