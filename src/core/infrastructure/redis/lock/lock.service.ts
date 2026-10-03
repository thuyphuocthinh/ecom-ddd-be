import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis.service.js';
import { DomainException } from '../../../domain/exceptions/domain.exception.js';
import { CoreErrorCodes } from '../../../domain/exceptions/error-codes.js';

const KEY_PREFIX = 'ecom:v1:lock:';
const POLL_INTERVAL_MS = 50;
// Only the holder may release: a lock that expired and was taken by somebody else stays theirs
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface LockOptions {
  /** How long the lock lives if the holder never lets go (crash). Must exceed the work. */
  ttlMs?: number;
  /** How long to wait for somebody else to finish before giving up with a 409. */
  waitMs?: number;
}

/**
 * Lets one request at a time work on one thing across all server instances, e.g. the avatar
 * of a user: an upload and a removal arriving together then run one after the other instead
 * of overlapping.
 */
@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name);

  constructor(private readonly redis: RedisService) {}

  async run<T>(
    name: string,
    work: () => Promise<T>,
    { ttlMs = 60_000, waitMs = 10_000 }: LockOptions = {},
  ): Promise<T> {
    const key = KEY_PREFIX + name;
    const owner = randomUUID();
    await this.acquire(key, owner, ttlMs, waitMs);
    try {
      return await work();
    } finally {
      await this.release(key, owner);
    }
  }

  private async acquire(
    key: string,
    owner: string,
    ttlMs: number,
    waitMs: number,
  ): Promise<void> {
    const giveUpAt = Date.now() + waitMs;
    for (;;) {
      let taken: string | null;
      try {
        taken = await this.redis.getClient().set(key, owner, 'PX', ttlMs, 'NX');
      } catch (error: any) {
        this.logger.error(`Redis lock failed: ${error.message}`);
        throw new ServiceUnavailableException(
          'Service temporarily unavailable',
        );
      }
      if (taken === 'OK') return;
      if (Date.now() >= giveUpAt) {
        throw new DomainException(CoreErrorCodes.RESOURCE_BUSY);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private async release(key: string, owner: string): Promise<void> {
    try {
      await this.redis.getClient().eval(RELEASE_SCRIPT, 1, key, owner);
    } catch (error: any) {
      // The work is done; the lock expires by itself, so this must not turn it into a failure
      this.logger.warn(`Releasing a lock failed: ${error.message}`);
    }
  }
}
