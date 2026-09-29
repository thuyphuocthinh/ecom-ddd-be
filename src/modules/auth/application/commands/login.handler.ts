import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { LoginCommand } from './login.command.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import { AuthDomainException } from '../../domain/index.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';
import { CredentialProvider } from '@prisma/client';

@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  private readonly logger = new Logger(LoginHandler.name);

  // Hash of a random throwaway password, verified against when the account
  // doesn't exist so an unknown email costs the same time as a wrong password.
  private readonly dummyHash: Promise<string> = HashUtil.hashPassword(
    HashUtil.generateRandomToken(16),
  );

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(
    command: LoginCommand,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    this.logger.debug('Executing LoginCommand');

    // 1. Find user by email
    const user = await this.userRepo.findByCredential(
      CredentialProvider.EMAIL,
      command.email,
    );
    const secret =
      user?.credentials.find((c) => c.provider === CredentialProvider.EMAIL)
        ?.secret ?? null;

    // 2. Verify password — always run one argon2 verify, even when there is
    // nothing to verify against, so response time can't reveal whether the email exists.
    const isPasswordValid = await HashUtil.comparePassword(
      command.plainPassword,
      secret ?? (await this.dummyHash),
    );
    if (!user || !secret || !isPasswordValid) {
      this.throwInvalidCredentials();
    }

    // 3. Issue tokens bound to the user's current token version
    const tokenVersion = await this.tokenStore.getTokenVersion(user.id);
    const { accessToken, refreshToken } = this.tokenIssuer.issue(
      user,
      tokenVersion,
    );

    // 4. Store Refresh Token Hash in Redis
    await this.tokenStore.storeRefreshToken(
      refreshToken,
      user.id,
      tokenVersion,
      this.tokenIssuer.refreshTtlSeconds,
    );

    return { accessToken, refreshToken };
  }

  /**
   * Always throw a generic error to prevent email enumeration attacks
   */
  private throwInvalidCredentials(): never {
    throw new AuthDomainException(
      AuthErrorCodes.INVALID_CREDENTIALS,
      'Invalid email or password',
    );
  }
}
