import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CredentialProvider } from '@prisma/client';
import { VerifyEmailCommand } from './verify-email.command.js';
import { User } from '../../../users/domain/index.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { AuthDomainException } from '../../domain/index.js';
import { OtpService } from '../services/otp.service.js';
import { SessionIssuer } from '../services/session-issuer.service.js';
import { PendingSignupStore } from '../../infrastructure/index.js';

/**
 * Second half of registration: the right code turns the pending registration into
 * an account and logs the new user in.
 */
@CommandHandler(VerifyEmailCommand)
export class VerifyEmailHandler implements ICommandHandler<VerifyEmailCommand> {
  private readonly logger = new Logger(VerifyEmailHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    private readonly otpService: OtpService,
    private readonly pendingSignups: PendingSignupStore,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(
    command: VerifyEmailCommand,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const { email, code, client } = command;

    // 1. Check the code. Wrong, expired, used up, over the attempt limit and
    // never-issued all answer the same, so the reply says nothing about which.
    if (!(await this.otpService.verify('REGISTER_EMAIL', email, code))) {
      throw this.invalidCode();
    }

    // 2. There must be a registration waiting for this address
    const pending = await this.pendingSignups.get(email);
    if (!pending) {
      throw this.invalidCode();
    }

    // 3. Use the code up. Of several concurrent requests with the same correct
    // code exactly one gets true here; the others stop, so only one account is made.
    if (!(await this.otpService.consume('REGISTER_EMAIL', email))) {
      throw this.invalidCode();
    }

    // 4. Create the account. A unique-constraint race with another registration
    // of the same address surfaces as the usual 409 from the repository.
    const user = User.create(randomUUID(), undefined, pending.displayName);
    user.addCredential(
      randomUUID(),
      CredentialProvider.EMAIL,
      email,
      pending.passwordHash,
    );
    await this.userRepo.save(user);

    // 5. The registration is done: drop it BEFORE logging in, so a failure while starting the
    // session cannot leave a pending registration for an address that now has an account.
    // Failing to tidy up must not undo the account.
    try {
      await this.pendingSignups.delete(email);
    } catch (error: any) {
      this.logger.warn(
        `Could not remove the pending registration: ${error.message}`,
      );
    }

    // 6. Log the new user in
    return this.sessionIssuer.start(user, client);
  }

  private invalidCode(): AuthDomainException {
    return new AuthDomainException(
      AuthErrorCodes.INVALID_VERIFICATION_CODE,
      'Invalid or expired verification code',
    );
  }
}
