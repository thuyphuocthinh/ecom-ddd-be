import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailDispatcher, EmailJobHandler, SEND_EMAIL } from './email.job.js';
import { JobPayloadCipher } from '../messaging/jobs/job-payload-cipher.js';
import type { IEmailSender } from './email-sender.port.js';
import type { IJobQueue } from '../messaging/jobs/job-queue.port.js';

const MESSAGE = {
  to: 'jane.doe@example.com',
  subject: 'Your code',
  text: 'Code: 482915',
  html: '<p>482915</p>',
};

describe('send-email job', () => {
  let cipher: JobPayloadCipher;
  let jobs: {
    enqueue: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
  };
  let sender: { send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    cipher = new JobPayloadCipher('s'.repeat(32), 'jobs-email-v1');
    jobs = { enqueue: vi.fn().mockResolvedValue(undefined), register: vi.fn() };
    sender = { send: vi.fn().mockResolvedValue(undefined) };
  });

  it('retries after 10 s, 30 s and 90 s and runs five at a time', () => {
    expect(SEND_EMAIL.name).toBe('send-email');
    expect(SEND_EMAIL.retryDelaysMs).toEqual([10_000, 30_000, 90_000]);
    expect(SEND_EMAIL.concurrency).toBe(5);
  });

  describe('EmailDispatcher', () => {
    it('puts the email on the queue as one encrypted payload and nothing else (AC-5)', async () => {
      const dispatcher = new EmailDispatcher(
        jobs as unknown as IJobQueue,
        cipher,
      );

      await dispatcher.dispatch(MESSAGE);

      expect(jobs.enqueue).toHaveBeenCalledOnce();
      const [job, data] = jobs.enqueue.mock.calls[0];
      expect(job).toBe(SEND_EMAIL);
      expect(Object.keys(data)).toEqual(['payload']);
      const json = JSON.stringify(data);
      expect(json).not.toContain('jane.doe');
      expect(json).not.toContain('482915');
      expect(cipher.decrypt(data.payload)).toEqual(MESSAGE);
    });

    it('lets the failure through when the queue cannot take the job', async () => {
      jobs.enqueue.mockRejectedValue(new Error('queue down'));
      const dispatcher = new EmailDispatcher(
        jobs as unknown as IJobQueue,
        cipher,
      );

      await expect(dispatcher.dispatch(MESSAGE)).rejects.toThrow('queue down');
    });
  });

  describe('EmailJobHandler', () => {
    const build = () =>
      new EmailJobHandler(
        jobs as unknown as IJobQueue,
        sender as unknown as IEmailSender,
        cipher,
      );

    it('registers itself for the send-email job when the module starts', () => {
      build().onModuleInit();

      expect(jobs.register).toHaveBeenCalledWith(
        SEND_EMAIL,
        expect.any(Function),
      );
    });

    it('decrypts the payload and sends exactly that message (AC-2)', async () => {
      await build().handle({ payload: cipher.encrypt(MESSAGE) });

      expect(sender.send).toHaveBeenCalledWith(MESSAGE);
    });

    it('rethrows a failure from the provider so the job is retried (AC-3)', async () => {
      sender.send.mockRejectedValue(new Error('provider down'));

      await expect(
        build().handle({ payload: cipher.encrypt(MESSAGE) }),
      ).rejects.toThrow('provider down');
    });

    it('fails, rather than sending something, on a payload it cannot decrypt', async () => {
      await expect(build().handle({ payload: 'garbage' })).rejects.toThrow();

      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
