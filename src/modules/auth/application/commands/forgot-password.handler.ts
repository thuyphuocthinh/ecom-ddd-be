import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import {
  JOB_QUEUE,
  type IJobQueue,
  type JobPayloadCipher,
} from '@/core/index.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import { ForgotPasswordCommand } from './forgot-password.command.js';
import { OtpService } from '../services/otp.service.js';
import {
  PASSWORD_RESET_PAYLOAD_CIPHER,
  REQUEST_PASSWORD_RESET,
  type PasswordResetRequest,
} from '../jobs/request-password-reset.job.js';

/**
 * Starts a password reset. It does the same thing for every address, with or without an
 * account: ask permission to send (the cooldown and hourly limit apply to all alike), put one
 * job on the queue, answer. A background worker looks the account up and sends the code, so
 * neither the answer nor the time it takes says whether the address is registered.
 */
@CommandHandler(ForgotPasswordCommand)
export class ForgotPasswordHandler implements ICommandHandler<ForgotPasswordCommand> {
  constructor(
    private readonly otpService: OtpService,
    @Inject(JOB_QUEUE) private readonly jobs: IJobQueue,
    @Inject(PASSWORD_RESET_PAYLOAD_CIPHER)
    private readonly cipher: JobPayloadCipher,
  ) {}

  async execute(
    command: ForgotPasswordCommand,
  ): Promise<{ resendAvailableInSeconds: number }> {
    const { email } = command;

    await this.otpService.reserveSend('RESET_PASSWORD', email);

    try {
      await this.jobs.enqueue(REQUEST_PASSWORD_RESET, {
        payload: this.cipher.encrypt<PasswordResetRequest>({ email }),
      });
    } catch (error) {
      // Nothing was queued, so no code will come: do not make the person wait out the cooldown.
      // This failure is the same for every address, so it tells nothing about accounts.
      await this.otpService.releaseSend('RESET_PASSWORD', email);
      throw error;
    }

    return {
      resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
    };
  }
}
