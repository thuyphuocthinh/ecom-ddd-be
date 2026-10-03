export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always present: it is what text-only clients show and what spam filters like to see alongside the HTML. */
  text: string;
  /** HTML body. Sent together with `text` as a multipart message. */
  html?: string;
}

/**
 * Sends an email. One adapter per provider; the rest of the app only knows this port.
 * `send` rejects when the provider fails, so callers decide whether that matters.
 */
export interface IEmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** DI token for the active IEmailSender. */
export const EMAIL_SENDER = 'IEmailSender';
