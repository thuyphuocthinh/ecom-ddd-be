import type { IEmailSender } from './email-sender.port.js';
import { LogEmailSender } from './log-email-sender.js';
import { SmtpEmailSender, type SmtpOptions } from './smtp-email-sender.js';

const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_PORT = 465;

/** Reads the SMTP settings (already checked by `validateEnv`) from the environment. */
export function smtpOptionsFromEnv(env: NodeJS.ProcessEnv): SmtpOptions {
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : DEFAULT_SMTP_PORT;
  return {
    host: env.SMTP_HOST as string,
    port,
    // Port 465 speaks TLS from the first byte; other ports start plain and upgrade
    secure: env.SMTP_SECURE
      ? env.SMTP_SECURE === 'true'
      : port === IMPLICIT_TLS_PORT,
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.EMAIL_FROM as string,
  };
}

/** Picks the adapter for `EMAIL_PROVIDER` (validated at boot by `validateEnv`). */
export function createEmailSender(env: NodeJS.ProcessEnv): IEmailSender {
  const provider = env.EMAIL_PROVIDER ?? 'log';
  switch (provider) {
    case 'log':
      return new LogEmailSender();
    case 'smtp':
      return new SmtpEmailSender(smtpOptionsFromEnv(env));
    default:
      throw new Error(`Unknown EMAIL_PROVIDER "${provider}"`);
  }
}
