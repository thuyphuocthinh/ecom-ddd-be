import { Inject, Injectable } from '@nestjs/common';
import {
  EMAIL_DISPATCHER,
  appConfig,
  type AppConfig,
  type IEmailDispatcher,
} from '@/core/index.js';
import { CACHE } from '@/core/infrastructure/redis/cache.constants.js';
import { buildVerificationEmail } from './verification-email.js';

/**
 * Emails a registration code. The email is handed to the background queue, which sends it
 * and retries when the provider fails; this returns once the queue has accepted it, not once
 * it was delivered. It rejects only when the queue could not take it, and then no code
 * reached the user, so the caller has to give the send slot back.
 */
@Injectable()
export class VerificationMailer {
  constructor(
    @Inject(EMAIL_DISPATCHER) private readonly dispatcher: IEmailDispatcher,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  async sendCode(email: string, code: string): Promise<void> {
    await this.dispatcher.dispatch(
      buildVerificationEmail({
        to: email,
        appName: this.app.name,
        code,
        validForMinutes: CACHE.AUTH.SETTINGS.OTP_TTL / 60,
      }),
    );
  }
}
