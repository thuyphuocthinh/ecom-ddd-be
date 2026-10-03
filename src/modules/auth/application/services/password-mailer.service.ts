import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EMAIL_DISPATCHER,
  appConfig,
  type AppConfig,
  type IEmailDispatcher,
} from '@/core/index.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import {
  buildPasswordChangedEmail,
  buildPasswordResetCodeEmail,
} from './password-emails.js';

/**
 * The emails of the password flows. Both go through the background queue, which sends them
 * and retries when the provider fails.
 */
@Injectable()
export class PasswordMailer {
  private readonly logger = new Logger(PasswordMailer.name);

  constructor(
    @Inject(EMAIL_DISPATCHER) private readonly dispatcher: IEmailDispatcher,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  /** The code for resetting a password. Rejects when the queue cannot take the email. */
  async sendResetCode(email: string, code: string): Promise<void> {
    await this.dispatcher.dispatch(
      buildPasswordResetCodeEmail({
        to: email,
        appName: this.app.name,
        code,
        validForMinutes: CACHE.AUTH.SETTINGS.OTP_TTL / 60,
      }),
    );
  }

  /**
   * "Your password was changed". Only a notice: when it cannot be queued the password has
   * already been changed, so the failure is logged (without the address) and swallowed.
   */
  async sendPasswordChanged(email: string): Promise<void> {
    try {
      await this.dispatcher.dispatch(
        buildPasswordChangedEmail({ to: email, appName: this.app.name }),
      );
    } catch (error) {
      this.logger.error(
        `Could not queue the password-changed notice: ${(error as Error).name}`,
      );
    }
  }
}
