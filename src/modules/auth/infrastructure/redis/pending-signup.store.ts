import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import { CACHE } from '@/core/infrastructure/cache/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import { orServiceUnavailable } from './redis-failure.js';

export interface PendingSignup {
  /** argon2 hash — the password itself is never stored. */
  passwordHash: string;
  displayName: string | null;
}

/**
 * A registration that has not been confirmed by email yet. It is not an account:
 * it lives only in Redis and is turned into one when the right code is entered.
 * A newer registration for the same address replaces the older one.
 */
@Injectable()
export class PendingSignupStore {
  private readonly logger = new Logger(PendingSignupStore.name);

  constructor(private readonly redis: RedisService) {}

  private get client(): Redis {
    return this.redis.getClient();
  }

  private key(email: string): string {
    return CACHE.AUTH.KEYS.PENDING_SIGNUP(HashUtil.sha256(email));
  }

  async save(email: string, signup: PendingSignup): Promise<void> {
    await orServiceUnavailable(this.logger, () =>
      this.client.set(
        this.key(email),
        JSON.stringify(signup),
        'EX',
        CACHE.AUTH.SETTINGS.PENDING_SIGNUP_TTL,
      ),
    );
  }

  async get(email: string): Promise<PendingSignup | null> {
    const raw = await orServiceUnavailable(this.logger, () =>
      this.client.get(this.key(email)),
    );
    return raw ? (JSON.parse(raw) as PendingSignup) : null;
  }

  async delete(email: string): Promise<void> {
    await orServiceUnavailable(this.logger, () =>
      this.client.del(this.key(email)),
    );
  }
}
