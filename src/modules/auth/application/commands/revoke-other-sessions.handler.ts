import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { RevokeOtherSessionsCommand } from './revoke-other-sessions.command.js';
import type { ISessionRepository } from '../../domain/index.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

@CommandHandler(RevokeOtherSessionsCommand)
export class RevokeOtherSessionsHandler implements ICommandHandler<RevokeOtherSessionsCommand> {
  constructor(
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(command: RevokeOtherSessionsCommand): Promise<void> {
    const now = new Date();

    const otherSessionIds = (
      await this.sessionRepo.findActiveByUser(command.userId, now)
    )
      .filter((session) => session.id !== command.currentSessionId)
      .map((session) => session.id);

    // Flag first, then close in the database: if either step fails the sessions
    // are still listed as live, so a retry redoes everything. The other order
    // would leave them closed but unflagged, with nothing left to find on retry.
    await this.tokenStore.markSessionsRevoked(
      otherSessionIds,
      this.tokenIssuer.accessTtlSeconds,
    );
    const closedIds = await this.sessionRepo.revokeAllForUser(
      command.userId,
      'LOGOUT_OTHERS',
      now,
      command.currentSessionId,
    );

    // A session that was started between listing and closing is closed too but was not
    // flagged above: flag it now, or its access token would keep working for up to 15 minutes
    const alreadyFlagged = new Set(otherSessionIds);
    const missed = closedIds.filter((id) => !alreadyFlagged.has(id));
    if (missed.length > 0) {
      await this.tokenStore.markSessionsRevoked(
        missed,
        this.tokenIssuer.accessTtlSeconds,
      );
    }
  }
}
