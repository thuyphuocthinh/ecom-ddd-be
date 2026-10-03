import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { EmailMessage, IEmailSender } from './email-sender.port.js';

export interface SmtpOptions {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). With `false` the connection is upgraded with STARTTLS when the server offers it (port 587). */
  secure: boolean;
  /** Both or neither: some relays accept mail from a trusted network without logging in. */
  user?: string;
  pass?: string;
  /** The From header, e.g. `Ecom <no-reply@example.com>`. */
  from: string;
}

// A provider that hangs must not hang the request that is waiting on it
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Sends email through any SMTP server (a hosted provider, Gmail's SMTP, a local relay...).
 * The message goes out as multipart text + HTML.
 */
export class SmtpEmailSender implements IEmailSender {
  private readonly transporter: Transporter;

  constructor(
    private readonly options: SmtpOptions,
    // Injectable so tests can capture the message instead of opening a connection
    transporter?: Transporter,
  ) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        // With credentials on a plain port, refuse to continue unencrypted if the server (or someone
        // in between) drops STARTTLS, rather than send the password and codes in clear text.
        // A local relay without credentials (e.g. a dev mail catcher) keeps working without TLS.
        requireTLS: !options.secure && options.user !== undefined,
        auth:
          options.user !== undefined
            ? { user: options.user, pass: options.pass }
            : undefined,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        greetingTimeout: GREETING_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
      });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
