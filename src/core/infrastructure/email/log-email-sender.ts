import { Logger } from '@nestjs/common';
import type { EmailMessage, IEmailSender } from './email-sender.port.js';

/**
 * Development adapter: prints the email instead of sending it, so the developer
 * can read the one-time code from the server log. It deliberately logs the body,
 * which is why `validateEnv` refuses it in production.
 */
export class LogEmailSender implements IEmailSender {
  private readonly logger = new Logger(LogEmailSender.name);

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(
      `\n--- email (not sent: EMAIL_PROVIDER=log) ---\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n--------------------------------------------`,
    );
  }
}
