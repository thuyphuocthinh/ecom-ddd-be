import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { LogoutCommand } from './logout.command.js';
import { TokenStore } from '../../infrastructure/index.js';

@CommandHandler(LogoutCommand)
export class LogoutHandler implements ICommandHandler<LogoutCommand> {
  constructor(private readonly tokenStore: TokenStore) {}

  async execute(command: LogoutCommand): Promise<void> {
    const { accessToken, refreshToken, exp } = command;

    // 1. Revoke Refresh Token immediately
    await this.tokenStore.revokeRefreshToken(refreshToken);

    // 2. Blacklist Access Token until its natural expiration
    const now = Math.floor(Date.now() / 1000);
    const ttl = exp - now;

    if (ttl > 0) {
      await this.tokenStore.blacklistAccessToken(accessToken, ttl);
    }
  }
}
