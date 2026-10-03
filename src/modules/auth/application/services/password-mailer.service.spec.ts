import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { PasswordMailer } from './password-mailer.service.js';
import {
  buildPasswordChangedEmail,
  buildPasswordResetCodeEmail,
} from './password-emails.js';
import type { AppConfig, IEmailDispatcher } from '@/core/index.js';

describe('buildPasswordResetCodeEmail', () => {
  const build = () =>
    buildPasswordResetCodeEmail({
      to: 'a@example.com',
      appName: 'Ecom',
      code: '482915',
      validForMinutes: 10,
    });

  it('carries the code and its lifetime in both the text and the HTML', () => {
    const message = build();

    for (const body of [message.text, message.html!]) {
      expect(body).toContain('482915');
      expect(body).toContain('10 phút');
    }
    expect(message.to).toBe('a@example.com');
  });

  it('keeps the code out of the subject, which shows on lock screens', () => {
    expect(build().subject).not.toContain('482915');
  });

  it('says why it was sent and that ignoring it leaves the password unchanged', () => {
    const { text } = build();

    expect(text).toContain('yêu cầu đặt lại mật khẩu');
    expect(text).toContain('mật khẩu của bạn chưa bị thay đổi');
    expect(text).toContain('Không chia sẻ mã này');
  });
});

describe('buildPasswordChangedEmail', () => {
  const message = buildPasswordChangedEmail({
    to: 'a@example.com',
    appName: 'Ecom',
  });

  it('tells the owner the password changed and what to do if it was not them', () => {
    expect(message.text).toContain('vừa được thay đổi');
    expect(message.text).toContain('Quên mật khẩu');
    expect(message.subject).toContain('Ecom');
  });

  it('carries no code and no password', () => {
    expect(message.text).not.toMatch(/\d{6}/);
  });
});

describe('PasswordMailer', () => {
  let dispatcher: { dispatch: ReturnType<typeof vi.fn> };
  let mailer: PasswordMailer;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    mailer = new PasswordMailer(
      dispatcher as unknown as IEmailDispatcher,
      { name: 'Ecom' } as AppConfig,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('hands the reset code email to the dispatcher', async () => {
    await mailer.sendResetCode('a@example.com', '482915');

    const message = dispatcher.dispatch.mock.calls[0][0];
    expect(message.to).toBe('a@example.com');
    expect(message.text).toContain('482915');
  });

  it('lets the failure through when the reset code cannot be queued, so the job is retried', async () => {
    dispatcher.dispatch.mockRejectedValue(new ServiceUnavailableException());

    await expect(
      mailer.sendResetCode('a@example.com', '482915'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('hands the "password changed" notice to the dispatcher', async () => {
    await mailer.sendPasswordChanged('a@example.com');

    expect(dispatcher.dispatch.mock.calls[0][0].to).toBe('a@example.com');
  });

  it('swallows a failure to queue the notice and logs it without the address (AC-12)', async () => {
    dispatcher.dispatch.mockRejectedValue(new ServiceUnavailableException());

    await expect(
      mailer.sendPasswordChanged('a@example.com'),
    ).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('Could not queue');
    expect(logged.join('\n')).not.toContain('a@example.com');
  });
});
