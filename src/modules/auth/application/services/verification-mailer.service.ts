import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EMAIL_SENDER,
  appConfig,
  type AppConfig,
  type IEmailSender,
} from '@/core/index.js';
import { CACHE } from '@/core/infrastructure/cache/cache.constants.js';
import { buildVerificationEmail } from './verification-email.js';

/**
 * Emails a registration code. A failed send is logged and reported as `false`, not thrown:
 * the pending registration is already saved and the code already stored, so the
 * user can simply ask for the code again. Failing the request here would turn a
 * provider outage into a lost registration.
 */
@Injectable()
export class VerificationMailer {
  private readonly logger = new Logger(VerificationMailer.name);

  constructor(
    @Inject(EMAIL_SENDER) private readonly emailSender: IEmailSender,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  /** True when the provider accepted the message. */
  async sendCode(email: string, code: string): Promise<boolean> {
    try {
      await this.emailSender.send(
        buildVerificationEmail({
          to: email,
          appName: this.app.name,
          code,
          validForMinutes: CACHE.AUTH.SETTINGS.OTP_TTL / 60,
        }),
      );
      return true;
    } catch (error: any) {
      // Neither the code nor the address goes into the log. SMTP error text often quotes the
      // recipient ("550 5.1.1 <a@x.com> ..."), so only the error type and codes are logged.
      const reason = [error?.code, error?.responseCode, error?.name]
        .filter(Boolean)
        .join(' ');
      this.logger.error(
        `Could not send the verification email: ${reason || 'unknown error'}`,
      );
      return false;
    }
  }
}
