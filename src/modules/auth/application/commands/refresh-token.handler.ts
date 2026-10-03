import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { RefreshTokenCommand } from './refresh-token.command.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import {
  AuthDomainException,
  type ISessionRepository,
} from '../../domain/index.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

// A request that loses a concurrent rotation can look for the winner's grace
// entry before the winner has written it (the entry is written just after the
// database update), so it polls for a short while instead of failing at once.
// About 200 ms in total: long enough to ride out a slow Redis round trip, and
// only ever spent by the losing request.
const GRACE_POLL_ATTEMPTS = 10;
const GRACE_POLL_INTERVAL_MS = 20;

type TokenPair = { accessToken: string; refreshToken: string };

@CommandHandler(RefreshTokenCommand)
export class RefreshTokenHandler implements ICommandHandler<RefreshTokenCommand> {
  private readonly logger = new Logger(RefreshTokenHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(command: RefreshTokenCommand): Promise<TokenPair> {
    const { refreshToken: oldRefreshToken, ipAddress } = command;

    // 1. Concurrent refresh: the token was rotated moments ago, hand back that pair
    const graceTokens = await this.tokenStore.getRotationGrace(oldRefreshToken);
    if (graceTokens) {
      this.logger.debug(
        'Concurrent refresh detected. Returning grace window tokens.',
      );
      return graceTokens;
    }

    const now = new Date();
    const oldHash = HashUtil.sha256(oldRefreshToken);

    // 2. The token is not any live session's current one: expired, revoked,
    // already rotated, or never issued
    const session = await this.sessionRepo.findActiveByRefreshHash(
      oldHash,
      now,
    );
    if (!session) {
      return this.handleUnknownToken(oldRefreshToken, oldHash, now);
    }

    // 3. The session must still belong to an existing, active user (needed for the role)
    const user = await this.userRepo.findById(session.userId);
    // A suspended account has no live sessions (they were closed), so this is only a second lock
    if (!user || !user.isActive) {
      throw this.invalidRefreshToken('Invalid or expired refresh token');
    }

    // 4. Issue the new pair, then swap the session's refresh token atomically
    const currentVersion = await this.tokenStore.getTokenVersion(user.id);
    const newTokens = this.tokenIssuer.issue(user, currentVersion, session.id);
    session.rotate({
      newRefreshTokenHash: HashUtil.sha256(newTokens.refreshToken),
      ipAddress,
      now,
      refreshTtlSeconds: this.tokenIssuer.refreshTtlSeconds,
      absoluteTtlSeconds: this.tokenIssuer.sessionAbsoluteTtlSeconds,
    });
    const rotated = await this.sessionRepo.rotate(session, oldHash, now);

    if (rotated) {
      await this.recordGrace(session.id, oldRefreshToken, newTokens);
      return newTokens;
    }

    // A concurrent request rotated this token between our lookup and our
    // update. Our pair was never stored, so return the winner's.
    return this.winnerTokensOrFail(oldRefreshToken);
  }

  /**
   * The token matches no live session's current refresh token. If it matches
   * the one a live session replaced, it was already exchanged:
   *  - a moment ago: a concurrent refresh whose grace entry we can't see yet (or lost);
   *  - long ago: someone is replaying an old token, so the session is revoked.
   * Anything else is just an unknown/expired token.
   */
  private async handleUnknownToken(
    oldRefreshToken: string,
    oldHash: string,
    now: Date,
  ): Promise<TokenPair> {
    const replaced = await this.sessionRepo.findActiveByPreviousHash(
      oldHash,
      now,
    );
    if (!replaced) {
      throw this.invalidRefreshToken('Invalid or expired refresh token');
    }

    if (replaced.isWithinGrace(now, CACHE.AUTH.SETTINGS.ROTATION_GRACE_TTL)) {
      return this.winnerTokensOrFail(oldRefreshToken);
    }

    await this.sessionRepo.revoke(
      replaced.id,
      replaced.userId,
      'REUSE_DETECTED',
      now,
    );
    await this.tokenStore.markSessionsRevoked(
      [replaced.id],
      this.tokenIssuer.accessTtlSeconds,
    );
    // No token is logged, only ids
    this.logger.warn(
      `Refresh token reuse detected; session ${replaced.id} of user ${replaced.userId} revoked`,
    );
    throw this.invalidRefreshToken('Invalid or expired refresh token');
  }

  /**
   * The rotation is already committed, so the client must get its new tokens
   * even if the grace entry can't be written: losing that entry only costs a
   * concurrent request its shortcut. Failing here would drop the new refresh
   * token on the floor, and the client's retry with the old one would later
   * look like a replay and revoke the session.
   */
  private async recordGrace(
    sessionId: string,
    oldRefreshToken: string,
    newTokens: TokenPair,
  ): Promise<void> {
    try {
      await this.tokenStore.setRotationGrace(oldRefreshToken, newTokens);
    } catch (error: any) {
      this.logger.warn(
        `Could not record the rotation grace entry for session ${sessionId}: ${error.message}`,
      );
    }
  }

  private async winnerTokensOrFail(
    oldRefreshToken: string,
  ): Promise<TokenPair> {
    for (let attempt = 0; attempt < GRACE_POLL_ATTEMPTS; attempt++) {
      const tokens = await this.tokenStore.getRotationGrace(oldRefreshToken);
      if (tokens) {
        return tokens;
      }
      if (attempt < GRACE_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, GRACE_POLL_INTERVAL_MS),
        );
      }
    }
    throw this.invalidRefreshToken('Invalid or expired refresh token');
  }

  private invalidRefreshToken(message: string): AuthDomainException {
    return new AuthDomainException(AuthErrorCodes.UNAUTHORIZED_ACCESS, message);
  }
}
