import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { LogEmailSender } from './log-email-sender.js';

describe('LogEmailSender', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints the whole message (including the one-time code) instead of sending it', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await new LogEmailSender().send({
      to: 'a@example.com',
      subject: 'Your code',
      text: 'Code: 123456',
    });

    const printed = String(log.mock.calls[0][0]);
    expect(printed).toContain('a@example.com');
    expect(printed).toContain('Your code');
    expect(printed).toContain('123456');
  });

  it('resolves, so a caller can treat it like any other sender', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await expect(
      new LogEmailSender().send({
        to: 'a@example.com',
        subject: 's',
        text: 't',
      }),
    ).resolves.toBeUndefined();
  });
});
