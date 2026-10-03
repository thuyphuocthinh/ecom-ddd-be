import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { ResetPasswordCommand } from './reset-password.command.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { appConfig, type AppConfig } from '@/core/index.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import {
  AuthDomainException,
  type IPasswordRepository,
} from '../../domain/index.js';
import { findPasswordWeakness } from '../../domain/policies/password.policy.js';
import { TokenStore } from '../../infrastructure/index.js';
import { orServiceUnavailable } from '../../infrastructure/redis/redis-failure.js';
import { OtpService } from '../services/otp.service.js';
import { PasswordMailer } from '../services/password-mailer.service.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

/**
 * Sets a new password with the code that was emailed. The order of the steps is the point:
 *
 *  1. A weak new password is refused before the code is touched, so the person can fix it
 *     without using up a guess.
 *  2. The code is checked, and the account looked up. A wrong code and an address with no
 *     account give the same answer.
 *  3. The new password is hashed first, because hashing is slow and nothing may change
 *     while it runs.
 *  4. Every access token issued so far is refused (the user's token version goes up), and
 *     the code is used up so only one request can win.
 *  5. In ONE database transaction the password is replaced and every session is closed. Never
 *     one without the other: a new password with a stolen session still alive is the one
 *     outcome this flow must not allow.
 *  6. The closed sessions are flagged in Redis, and the owner is told by email.
 */
@CommandHandler(ResetPasswordCommand)
export class ResetPasswordHandler implements ICommandHandler<ResetPasswordCommand> {
  private readonly logger = new Logger(ResetPasswordHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    @Inject('IPasswordRepository')
    private readonly passwordRepo: IPasswordRepository,
    private readonly otpService: OtpService,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
    private readonly mailer: PasswordMailer,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  async execute(command: ResetPasswordCommand): Promise<void> {
    const { email, code, newPassword, client } = command;

    // 1. Too easy to guess: stop before the code is used
    const weakness = findPasswordWeakness({
      password: newPassword,
      email,
      appName: this.app.name,
    });
    if (weakness) {
      throw new AuthDomainException(AuthErrorCodes.WEAK_PASSWORD, {
        reason: weakness,
      });
    }

    // 2. The code, then the account
    if (
      !(await this.otpService.verify('RESET_PASSWORD', email, code, client.ip))
    ) {
      throw this.invalidCode();
    }
    const user = await this.userRepo.findByCredential(
      CredentialProvider.EMAIL,
      email,
    );
    const credential = user?.credentials.find(
      (c) => c.provider === CredentialProvider.EMAIL && c.secret,
    );
    if (!user || !credential) {
      throw this.invalidCode();
    }

    // 3. Hash before anything changes
    const newHash = await HashUtil.hashPassword(newPassword);

    // 4. Every access token issued so far stops working; the code is used up (one winner)
    await orServiceUnavailable(this.logger, () =>
      this.tokenStore.bumpTokenVersion(user.id),
    );
    if (!(await this.otpService.consume('RESET_PASSWORD', email))) {
      throw this.invalidCode();
    }

    // 5. New password and closed sessions, together or not at all
    let revokedSessionIds: string[];
    try {
      const result = await this.passwordRepo.changePassword({
        userId: user.id,
        credentialId: credential.id,
        newHash,
        reason: 'PASSWORD_RESET',
        now: new Date(),
      });
      if (!result.changed) {
        throw this.invalidCode();
      }
      revokedSessionIds = result.revokedSessionIds;
    } catch (error) {
      // The code is gone and nothing changed: let the person ask for a new code at once
      await this.otpService.releaseSend('RESET_PASSWORD', email);
      throw error;
    }

    // 6. Flag the closed sessions (the version bump already covers every token issued before
    // it; this covers a session that appeared while the transaction ran). The password is
    // already changed, so a failure here is logged, not reported as a failed reset.
    try {
      await this.tokenStore.markSessionsRevoked(
        revokedSessionIds,
        this.tokenIssuer.accessTtlSeconds,
      );
    } catch (error) {
      this.logger.error(
        `Could not flag the sessions closed by a password reset: ${(error as Error).name}`,
      );
    }
    await this.mailer.sendPasswordChanged(email);
  }

  /** The same answer for a wrong code, an expired code, a used code and an unknown address. */
  private invalidCode(): AuthDomainException {
    return new AuthDomainException(
      AuthErrorCodes.INVALID_VERIFICATION_CODE,
      'Invalid or expired verification code',
    );
  }
}
