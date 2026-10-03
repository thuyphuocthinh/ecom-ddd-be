import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AccountMailer } from './account-mailer.service.js';
import { buildGoogleLinkedEmail } from './google-linked-email.js';
import type { AppConfig, IEmailDispatcher } from '@/core/index.js';

describe('buildGoogleLinkedEmail', () => {
  const message = buildGoogleLinkedEmail({
    to: 'a@example.com',
    appName: 'Ecom',
  });

  it('tells the owner a Google account was linked and what to do if it was not them (AC-3)', () => {
    expect(message.to).toBe('a@example.com');
    expect(message.subject).toContain('Ecom');
    expect(message.text).toContain('Google');
    expect(message.text).toContain('Nếu không phải bạn');
    expect(message.text).toContain('đổi mật khẩu');
  });

  it('carries no code, no password and no link to click', () => {
    expect(message.text).not.toMatch(/\d{6}/);
    expect(message.text).not.toMatch(/https?:\/\//);
  });
});

describe('AccountMailer', () => {
  let dispatcher: { dispatch: ReturnType<typeof vi.fn> };
  let mailer: AccountMailer;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    mailer = new AccountMailer(
      dispatcher as unknown as IEmailDispatcher,
      { name: 'Ecom' } as AppConfig,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('hands the notice to the dispatcher', async () => {
    await mailer.sendGoogleLinked('a@example.com');

    expect(dispatcher.dispatch.mock.calls[0][0].to).toBe('a@example.com');
  });

  it('swallows a failure to queue it and logs it without the address (the link already exists)', async () => {
    dispatcher.dispatch.mockRejectedValue(new ServiceUnavailableException());

    await expect(
      mailer.sendGoogleLinked('a@example.com'),
    ).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('Could not queue');
    expect(logged.join('\n')).not.toContain('a@example.com');
  });
});
