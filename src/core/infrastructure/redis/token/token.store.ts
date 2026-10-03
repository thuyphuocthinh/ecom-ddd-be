import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis.service.js';
import { CACHE } from '../cache.constants.js';
import { HashUtil } from '../../../utils/hash.util.js';
import * as crypto from 'crypto';

const GRACE_IV_BYTES = 12;
const GRACE_TAG_BYTES = 16;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Redis-backed store for the short-lived, hot-path token state:
 *  - the per-user token version (logout-all),
 *  - the per-session "revoked" flag that makes JwtAuthGuard refuse a session's
 *    access tokens at once,
 *  - the encrypted grace entry for concurrent refreshes.
 * Refresh tokens themselves live in the Session table (Postgres), not here.
 *
 * Lives in core because JwtAuthGuard (also in core) depends on it,
 * and all its own dependencies (RedisService, CACHE) are already in core.
 *
 * Talks to the raw Redis client on purpose: RedisService's helpers swallow
 * errors (fine for a cache), but here a silent failure would mean a revoked
 * session treated as valid, or a logout reported as done when nothing was written.
 * Every method rejects if Redis is unreachable — callers must not assume success.
 */
@Injectable()
export class TokenStore {
  private readonly logger = new Logger(TokenStore.name);

  constructor(private readonly redis: RedisService) {}

  private get client(): Redis {
    return this.redis.getClient();
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

  // --- Session revocation flag ---

  /**
   * Flags sessions as revoked. `ttlSeconds` must cover the longest a still-valid
   * access token can live (the access-token TTL): after that, no token of these
   * sessions can pass the signature check anyway.
   */
  async markSessionsRevoked(
    sessionIds: string[],
    ttlSeconds: number,
  ): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }
    const pipeline = this.client.pipeline();
    for (const sessionId of sessionIds) {
      pipeline.set(
        CACHE.AUTH.KEYS.SESSION_REVOKED(sessionId),
        '1',
        'EX',
        ttlSeconds,
      );
    }
    const results = await pipeline.exec();
    // pipeline.exec() resolves even when a command failed; surface that
    const failed = results?.find(([error]) => error);
    if (failed) {
      throw failed[0];
    }
  }

  /**
   * Takes the revoked flag back off sessions that turned out to be still open (a change that
   * flagged them and then failed to close them). Without this their access tokens would stay
   * refused until the flag expires.
   */
  async clearSessionsRevoked(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }
    await this.client.del(
      ...sessionIds.map((id) => CACHE.AUTH.KEYS.SESSION_REVOKED(id)),
    );
  }

  async isSessionRevoked(sessionId: string): Promise<boolean> {
    return (
      (await this.client.get(CACHE.AUTH.KEYS.SESSION_REVOKED(sessionId))) ===
      '1'
    );
  }

  // --- Refresh Token Rotation grace window ---

  /**
   * Records the pair issued by a rotation under the OLD refresh token, so a
   * concurrent request still holding the old token within the window gets the
   * same new tokens back instead of a 401.
   */
  async setRotationGrace(
    oldRefreshToken: string,
    newTokens: TokenPair,
  ): Promise<void> {
    await this.client.set(
      CACHE.AUTH.KEYS.ROTATION_GRACE(HashUtil.sha256(oldRefreshToken)),
      this.encryptGrace(oldRefreshToken, newTokens),
      'EX',
      CACHE.AUTH.SETTINGS.ROTATION_GRACE_TTL,
    );
  }

  async getRotationGrace(oldRefreshToken: string): Promise<TokenPair | null> {
    const val = await this.client.get(
      CACHE.AUTH.KEYS.ROTATION_GRACE(HashUtil.sha256(oldRefreshToken)),
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
