import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { ResendVerificationCommand } from './resend-verification.command.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { CACHE } from '@/core/infrastructure/cache/cache.constants.js';
import { AuthDomainException } from '../../domain/index.js';
import { OtpService } from '../services/otp.service.js';
import { VerificationMailer } from '../services/verification-mailer.service.js';
import { PendingSignupStore } from '../../infrastructure/index.js';

@CommandHandler(ResendVerificationCommand)
export class ResendVerificationHandler implements ICommandHandler<ResendVerificationCommand> {
  constructor(
    private readonly otpService: OtpService,
    private readonly pendingSignups: PendingSignupStore,
    private readonly mailer: VerificationMailer,
  ) {}

  /**
   * Sends a fresh code for a registration that is waiting for one.
   *
   * With nothing waiting (never registered, already has an account, or the
   * registration timed out) it says so instead of pretending to succeed: a user
   * whose registration expired must be told to register again, not left waiting for
   * an email that is never coming. The same answer covers "has an account" and
   * "unknown", so it does not reveal which addresses have accounts.
   */
  async execute(
    command: ResendVerificationCommand,
  ): Promise<{ resendAvailableInSeconds: number }> {
    const { email } = command;

    if (!(await this.pendingSignups.get(email))) {
      throw new AuthDomainException(AuthErrorCodes.NO_PENDING_REGISTRATION);
    }

    // The cooldown and the hourly allowance cap how many codes one address gets
    await this.otpService.reserveSend('REGISTER_EMAIL', email);

    try {
      const code = await this.otpService.issue('REGISTER_EMAIL', email);
      // Handed to the background queue, which sends it and retries on failure
      await this.mailer.sendCode(email, code);
    } catch (error) {
      // No code can reach the user: don't make them wait out the cooldown
      await this.otpService.releaseSend('REGISTER_EMAIL', email);
      throw error;
    }

    return {
      resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
    };
  }
}
