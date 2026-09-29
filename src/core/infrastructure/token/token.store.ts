import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis/redis.service.js';
import { CACHE } from '../cache/cache.constants.js';
import * as crypto from 'crypto';

// Claim the old RT and write its successor + grace entry as ONE atomic step.
// DEL returns 0 when another request already rotated this RT, so exactly one
// concurrent caller wins; the rest fall back to the winner's grace entry.
const ROTATE_REFRESH_TOKEN_SCRIPT = `
  if redis.call("DEL", KEYS[1]) == 0 then
    return 0
  end
  redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[2])
  redis.call("SET", KEYS[3], ARGV[3], "EX", ARGV[4])
  return 1
`;

const GRACE_IV_BYTES = 12;
const GRACE_TAG_BYTES = 16;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RotateRefreshTokenParams {
  oldRefreshToken: string;
  newRefreshToken: string;
  userId: string;
  version: number;
  ttl: number;
  newTokens: TokenPair;
}

/**
 * Redis-backed store for JWT lifecycle management.
 * Lives in core because JwtAuthGuard (also in core) depends on it,
 * and all its own dependencies (RedisService, CACHE) are already in core.
 *
 * Talks to the raw Redis client on purpose: RedisService's helpers swallow
 * errors (fine for a cache), but here a silent failure would mean a revoked
 * token treated as valid, or a logout reported as done when nothing was written.
 * Every method rejects if Redis is unreachable — callers must not assume success.
 */
@Injectable()
export class TokenStore {
  private readonly logger = new Logger(TokenStore.name);

  constructor(private readonly redis: RedisService) {}

  private get client(): Redis {
    return this.redis.getClient();
  }

  /**
   * Hash a raw token (AT or RT) for safe storage in Redis.
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // --- Token Versioning (Logout All) ---

  async getTokenVersion(userId: string): Promise<number> {
    const val = await this.client.get(CACHE.AUTH.KEYS.TOKEN_VERSION(userId));
    return val ? parseInt(val, 10) : 0;
  }

  async bumpTokenVersion(userId: string): Promise<void> {
    this.logger.debug(`Bumping token version for user ${userId}`);
    await this.client.incr(CACHE.AUTH.KEYS.TOKEN_VERSION(userId));
  }

  // --- Blacklist (Logout) ---

  async blacklistAccessToken(accessToken: string, ttl: number): Promise<void> {
    const hash = this.hashToken(accessToken);
    await this.client.set(CACHE.AUTH.KEYS.BLACKLIST(hash), '1', 'EX', ttl);
  }

  async isAccessTokenBlacklisted(accessToken: string): Promise<boolean> {
    const hash = this.hashToken(accessToken);
    return (await this.client.get(CACHE.AUTH.KEYS.BLACKLIST(hash))) === '1';
  }

  // --- Refresh Token Lifecycle ---

  async storeRefreshToken(
    refreshToken: string,
    userId: string,
    version: number,
    ttl: number,
  ): Promise<void> {
    const hash = this.hashToken(refreshToken);
    const value = JSON.stringify({ userId, version });
    await this.client.set(
      CACHE.AUTH.KEYS.REFRESH_TOKEN(hash),
      value,
      'EX',
      ttl,
    );
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const hash = this.hashToken(refreshToken);
    await this.client.del(CACHE.AUTH.KEYS.REFRESH_TOKEN(hash));
  }

  /**
   * Verifies if RT exists. Returns { userId, version } if valid, null if not.
   */
  async verifyRefreshToken(
    refreshToken: string,
  ): Promise<{ userId: string; version: number } | null> {
    const hash = this.hashToken(refreshToken);
    const val = await this.client.get(CACHE.AUTH.KEYS.REFRESH_TOKEN(hash));
    return val ? JSON.parse(val) : null;
  }

  // --- Refresh Token Rotation (+ grace window) ---

  /**
   * Atomically swaps the old RT for a new one and records the grace entry.
   * Returns false when the old RT is already gone — i.e. a concurrent request
   * rotated it first; the caller should then read that request's grace entry.
   *
   * Grace window: a concurrent request arriving with the old RT within the
   * window gets the same new tokens back instead of a 401.
   */
  async rotateRefreshToken(params: RotateRefreshTokenParams): Promise<boolean> {
    const {
      oldRefreshToken,
      newRefreshToken,
      userId,
      version,
      ttl,
      newTokens,
    } = params;
    const result = await this.client.eval(
      ROTATE_REFRESH_TOKEN_SCRIPT,
      3,
      CACHE.AUTH.KEYS.REFRESH_TOKEN(this.hashToken(oldRefreshToken)),
      CACHE.AUTH.KEYS.REFRESH_TOKEN(this.hashToken(newRefreshToken)),
      CACHE.AUTH.KEYS.ROTATION_GRACE(this.hashToken(oldRefreshToken)),
      JSON.stringify({ userId, version }),
      ttl,
      this.encryptGrace(oldRefreshToken, newTokens),
      CACHE.AUTH.SETTINGS.ROTATION_GRACE_TTL,
    );
    return result === 1;
  }

  async getRotationGrace(oldRefreshToken: string): Promise<TokenPair | null> {
    const val = await this.client.get(
      CACHE.AUTH.KEYS.ROTATION_GRACE(this.hashToken(oldRefreshToken)),
    );
    return val ? this.decryptGrace(oldRefreshToken, val) : null;
  }

  // The grace entry holds live tokens, so it is encrypted with a key derived
  // from the OLD refresh token: a Redis dump alone (which only has sha256 of
  // that token) can't recover them. Only the holder of the old RT can.

  private graceKey(oldRefreshToken: string): Buffer {
    return crypto
      .createHash('sha256')
      .update(`rotation-grace:${oldRefreshToken}`)
      .digest();
  }

  private encryptGrace(oldRefreshToken: string, tokens: TokenPair): string {
    const iv = crypto.randomBytes(GRACE_IV_BYTES);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.graceKey(oldRefreshToken),
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(tokens), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      'base64',
    );
  }

  private decryptGrace(
    oldRefreshToken: string,
    payload: string,
  ): TokenPair | null {
    try {
      const raw = Buffer.from(payload, 'base64');
      const iv = raw.subarray(0, GRACE_IV_BYTES);
      const tag = raw.subarray(
        GRACE_IV_BYTES,
        GRACE_IV_BYTES + GRACE_TAG_BYTES,
      );
      const ciphertext = raw.subarray(GRACE_IV_BYTES + GRACE_TAG_BYTES);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.graceKey(oldRefreshToken),
        iv,
      );
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(plain) as TokenPair;
    } catch {
      return null;
    }
  }
}
