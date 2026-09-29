import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { LogoutAllCommand } from './logout-all.command.js';
import { TokenStore } from '../../infrastructure/index.js';

@CommandHandler(LogoutAllCommand)
export class LogoutAllHandler implements ICommandHandler<LogoutAllCommand> {
  constructor(private readonly tokenStore: TokenStore) {}

  async execute(command: LogoutAllCommand): Promise<void> {
    // Bumping the version kills every session at once, without tracking them:
    //  - access tokens carry `ver`, and JwtAuthGuard rejects any with ver < current;
    //  - refresh tokens are stored with the `ver` they were issued at, and
    //    RefreshTokenHandler rejects any with ver < current.
    await this.tokenStore.bumpTokenVersion(command.userId);
  }
}
