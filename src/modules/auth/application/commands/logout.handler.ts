import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { LogoutCommand } from './logout.command.js';
import type { ISessionRepository } from '../../domain/index.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

@CommandHandler(LogoutCommand)
export class LogoutHandler implements ICommandHandler<LogoutCommand> {
  constructor(
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(command: LogoutCommand): Promise<void> {
    const { sessionId, userId } = command;

    // 1. Close the session: its refresh token stops working
    await this.sessionRepo.revoke(sessionId, userId, 'LOGOUT', new Date());

    // 2. Flag it so the session's access tokens are refused right away. Done even
    // when the session was already closed, so a retried logout still ends up revoked.
    await this.tokenStore.markSessionsRevoked(
      [sessionId],
      this.tokenIssuer.accessTtlSeconds,
    );
  }
}
