/**
 * Describes one kind of background job. Business code declares these and never
 * touches the message broker: it only knows this port.
 */
export interface JobDefinition<T = unknown> {
  /** Unique, stable name (also the routing key). Lowercase words joined by dashes. */
  readonly name: string;
  /**
   * Wait before each retry, in milliseconds. Its length is the number of retries:
   * `[10_000, 30_000]` means up to 3 runs in total, the 2nd after 10 s and the 3rd after
   * 30 s more. A job that still fails after the last retry is set aside (dead-lettered).
   */
  readonly retryDelaysMs: readonly number[];
  /** How many jobs of this kind run at the same time. Default 1. */
  readonly concurrency?: number;
  /** Type-only marker so `enqueue` and `register` agree on the payload type. Never set. */
  readonly __payload?: T;
}

export type JobHandler<T> = (data: T) => Promise<void>;

/** Declares a job; the payload type is carried by `T`. Payloads must be plain JSON. */
export function defineJob<T>(
  definition: Omit<JobDefinition<T>, '__payload'>,
): JobDefinition<T> {
  return definition;
}

/**
 * Runs work in the background with retries. Delivery is at-least-once: a job can run
 * twice (e.g. the process died after doing the work but before confirming it), and jobs
 * of one kind are not guaranteed to run in order, so handlers must tolerate both.
 */
export interface IJobQueue {
  /**
   * Hands a job over and returns once it is safely stored, not once it has run.
   * Rejects with `ServiceUnavailableException` when it could not be stored.
   */
  enqueue<T>(job: JobDefinition<T>, data: T): Promise<void>;

  /**
   * Sets the handler that runs jobs of this kind. Call once, when the module starts. A
   * handler that throws gets the job retried per the definition.
   */
  register<T>(job: JobDefinition<T>, handler: JobHandler<T>): void;
}

/** DI token for the active IJobQueue. */
export const JOB_QUEUE = 'IJobQueue';

/** Tuning that only tests change; the defaults are the real behaviour. */
export interface JobQueueOptions {
  /** Prefix for exchange and queue names, so a test run never touches real queues. */
  namespace?: string;
  /** Multiplies every retry delay (0.01 turns 10 s into 100 ms). */
  retryDelayScale?: number;
}

export const JOB_QUEUE_OPTIONS = 'JOB_QUEUE_OPTIONS';
