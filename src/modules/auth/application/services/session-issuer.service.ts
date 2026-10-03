import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { UserStatus, type UserRole } from '@prisma/client';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IClientInfo } from '@/core/index.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import {
  AuthDomainException,
  Session,
  type ISessionRepository,
} from '../../domain/index.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from './token-issuer.service.js';

/**
 * Starts a session for a user who has just proved who they are (password at login,
 * email code at registration, Google token) and returns the tokens for it. Shared so every
 * entry point creates sessions identically, and so that a suspended account is refused in
 * ONE place.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepository,
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async start(
    user: { id: string; role: UserRole; status: UserStatus },
    client: IClientInfo,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // Said only now, after the person proved who they are, so it tells a stranger nothing
    if (user.status !== UserStatus.ACTIVE) throw this.suspended();

    // Tokens are bound to the user's current token version and to the new session
    const sessionId = randomUUID();
    const tokenVersion = await this.tokenStore.getTokenVersion(user.id);
    const { accessToken, refreshToken } = this.tokenIssuer.issue(
      user,
      tokenVersion,
      sessionId,
    );

    // Persist the session; only the refresh token's hash is stored
    const now = new Date();
    await this.sessionRepo.save(
      Session.start({
        id: sessionId,
        userId: user.id,
        refreshTokenHash: HashUtil.sha256(refreshToken),
        userAgent: client.userAgent,
        ipAddress: client.ip,
        now,
        refreshTtlSeconds: this.tokenIssuer.refreshTtlSeconds,
        absoluteTtlSeconds: this.tokenIssuer.sessionAbsoluteTtlSeconds,
      }),
    );

    await this.refuseIfSuspendedMeanwhile(sessionId, user.id, now);

    return { accessToken, refreshToken };
  }

  /**
   * The status was read before the session was saved. An administrator may have suspended the
   * account in between: their step "close every session" ran before ours was saved and so
   * missed it. Reading the status again AFTER saving closes that gap: either the suspension was
   * written already (we see it here and close this session ourselves), or it is written later,
   * and then its "close every session" starts after this session exists and closes it.
   */
  private async refuseIfSuspendedMeanwhile(
    sessionId: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    const status = await this.userRepo.findStatus(userId);
    if (status === UserStatus.ACTIVE) return;

    // The tokens were never handed out, so closing the session in the database is enough
    await this.sessionRepo.revoke(sessionId, userId, 'ADMIN', now);
    throw status === null
      ? new AuthDomainException(AuthErrorCodes.INVALID_CREDENTIALS)
      : this.suspended();
  }

  private suspended(): AuthDomainException {
    return new AuthDomainException(AuthErrorCodes.ACCOUNT_SUSPENDED);
  }
}
