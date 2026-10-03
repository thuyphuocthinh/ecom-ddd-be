import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EMAIL_DISPATCHER,
  appConfig,
  type AppConfig,
  type IEmailDispatcher,
} from '@/core/index.js';
import { buildGoogleLinkedEmail } from './google-linked-email.js';

/** Notices about changes to how an account can be logged in to. They only inform. */
@Injectable()
export class AccountMailer {
  private readonly logger = new Logger(AccountMailer.name);

  constructor(
    @Inject(EMAIL_DISPATCHER) private readonly dispatcher: IEmailDispatcher,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
  ) {}

  /**
   * "A Google account was linked". The link already exists, so a failure to queue the notice is
   * logged (without the address) and swallowed rather than undoing the login.
   */
  async sendGoogleLinked(email: string): Promise<void> {
    try {
      await this.dispatcher.dispatch(
        buildGoogleLinkedEmail({ to: email, appName: this.app.name }),
      );
    } catch (error) {
      this.logger.error(
        `Could not queue the Google-linked notice: ${(error as Error).name}`,
      );
    }
  }
}
