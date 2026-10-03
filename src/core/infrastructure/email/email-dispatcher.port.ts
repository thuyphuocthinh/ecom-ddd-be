import type { EmailMessage } from './email-sender.port.js';

/**
 * Hands an email over for delivery. Unlike `IEmailSender.send`, it returns once the message
 * is accepted, not once it is delivered: the actual sending happens in the background, with
 * retries. Rejects only when the message could not be accepted (the queue is unavailable).
 */
export interface IEmailDispatcher {
  dispatch(message: EmailMessage): Promise<void>;
}

/** DI token for the active IEmailDispatcher. */
export const EMAIL_DISPATCHER = 'IEmailDispatcher';
