import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@/core/infrastructure/redis/redis.service.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import { orServiceUnavailable } from './redis-failure.js';

// A little longer than the token lives, so clock differences cannot reopen the door
const EXTRA_SECONDS = 60;

/**
 * Remembers which Google ID tokens were already used, so a token that leaked cannot be played
 * again while it is still valid. Only a hash of the token is kept, and only until it expires.
 * Every call rejects with a 503 when Redis fails: skipping the check would turn an outage into
 * a way around it.
 */
@Injectable()
export class GoogleTokenStore {
  private readonly logger = new Logger(GoogleTokenStore.name);

  constructor(private readonly redis: RedisService) {}

  /** True the first time a token is seen; false when it was used before. `tokenId` comes from what Google signed. */
  async claim(
    tokenId: string,
    expiresAt: Date,
    now = new Date(),
  ): Promise<boolean> {
    const ttl = Math.max(
      1,
      Math.ceil((expiresAt.getTime() - now.getTime()) / 1000) + EXTRA_SECONDS,
    );
    const reply = await orServiceUnavailable(this.logger, () =>
      this.redis
        .getClient()
        .set(
          CACHE.AUTH.KEYS.GOOGLE_TOKEN(HashUtil.sha256(tokenId)),
          '1',
          'EX',
          ttl,
          'NX',
        ),
    );
    return reply === 'OK';
  }

  /**
   * Gives a token back, for when signing in failed AFTER the token was marked used (the database
   * was down, say), so the person can try again with the same token instead of being told it is
   * invalid. Best effort.
   */
  async release(tokenId: string): Promise<void> {
    try {
      await this.redis
        .getClient()
        .del(CACHE.AUTH.KEYS.GOOGLE_TOKEN(HashUtil.sha256(tokenId)));
    } catch (error) {
      this.logger.error(
        `Could not release a Google token: ${(error as Error).name}`,
      );
    }
  }
}
