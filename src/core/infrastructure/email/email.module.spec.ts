import { describe, it, expect, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { EmailModule } from './email.module.js';
import { EMAIL_SENDER } from './email-sender.port.js';
import { LogEmailSender } from './log-email-sender.js';

describe('EmailModule', () => {
  const original = process.env.EMAIL_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = original;
  });

  it('provides the adapter chosen by EMAIL_PROVIDER under the IEmailSender token', async () => {
    process.env.EMAIL_PROVIDER = 'log';

    const moduleRef = await Test.createTestingModule({
      imports: [EmailModule],
    }).compile();

    expect(moduleRef.get(EMAIL_SENDER)).toBeInstanceOf(LogEmailSender);
  });
});
