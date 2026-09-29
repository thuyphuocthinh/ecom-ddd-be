import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { RefreshTokenCommand } from './refresh-token.command.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import { AuthDomainException } from '../../domain/index.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

@CommandHandler(RefreshTokenCommand)
export class RefreshTokenHandler implements ICommandHandler<RefreshTokenCommand> {
  private readonly logger = new Logger(RefreshTokenHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(
    command: RefreshTokenCommand,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const { refreshToken: oldRefreshToken } = command;

    // 1. Check if token is in Grace Window (Concurrent Refresh)
    const graceTokens = await this.tokenStore.getRotationGrace(oldRefreshToken);
    if (graceTokens) {
      this.logger.debug(
        'Concurrent refresh detected. Returning grace window tokens.',
      );
      return graceTokens;
    }

    // 2. Verify token exists in Redis.
    // Unknown means expired, revoked, or already rotated — the store keeps no
    // record that would tell these apart, so all of them are a plain 401.
    const rtData = await this.tokenStore.verifyRefreshToken(oldRefreshToken);
    if (!rtData) {
      throw this.invalidRefreshToken('Invalid or expired refresh token');
    }

    const { userId, version: rtVersion } = rtData;

    // 3. Load user to check if they still exist and get role
    const user = await this.userRepo.findById(userId);
    if (!user) {
      // User was deleted but RT was still active
      await this.tokenStore.revokeRefreshToken(oldRefreshToken);
      throw this.invalidRefreshToken('User no longer exists');
    }

    // 4. Get current token version and check against RT's version
    const currentVersion = await this.tokenStore.getTokenVersion(user.id);
    if (rtVersion < currentVersion) {
      // User has logged out all devices. This RT is invalid.
      await this.tokenStore.revokeRefreshToken(oldRefreshToken);
      throw this.invalidRefreshToken('Session has been revoked');
    }

    // 5. Issue the new pair and rotate atomically
    const newTokens = this.tokenIssuer.issue(user, currentVersion);
    const rotated = await this.tokenStore.rotateRefreshToken({
      oldRefreshToken,
      newRefreshToken: newTokens.refreshToken,
      userId: user.id,
      version: currentVersion,
      ttl: this.tokenIssuer.refreshTtlSeconds,
      newTokens,
    });
    if (rotated) {
      return newTokens;
    }

    // A concurrent request rotated this RT between our check and now. It wrote
    // its grace entry in the same atomic step, so hand back its pair — not ours,
    // which was never stored.
    const winnerTokens =
      await this.tokenStore.getRotationGrace(oldRefreshToken);
    if (winnerTokens) {
      return winnerTokens;
    }
    throw this.invalidRefreshToken('Invalid or expired refresh token');
  }

  private invalidRefreshToken(message: string): AuthDomainException {
    return new AuthDomainException(AuthErrorCodes.UNAUTHORIZED_ACCESS, message);
  }
}
