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

  describe('a job held back before its first run (delayMs, AC-17)', () => {
    const DELAYED = defineJob<{ orderId: string }>({
      name: 'release-reservation',
      delayMs: 2_000,
      retryDelaysMs: [],
    });

    afterEach(() => vi.useRealTimers());

    it('returns at once and runs the handler only after the delay', async () => {
      vi.useFakeTimers();
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.register(DELAYED, handler);

      await queue.enqueue(DELAYED, { orderId: 'O1' });
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_999);
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ orderId: 'O1' });
    });

    it('only logs a handler that fails after the delay, like an immediate job', async () => {
      vi.useFakeTimers();
      queue.register(DELAYED, vi.fn().mockRejectedValue(new Error('boom')));

      await queue.enqueue(DELAYED, { orderId: 'O1' });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(logged.join('\n')).toContain('failed (no retries inline)');
    });

    it('does not keep the process alive while it waits', async () => {
      const unref = vi.fn();
      vi.spyOn(globalThis, 'setTimeout').mockReturnValue({
        unref,
      } as unknown as NodeJS.Timeout);
      queue.register(DELAYED, vi.fn().mockResolvedValue(undefined));

      await queue.enqueue(DELAYED, { orderId: 'O1' });

      expect(unref).toHaveBeenCalledOnce();
    });

    it.each([0, -1, 1.5, Number.NaN, 604_800_001])(
      'refuses delayMs %s and names the job (AC-16)',
      async (delayMs) => {
        const bad = defineJob<{ orderId: string }>({
          name: 'release-reservation',
          delayMs,
          retryDelaysMs: [],
        });

        expect(() => queue.register(bad, vi.fn())).toThrow(
          /release-reservation/,
        );
        await expect(queue.enqueue(bad, { orderId: 'O1' })).rejects.toThrow(
          /release-reservation/,
        );
      },
    );
  });
});
