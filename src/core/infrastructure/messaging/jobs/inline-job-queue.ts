import { Logger } from '@nestjs/common';
import type { IJobQueue, JobDefinition, JobHandler } from './job-queue.port.js';
import { describeFailure } from './job-failure.js';

/**
 * Runs the job right away, inside the call to `enqueue`. For tests and for development
 * without a broker. There are no retries: a handler that throws is logged and dropped.
 */
export class InlineJobQueue implements IJobQueue {
  private readonly logger = new Logger(InlineJobQueue.name);
  private readonly handlers = new Map<string, JobHandler<never>>();

  register<T>(job: JobDefinition<T>, handler: JobHandler<T>): void {
    this.handlers.set(job.name, handler as JobHandler<never>);
  }

  async enqueue<T>(job: JobDefinition<T>, data: T): Promise<void> {
    const handler = this.handlers.get(job.name) as JobHandler<T> | undefined;
    if (!handler) {
      this.logger.warn(`No handler registered for job "${job.name}"; dropped`);
      return;
    }
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
