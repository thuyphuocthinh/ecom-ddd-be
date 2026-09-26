import { Injectable, ConflictException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

interface IdempotencyRecord<T> {
  status: 'processing' | 'completed';
  response?: T;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class IdempotencyService {
  constructor(private readonly redis: RedisService) {}

  private key(idempotencyKey: string): string {
    return `idempotency:${idempotencyKey}`;
  }

  /**
   * Runs `action` at most once per idempotencyKey within the TTL window.
   * A retry with the same key while the first attempt is still running is
   * rejected (409); a retry after it completed replays the saved response
   * instead of re-running the command. No key means no idempotency check.
   */
  async execute<T>(
    idempotencyKey: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) {
      return action();
    }

    const key = this.key(idempotencyKey);
    // Atomic claim: only the first request for this key gets NX to succeed.
    const claimed = await this.redis
      .getClient()
      .set(
        key,
        JSON.stringify({ status: 'processing' } satisfies IdempotencyRecord<T>),
        'EX',
        IDEMPOTENCY_TTL_SECONDS,
        'NX',
      );

    if (claimed === null) {
      const existingRaw = await this.redis.getClient().get(key);
      const existing = existingRaw
        ? (JSON.parse(existingRaw) as IdempotencyRecord<T>)
        : null;

      if (existing?.status === 'completed') {
        return existing.response as T;
      }
      throw new ConflictException(
        'A request with this Idempotency-Key is already being processed',
      );
    }

    try {
      const response = await action();
      await this.redis.set(
        key,
        { status: 'completed', response } satisfies IdempotencyRecord<T>,
        IDEMPOTENCY_TTL_SECONDS,
      );
      return response;
    } catch (err) {
      // Don't hold the claim for a failed attempt — a retry should be able
      // to try again rather than being stuck behind a dead "processing".
      await this.redis.del(key);
      throw err;
    }
  }
}
