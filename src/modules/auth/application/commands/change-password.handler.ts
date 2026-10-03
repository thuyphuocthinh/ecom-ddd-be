import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { ChangePasswordCommand } from './change-password.command.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { appConfig, type AppConfig } from '@/core/index.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import {
  AuthDomainException,
  type ChangePasswordResult,
  type IPasswordRepository,
  type ISessionRepository,
} from '../../domain/index.js';
import { findPasswordWeakness } from '../../domain/policies/password.policy.js';
import { TokenStore } from '../../infrastructure/index.js';
import { orServiceUnavailable } from '../../infrastructure/redis/redis-failure.js';
import { OtpService } from '../services/otp.service.js';
import { PasswordMailer } from '../services/password-mailer.service.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

/**
 * Changes the password of a logged-in user, from the session they are using. The other
 * sessions are closed; this one stays.
 *
 *  1. The current password must be right, and the new one must be different and not easy to
 *     guess.
 *  2. The new password is hashed before anything changes.
 *  3. The other sessions are flagged in Redis first, so a Redis failure stops the change
 *     before anything is written. If the transaction then fails, the flags are taken off
 *     again, because those sessions are still open and must keep working.
 *  4. In ONE database transaction the password is replaced and the other sessions closed. The
 *     replacement only happens if the stored password is still the one checked in step 1, so
 *     this cannot overwrite a password somebody else set in the meantime.
 *  5. Every session closed in the transaction is flagged again (its flag was set before the
 *     transaction and may expire first), an unused reset code is cancelled, and the owner is
 *     told by email.
 */
@CommandHandler(ChangePasswordCommand)
export class ChangePasswordHandler implements ICommandHandler<ChangePasswordCommand> {
  private readonly logger = new Logger(ChangePasswordHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    @Inject('IPasswordRepository')
    private readonly passwordRepo: IPasswordRepository,
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly otpService: OtpService,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
    private readonly mailer: PasswordMailer,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  async execute(command: ChangePasswordCommand): Promise<void> {
    const { userId, sessionId, currentPassword, newPassword } = command;

    // 1. The current password, then the new one
    const user = await this.userRepo.findById(userId);
    const credential = user?.credentials.find(
      (c) => c.provider === CredentialProvider.EMAIL && c.secret,
    );
    // An account without a password has nothing to change
    if (!credential?.secret) {
      throw new AuthDomainException(AuthErrorCodes.INCORRECT_CURRENT_PASSWORD);
    }
    if (!(await HashUtil.comparePassword(currentPassword, credential.secret))) {
      throw new AuthDomainException(AuthErrorCodes.INCORRECT_CURRENT_PASSWORD);
    }

    // The current password is now known to be exactly `currentPassword`, so a plain
    // comparison is enough (no second hash needed)
    const weakness =
      newPassword === currentPassword
        ? 'SAME_AS_CURRENT'
        : findPasswordWeakness({
            password: newPassword,
            email: credential.identifier,
            appName: this.app.name,
          });
    if (weakness) {
      throw new AuthDomainException(AuthErrorCodes.WEAK_PASSWORD, {
        reason: weakness,
      });
    }

    // 2. Hash before anything changes
    const newHash = await HashUtil.hashPassword(newPassword);

    // 3. Flag the other live sessions first
    const now = new Date();
    const otherSessionIds = (
      await this.sessionRepo.findActiveByUser(userId, now)
    )
      .filter((session) => session.id !== sessionId)
      .map((session) => session.id);
    await orServiceUnavailable(this.logger, () =>
      this.tokenStore.markSessionsRevoked(
        otherSessionIds,
        this.tokenIssuer.accessTtlSeconds,
      ),
    );

    // 4. New password and closed sessions, together or not at all
    let result: ChangePasswordResult;
    try {
      result = await this.passwordRepo.changePassword({
        userId,
        credentialId: credential.id,
        newHash,
        expectedOldHash: credential.secret,
        reason: 'PASSWORD_CHANGED',
        exceptSessionId: sessionId,
        now,
      });
    } catch (error) {
      await this.unflag(userId, otherSessionIds, now);
      throw error;
    }
    if (!result.changed) {
      await this.unflag(userId, otherSessionIds, now);
      throw new AuthDomainException(
        AuthErrorCodes.PASSWORD_CHANGED_CONCURRENTLY,
      );
    }

    // 5. The password is already changed, so what follows must not turn it into a failure
    try {
      await this.tokenStore.markSessionsRevoked(
        result.revokedSessionIds,
        this.tokenIssuer.accessTtlSeconds,
      );
    } catch (error) {
      this.logger.error(
        `Could not flag sessions closed by a password change: ${(error as Error).name}`,
      );
    }
    try {
      // A reset code still in the mailbox must not work any more
      await this.otpService.consume('RESET_PASSWORD', credential.identifier);
    } catch (error) {
      this.logger.error(
        `Could not cancel the reset code after a password change: ${(error as Error).name}`,
      );
    }
    await this.mailer.sendPasswordChanged(credential.identifier);
  }

  /**
   * The change did not happen, so the sessions flagged for it are still open: take the flags
   * off, but only from sessions that are really still open (one closed by something else in
   * the meantime keeps its flag). Best effort: the original error is what the caller gets.
   */
  private async unflag(
    userId: string,
    flaggedIds: string[],
    now: Date,
  ): Promise<void> {
    try {
      const open = new Set(
        (await this.sessionRepo.findActiveByUser(userId, now)).map(
          (session) => session.id,
        ),
      );
      await this.tokenStore.clearSessionsRevoked(
        flaggedIds.filter((id) => open.has(id)),
      );
    } catch (error) {
      this.logger.error(
        `Could not take the flags off the sessions after a failed password change: ${(error as Error).name}`,
      );
    }
  }
}
