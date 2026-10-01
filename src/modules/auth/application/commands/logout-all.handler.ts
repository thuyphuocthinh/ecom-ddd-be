import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { LogoutAllCommand } from './logout-all.command.js';
import type { ISessionRepository } from '../../domain/index.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

@CommandHandler(LogoutAllCommand)
export class LogoutAllHandler implements ICommandHandler<LogoutAllCommand> {
  constructor(
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(command: LogoutAllCommand): Promise<void> {
    // Database first, so the refresh tokens die before anything can fail in Redis:
    // a retry after a Redis error then still finishes the job.
    const revokedIds = await this.sessionRepo.revokeAllForUser(
      command.userId,
      'LOGOUT_ALL',
      new Date(),
    );

    // Bumping the version makes JwtAuthGuard reject every access token issued
    // before it (ver < current), including tokens of sessions created and lost track of.
    await this.tokenStore.bumpTokenVersion(command.userId);
    await this.tokenStore.markSessionsRevoked(
      revokedIds,
      this.tokenIssuer.accessTtlSeconds,
    );
  }
}
