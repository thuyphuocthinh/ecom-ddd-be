import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { RevokeSessionCommand } from './revoke-session.command.js';
import {
  AuthDomainException,
  type ISessionRepository,
} from '../../domain/index.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

@CommandHandler(RevokeSessionCommand)
export class RevokeSessionHandler implements ICommandHandler<RevokeSessionCommand> {
  constructor(
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(command: RevokeSessionCommand): Promise<void> {
    const now = new Date();

    // Only the user's own live sessions may be revoked or flagged. Unknown,
    // someone else's and already-closed sessions are indistinguishable on
    // purpose: the answer must not reveal that another user's session exists,
    // and an id the caller doesn't own must never reach Redis.
    const ownSessions = await this.sessionRepo.findActiveByUser(
      command.userId,
      now,
    );
    if (!ownSessions.some((session) => session.id === command.sessionId)) {
      throw new AuthDomainException(
        AuthErrorCodes.SESSION_NOT_FOUND,
        'Session not found',
      );
    }

    // Flag first, then close in the database. If either step fails the session
    // is still listed as live, so a retry runs the whole thing again; the other
    // order would leave a session closed but unflagged, with nothing to retry.
    await this.tokenStore.markSessionsRevoked(
      [command.sessionId],
      this.tokenIssuer.accessTtlSeconds,
    );
    // false just means a concurrent request closed it first: same end state
    await this.sessionRepo.revoke(
      command.sessionId,
      command.userId,
      'LOGOUT',
      now,
    );
  }
}
