import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../redis.service.js';

interface IdempotencyRecord<T> {
  status: 'processing' | 'completed';
  // Hash of the request payload this key was first used with, so a retry
  // that reuses the same key with a *different* payload is rejected
  // instead of silently replaying the wrong cached response.
  fingerprint: string;
  response?: T;
}

// Short: bounds how long a crashed/never-finishing attempt (or a failed
// "mark completed" write, see below) can block retries under this key.
const PROCESSING_TTL_SECONDS = 5 * 60;
// Long: how long a *finished* result stays replayable for a legitimate
// client retry.
const COMPLETED_TTL_SECONDS = 24 * 60 * 60;

export function computeIdempotencyFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly redis: RedisService) {}

  private key(idempotencyKey: string): string {
    return `idempotency:${idempotencyKey}`;
  }

  /**
   * Runs `action` at most once per idempotencyKey within the TTL window.
   * A retry with the same key and the same requestFingerprint while the
   * first attempt is still running is rejected (409); after it completed,
   * it replays the saved response instead of re-running the command. A
   * retry with the same key but a *different* requestFingerprint is
   * rejected instead of silently replaying an unrelated response. No key
   * means no idempotency check.
   */
  async execute<T>(
    idempotencyKey: string | undefined,
    requestFingerprint: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!idempotencyKey) {
      return action();
    }

    const key = this.key(idempotencyKey);
    const client = this.redis.getClient();

    let claimed: string | null;
    try {
      // Atomic claim: only the first request for this key gets NX to
      // succeed. Bypasses RedisService's cache helpers (which swallow
      // errors) because a failure here must be handled explicitly below.
      claimed = await client.set(
        key,
        JSON.stringify({
          status: 'processing',
          fingerprint: requestFingerprint,
        } satisfies IdempotencyRecord<T>),
        'EX',
        PROCESSING_TTL_SECONDS,
        'NX',
      );
    } catch (err) {
      // Redis unreachable/timed out (see commandTimeout on RedisService) —
      // treat idempotency as best-effort infrastructure, not a hard
      // dependency: run the action unprotected rather than failing (or
      // hanging) the whole request over a duplicate-prevention nicety.
      this.logger.warn(
        `Idempotency claim failed for key ${idempotencyKey}, proceeding without protection: ${(err as Error).message}`,
      );
      return action();
    }

    if (claimed === null) {
      const existingRaw = await client.get(key);
      const existing = existingRaw
        ? (JSON.parse(existingRaw) as IdempotencyRecord<T>)
        : null;

      if (existing && existing.fingerprint !== requestFingerprint) {
        throw new ConflictException(
          'This Idempotency-Key was already used with different request parameters',
        );
      }
      if (existing?.status === 'completed') {
        return existing.response as T;
      }
      throw new ConflictException(
        'A request with this Idempotency-Key is already being processed',
      );
    }

    try {
      const response = await action();
      try {
        await client.set(
          key,
          JSON.stringify({
            status: 'completed',
            fingerprint: requestFingerprint,
            response,
          } satisfies IdempotencyRecord<T>),
          'EX',
          COMPLETED_TTL_SECONDS,
        );
      } catch (err) {
        // The action already succeeded — don't fail a successful response
        // over bookkeeping. Logged loudly (not swallowed) because it means
        // this key is stuck reporting "processing" until PROCESSING_TTL_
        // SECONDS expires, after which a retry would re-run the action.
        this.logger.error(
          `Failed to record completion for idempotency key ${idempotencyKey}: ${(err as Error).message}`,
        );
      }
      return response;
    } catch (err) {
      // Don't hold the claim for a failed attempt — a retry should be able
      // to try again rather than being stuck behind a dead "processing".
      await client.del(key).catch(() => undefined);
      throw err;
    }
  }
}
