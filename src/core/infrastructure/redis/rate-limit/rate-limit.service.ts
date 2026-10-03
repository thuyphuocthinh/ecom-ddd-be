import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis.service.js';

// INCR + EXPIRE in one atomic step: a crash between two separate commands
// would leave a counter with no TTL, locking the caller out forever.
const INCREMENT_IN_WINDOW_SCRIPT = `
  local current = redis.call("INCR", KEYS[1])
  if current == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
  end
  return current
`;

/**
 * Fixed-window counter on Redis. The window starts at the first hit of a key
 * and the counter expires `window` seconds later.
 */
@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /**
   * @param key    bucket key, see CACHE.RATE_LIMIT.KEYS.BUCKET
   * @param limit  max hits allowed per window
   * @param window window length in seconds
   * @throws if Redis is unreachable — the caller decides whether to fail open
   */
  async isAllowed(
    key: string,
    limit: number,
    window: number,
  ): Promise<boolean> {
    const count = (await this.redis
      .getClient()
      .eval(INCREMENT_IN_WINDOW_SCRIPT, 1, key, window)) as number;
    return count <= limit;
  }
}
