import type { JobDefinition } from './job-queue.port.js';

/** The longest a job may be held back before its first run: 7 days. */
export const MAX_JOB_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Throws when `delayMs` is set to anything but a whole number of milliseconds from 1 up to
 * 7 days. Both adapters call this the first time they see a job, before declaring any queue
 * or starting any timer, so a wrong delay fails at once and names the job.
 */
export function assertValidDelay(job: JobDefinition<any>): void {
  if (job.delayMs === undefined) return;
  if (
    !Number.isInteger(job.delayMs) ||
    job.delayMs < 1 ||
    job.delayMs > MAX_JOB_DELAY_MS
  ) {
    throw new Error(
      `Job "${job.name}" needs a delay of 1 to ${MAX_JOB_DELAY_MS} milliseconds (a whole number)`,
    );
  }
}
