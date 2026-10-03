import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { EmailModule } from './email.module.js';
import { EMAIL_SENDER } from './email-sender.port.js';
import { EMAIL_DISPATCHER } from './email-dispatcher.port.js';
import { EmailDispatcher } from './email.job.js';
import { LogEmailSender } from './log-email-sender.js';
import { JobQueueModule } from '../messaging/jobs/job-queue.module.js';

describe('EmailModule', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.JOB_QUEUE = 'inline';
    process.env.JWT_ACCESS_SECRET = 's'.repeat(32);
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('provides the adapter chosen by EMAIL_PROVIDER under the IEmailSender token', async () => {
    process.env.EMAIL_PROVIDER = 'log';

    const moduleRef = await Test.createTestingModule({
      imports: [JobQueueModule, EmailModule],
    }).compile();

    expect(moduleRef.get(EMAIL_SENDER)).toBeInstanceOf(LogEmailSender);
  });

  it('provides the dispatcher that other features use to send email', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JobQueueModule, EmailModule],
    }).compile();

    expect(moduleRef.get(EMAIL_DISPATCHER)).toBeInstanceOf(EmailDispatcher);
  });

  it('sends a dispatched email through the sender, via the queue (inline: right away) (AC-9)', async () => {
    process.env.EMAIL_PROVIDER = 'log';
    const sent: unknown[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [JobQueueModule, EmailModule],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ send: async (message: unknown) => void sent.push(message) })
      .compile();
    await moduleRef.init();

    await moduleRef.get(EMAIL_DISPATCHER).dispatch({
      to: 'a@example.com',
      subject: 'Hi',
      text: 'Hello',
    });

    expect(sent).toEqual([
      { to: 'a@example.com', subject: 'Hi', text: 'Hello' },
    ]);
    await moduleRef.close();
  });
});
