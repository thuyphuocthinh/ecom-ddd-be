import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { UserRole } from '@prisma/client';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IClientInfo } from '@/core/index.js';
import { Session, type ISessionRepository } from '../../domain/index.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from './token-issuer.service.js';

/**
 * Starts a session for a user who has just proved who they are (password at login,
 * email code at registration) and returns the tokens for it. Shared so both entry
 * points create sessions identically.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async start(
    user: { id: string; role: UserRole },
    client: IClientInfo,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // Tokens are bound to the user's current token version and to the new session
    const sessionId = randomUUID();
    const tokenVersion = await this.tokenStore.getTokenVersion(user.id);
    const { accessToken, refreshToken } = this.tokenIssuer.issue(
      user,
      tokenVersion,
      sessionId,
    );

    // Persist the session; only the refresh token's hash is stored
    await this.sessionRepo.save(
      Session.start({
        id: sessionId,
        userId: user.id,
        refreshTokenHash: HashUtil.sha256(refreshToken),
        userAgent: client.userAgent,
        ipAddress: client.ip,
        now: new Date(),
        refreshTtlSeconds: this.tokenIssuer.refreshTtlSeconds,
        absoluteTtlSeconds: this.tokenIssuer.sessionAbsoluteTtlSeconds,
      }),
    );

    return { accessToken, refreshToken };
  }
}
