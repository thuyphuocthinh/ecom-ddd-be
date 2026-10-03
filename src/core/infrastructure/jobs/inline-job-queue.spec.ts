import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { InlineJobQueue } from './inline-job-queue.js';
import { defineJob } from './job-queue.port.js';

const JOB = defineJob<{ to: string }>({
  name: 'send-email',
  retryDelaysMs: [],
});

describe('InlineJobQueue', () => {
  let queue: InlineJobQueue;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: any) => {
        logged.push(String(message));
      });
    }
    queue = new InlineJobQueue();
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs the handler right away, inside the call (AC-9)', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    queue.register(JOB, handler);

    await queue.enqueue(JOB, { to: 'a@example.com' });

    expect(handler).toHaveBeenCalledWith({ to: 'a@example.com' });
  });

  it('logs a failing handler without the data and does not throw or retry (AC-9)', async () => {
    const handler = vi.fn().mockRejectedValue(
      Object.assign(new Error('550 <a@example.com> unknown'), {
        code: 'EENVELOPE',
      }),
    );
    queue.register(JOB, handler);

    await expect(
      queue.enqueue(JOB, { to: 'a@example.com' }),
    ).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledOnce();
    const everything = logged.join('\n');
    expect(everything).toContain('EENVELOPE');
    expect(everything).not.toContain('a@example.com');
  });

  it('drops a job nobody handles, with a warning', async () => {
    await expect(
      queue.enqueue(JOB, { to: 'a@example.com' }),
    ).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('No handler registered');
  });
});
