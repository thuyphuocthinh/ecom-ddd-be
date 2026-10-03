import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { VerificationMailer } from './verification-mailer.service.js';
import { buildVerificationEmail } from './verification-email.js';
import type { AppConfig, IEmailSender } from '@/core/index.js';

describe('buildVerificationEmail', () => {
  const build = () =>
    buildVerificationEmail({
      to: 'a@example.com',
      appName: 'Ecom',
      code: '482915',
      validForMinutes: 10,
    });

  it('is addressed to the recipient and names the shop in the subject', () => {
    const message = build();

    expect(message.to).toBe('a@example.com');
    expect(message.subject).toContain('Ecom');
  });

  it('carries the code and its lifetime in both the text and the HTML', () => {
    const message = build();

    for (const body of [message.text, message.html!]) {
      expect(body).toContain('482915');
      expect(body).toContain('10 phút');
      expect(body).toContain('Ecom');
    }
  });

  it('keeps the code out of the subject, which shows on lock screens and notification previews', () => {
    expect(build().subject).not.toContain('482915');
  });

  it('tells the reader why they got it and not to share the code', () => {
    const { text } = build();

    expect(text).toContain('Bạn nhận được email này vì');
    expect(text).toContain('Không chia sẻ mã này');
  });
});

describe('VerificationMailer', () => {
  let mailer: VerificationMailer;
  let sender: { send: ReturnType<typeof vi.fn> };
  const app = { name: 'Ecom' } as AppConfig;

  beforeEach(() => {
    sender = { send: vi.fn().mockResolvedValue(undefined) };
    mailer = new VerificationMailer(sender as unknown as IEmailSender, app);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends the email with the code to the address (AC-1)', async () => {
    await mailer.sendCode('a@example.com', '482915');

    expect(sender.send).toHaveBeenCalledOnce();
    const message = sender.send.mock.calls[0][0];
    expect(message.to).toBe('a@example.com');
    expect(message.text).toContain('482915');
    expect(message.html).toContain('482915');
  });

  it('uses the configured shop name', async () => {
    mailer = new VerificationMailer(
      sender as unknown as IEmailSender,
      {
        name: 'Cửa hàng An',
      } as AppConfig,
    );

    await mailer.sendCode('a@example.com', '482915');

    expect(sender.send.mock.calls[0][0].subject).toContain('Cửa hàng An');
  });

  it('does not fail when the provider does: the user can ask for the code again (AC-10)', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    sender.send.mockRejectedValue(new Error('provider down'));

    await expect(
      mailer.sendCode('a@example.com', '482915'),
    ).resolves.toBeUndefined();
  });

  it('does not log the provider message, which often quotes the recipient (AC-11)', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    sender.send.mockRejectedValue(
      Object.assign(new Error('550 5.1.1 <a@example.com> user unknown'), {
        code: 'EENVELOPE',
        responseCode: 550,
      }),
    );

    await mailer.sendCode('a@example.com', '482915');

    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('EENVELOPE');
    expect(logged).toContain('550');
    expect(logged).not.toContain('a@example.com');
  });

  it('logs the failure without the code or the address (AC-10, AC-11)', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    sender.send.mockRejectedValue(new Error('provider down'));

    await mailer.sendCode('a@example.com', '482915');

    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('Could not send the verification email');
    expect(logged).not.toContain('482915');
    expect(logged).not.toContain('a@example.com');
  });
});
