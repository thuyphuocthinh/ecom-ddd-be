import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { RegisterCommand } from './register.command.js';
import { UserDomainException } from '../../../users/domain/index.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import {
  AuthErrorCodes,
  UserErrorCodes,
} from '@/core/domain/exceptions/error-codes.js';
import { appConfig, type AppConfig } from '@/core/index.js';
import { AuthDomainException } from '../../domain/index.js';
import { findPasswordWeakness } from '../../domain/policies/password.policy.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import { CredentialProvider } from '@prisma/client';
import { OtpService } from '../services/otp.service.js';
import { VerificationMailer } from '../services/verification-mailer.service.js';
import { PendingSignupStore } from '../../infrastructure/index.js';

export interface RegistrationPending {
  verificationRequired: true;
  resendAvailableInSeconds: number;
  /** How long the registration is kept; after that the user has to register again. */
  verificationExpiresInSeconds: number;
}

/**
 * First half of registration. It does not create an account: it keeps the
 * registration in Redis and emails a code, and the account appears only once
 * VerifyEmailHandler sees that code. Until then there is nothing in the database
 * for anyone to log in to, or to squat on, using somebody else's address.
 */
@CommandHandler(RegisterCommand)
export class RegisterHandler implements ICommandHandler<RegisterCommand> {
  private readonly logger = new Logger(RegisterHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    private readonly otpService: OtpService,
    private readonly pendingSignups: PendingSignupStore,
    private readonly mailer: VerificationMailer,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  async execute(command: RegisterCommand): Promise<RegistrationPending> {
    this.logger.debug('Executing RegisterCommand');

    // 0. Refuse a password that is easy to guess before spending anything on it
    // (no email, no cooldown slot, no hashing)
    const weakness = findPasswordWeakness({
      password: command.plainPassword,
      email: command.email,
      appName: this.app.name,
    });
    if (weakness) {
      throw new AuthDomainException(AuthErrorCodes.WEAK_PASSWORD, {
        reason: weakness,
      });
    }

    // 1. An address that already has an account can't register again.
    // Not race-free on its own; VerifyEmailHandler's save maps the unique-constraint
    // violation to the same error.
    const existingUser = await this.userRepo.findByCredential(
      CredentialProvider.EMAIL,
      command.email,
    );
    if (existingUser) {
      throw new UserDomainException(
        UserErrorCodes.EMAIL_ALREADY_EXISTS,
        'Email is already registered',
      );
    }

    // 2. Ask permission to send BEFORE touching the saved registration: when the
    // address is still in its cooldown this throws 429 and the earlier pending
    // registration (and its password) stays exactly as it was.
    await this.otpService.reserveSend('REGISTER_EMAIL', command.email);

    try {
      const code = await this.otpService.issue('REGISTER_EMAIL', command.email);

      // 3. Keep the registration (password only as a hash) until the code is entered
      const passwordHash = await HashUtil.hashPassword(command.plainPassword);
      await this.pendingSignups.save(command.email, {
        passwordHash,
        displayName: command.displayName ?? null,
      });

      // 4. Hand the email to the background queue, which sends it and retries on failure
      await this.mailer.sendCode(command.email, code);
    } catch (error) {
      // No code can reach the user: don't make them wait out the cooldown
      await this.otpService.releaseSend('REGISTER_EMAIL', command.email);
      throw error;
    }

    return {
      verificationRequired: true,
      resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
      verificationExpiresInSeconds: CACHE.AUTH.SETTINGS.PENDING_SIGNUP_TTL,
    };
  }
}
