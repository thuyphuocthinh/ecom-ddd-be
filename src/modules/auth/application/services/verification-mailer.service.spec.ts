import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { VerificationMailer } from './verification-mailer.service.js';
import { buildVerificationEmail } from './verification-email.js';
import type { AppConfig, IEmailDispatcher } from '@/core/index.js';

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
  let dispatcher: { dispatch: ReturnType<typeof vi.fn> };
  const app = { name: 'Ecom' } as AppConfig;

  beforeEach(() => {
    dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    mailer = new VerificationMailer(
      dispatcher as unknown as IEmailDispatcher,
      app,
    );
  });

  it('hands the email with the code to the dispatcher (AC-1)', async () => {
    await mailer.sendCode('a@example.com', '482915');

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    const message = dispatcher.dispatch.mock.calls[0][0];
    expect(message.to).toBe('a@example.com');
    expect(message.text).toContain('482915');
    expect(message.html).toContain('482915');
  });

  it('uses the configured shop name', async () => {
    mailer = new VerificationMailer(
      dispatcher as unknown as IEmailDispatcher,
      { name: 'Cửa hàng An' } as AppConfig,
    );

    await mailer.sendCode('a@example.com', '482915');

    expect(dispatcher.dispatch.mock.calls[0][0].subject).toContain(
      'Cửa hàng An',
    );
  });

  it('lets the failure through when the queue cannot take the email, so the caller can give the send slot back (AC-7)', async () => {
    dispatcher.dispatch.mockRejectedValue(new ServiceUnavailableException());

    await expect(
      mailer.sendCode('a@example.com', '482915'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
