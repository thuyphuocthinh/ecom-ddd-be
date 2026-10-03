import { describe, it, expect } from 'vitest';
import {
  createEmailSender,
  smtpOptionsFromEnv,
} from './email-sender.factory.js';
import { LogEmailSender } from './log-email-sender.js';
import { SmtpEmailSender } from './smtp-email-sender.js';

const SMTP_ENV = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  EMAIL_FROM: 'Ecom <no-reply@example.com>',
};

describe('createEmailSender', () => {
  it('uses the log adapter for "log"', () => {
    expect(createEmailSender({ EMAIL_PROVIDER: 'log' })).toBeInstanceOf(
      LogEmailSender,
    );
  });

  it('defaults to the log adapter when EMAIL_PROVIDER is not set', () => {
    expect(createEmailSender({})).toBeInstanceOf(LogEmailSender);
  });

  it('uses the SMTP adapter for "smtp"', () => {
    expect(createEmailSender(SMTP_ENV)).toBeInstanceOf(SmtpEmailSender);
  });

  it('fails loudly for a provider it does not know, instead of silently not sending', () => {
    expect(() =>
      createEmailSender({ EMAIL_PROVIDER: 'carrier-pigeon' }),
    ).toThrow(/carrier-pigeon/);
  });
});

describe('smtpOptionsFromEnv', () => {
  it('defaults to port 587 with STARTTLS (not TLS from the first byte)', () => {
    expect(smtpOptionsFromEnv(SMTP_ENV)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: undefined,
      pass: undefined,
      from: 'Ecom <no-reply@example.com>',
    });
  });

  it('turns on TLS from the first byte for port 465', () => {
    expect(smtpOptionsFromEnv({ ...SMTP_ENV, SMTP_PORT: '465' })).toMatchObject(
      {
        port: 465,
        secure: true,
      },
    );
  });

  it('lets SMTP_SECURE override what the port suggests', () => {
    expect(
      smtpOptionsFromEnv({
        ...SMTP_ENV,
        SMTP_PORT: '465',
        SMTP_SECURE: 'false',
      }),
    ).toMatchObject({ secure: false });
    expect(
      smtpOptionsFromEnv({
        ...SMTP_ENV,
        SMTP_PORT: '2465',
        SMTP_SECURE: 'true',
      }),
    ).toMatchObject({ port: 2465, secure: true });
  });

  it('passes the login through, and treats empty values as no login', () => {
    expect(
      smtpOptionsFromEnv({
        ...SMTP_ENV,
        SMTP_USER: 'apikey',
        SMTP_PASS: 'secret',
      }),
    ).toMatchObject({ user: 'apikey', pass: 'secret' });
    expect(
      smtpOptionsFromEnv({ ...SMTP_ENV, SMTP_USER: '', SMTP_PASS: '' }),
    ).toMatchObject({ user: undefined, pass: undefined });
  });
});
