import { describe, it, expect, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { SmtpEmailSender } from './smtp-email-sender.js';

const OPTIONS = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  from: 'Ecom <no-reply@example.com>',
};

// nodemailer's JSON transport builds the real message but "sends" it into a string, so
// the test sees exactly what would have gone out, without opening a connection.
const capturing = () => {
  const transporter = nodemailer.createTransport({ jsonTransport: true });
  const sendMail = vi.spyOn(transporter, 'sendMail');
  const lastMessage = async () => {
    const info = await sendMail.mock.results[0].value;
    return JSON.parse(info.message);
  };
  return { transporter, sendMail, lastMessage };
};

describe('SmtpEmailSender', () => {
  it('sends from the configured address to the recipient with subject, text and HTML', async () => {
    const { transporter, lastMessage } = capturing();

    await new SmtpEmailSender(OPTIONS, transporter).send({
      to: 'a@example.com',
      subject: 'Hello',
      text: 'plain body',
      html: '<p>html body</p>',
    });

    const sent = await lastMessage();
    expect(sent.from.address).toBe('no-reply@example.com');
    expect(sent.from.name).toBe('Ecom');
    expect(sent.to[0].address).toBe('a@example.com');
    expect(sent.subject).toBe('Hello');
    expect(sent.text).toBe('plain body');
    expect(sent.html).toBe('<p>html body</p>');
  });

  it('sends a text-only message when there is no HTML', async () => {
    const { transporter, lastMessage } = capturing();

    await new SmtpEmailSender(OPTIONS, transporter).send({
      to: 'a@example.com',
      subject: 'Hello',
      text: 'plain body',
    });

    const sent = await lastMessage();
    expect(sent.text).toBe('plain body');
    expect(sent.html).toBeUndefined();
  });

  it('rejects when the server refuses, so the caller can decide what that means', async () => {
    const { transporter, sendMail } = capturing();
    sendMail.mockRejectedValue(new Error('550 mailbox unavailable'));

    await expect(
      new SmtpEmailSender(OPTIONS, transporter).send({
        to: 'a@example.com',
        subject: 'Hello',
        text: 'plain body',
      }),
    ).rejects.toThrow('550 mailbox unavailable');
  });

  it('can be built from options alone, without opening a connection', () => {
    expect(
      () => new SmtpEmailSender({ ...OPTIONS, user: 'apikey', pass: 'secret' }),
    ).not.toThrow();
  });

  describe('transport security', () => {
    const transportOptionsFor = (options: object) => {
      const create = vi.spyOn(nodemailer, 'createTransport');
      new SmtpEmailSender({ ...OPTIONS, ...options });
      const passed = create.mock.calls[0][0] as { requireTLS?: boolean };
      create.mockRestore();
      return passed;
    };

    it('refuses to continue unencrypted when credentials go over a plain port', () => {
      expect(transportOptionsFor({ user: 'u', pass: 'p' }).requireTLS).toBe(
        true,
      );
    });

    it('does not insist on TLS for an implicit-TLS port or a local relay without credentials', () => {
      expect(
        transportOptionsFor({ secure: true, user: 'u', pass: 'p' }).requireTLS,
      ).toBe(false);
      expect(transportOptionsFor({}).requireTLS).toBe(false);
    });
  });
});
