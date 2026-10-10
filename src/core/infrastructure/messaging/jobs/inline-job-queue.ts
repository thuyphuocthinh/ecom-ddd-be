import { Logger } from '@nestjs/common';
import type { IJobQueue, JobDefinition, JobHandler } from './job-queue.port.js';
import { describeFailure } from './job-failure.js';
import { assertValidDelay } from './job-delay.js';

/**
 * Runs the job right away, inside the call to `enqueue`, or after `job.delayMs` when the job
 * has one. For tests and for development without a broker. There are no retries: a handler
 * that throws is logged and dropped. A delayed job waits in a timer in memory, so it is lost
 * when the process stops: that is fine for development and tests, not for production.
 */
export class InlineJobQueue implements IJobQueue {
  private readonly logger = new Logger(InlineJobQueue.name);
  private readonly handlers = new Map<string, JobHandler<never>>();

  register<T>(job: JobDefinition<T>, handler: JobHandler<T>): void {
    assertValidDelay(job);
    this.handlers.set(job.name, handler as JobHandler<never>);
  }

  async enqueue<T>(job: JobDefinition<T>, data: T): Promise<void> {
    assertValidDelay(job);
    const handler = this.handlers.get(job.name) as JobHandler<T> | undefined;
    if (!handler) {
      this.logger.warn(`No handler registered for job "${job.name}"; dropped`);
      return;
    }
    if (job.delayMs !== undefined) {
      // `unref` so a pending timer never keeps the process alive when the app shuts down
      setTimeout(() => void this.run(job, handler, data), job.delayMs).unref();
      return;
    }
    await this.run(job, handler, data);
  }

  private async run<T>(
    job: JobDefinition<T>,
    handler: JobHandler<T>,
    data: T,
  ): Promise<void> {
    try {
      await handler(data);
    } catch (error) {
      // Only the kind of failure is logged: the payload and the provider's message can hold
      // personal data (an email address, a one-time code)
      this.logger.error(
        `Job "${job.name}" failed (no retries inline): ${describeFailure(error)}`,
      );
    }
  }
}
