import type * as amqp from 'amqplib';
import type { JobDefinition } from './job-queue.port.js';

/**
 * Which RabbitMQ queues a job kind uses, what they are called, and how they are declared.
 * One exchange (`jobs`) and, per kind of job:
 *
 *   jobs.<name>          main queue; workers consume here
 *   jobs.<name>.retry.N.<ms>ms  one queue per retry; a failed job waits here and, when the TTL
 *                        expires, is dead-lettered back to the main queue
 *   jobs.<name>.delay.<ms>ms  only for a job with `delayMs`: new jobs are published here instead of
 *                        to the main queue, so the job first runs `delayMs` after it was enqueued
 *   jobs.<name>.dlq      jobs that failed after the last retry, kept for people to look at
 *
 * The retry and delay queues are the same thing, a "wait queue" with a fixed TTL. The TTL is fixed
 * per queue because a message with a long TTL at the head of a queue holds back the shorter ones
 * behind it, and it sits in the name because RabbitMQ refuses to redeclare a queue with different
 * arguments: changing a delay creates a new queue instead of breaking every start-up.
 */
export class JobTopology {
  private readonly declared = new WeakMap<amqp.ConfirmChannel, Set<string>>();

  /**
   * @param namespace put in front of every name (tests use it to keep their queues apart)
   * @param delayScale multiplies every retry and delay time (tests shrink time with it)
   */
  constructor(
    private readonly namespace = '',
    private readonly delayScale = 1,
  ) {}

  get exchange(): string {
    return `${this.namespace}jobs`;
  }

  names(job: JobDefinition<any>) {
    const main = `${this.exchange}.${job.name}`;
    return {
      main,
      retry: (n: number) => `${main}.retry.${n}.${this.retryTtl(job, n)}ms`,
      // Only a job with `delayMs` has one
      delay:
        job.delayMs === undefined
          ? undefined
          : `${main}.delay.${this.delayTtl(job.delayMs)}ms`,
      dlq: `${main}.dlq`,
    };
  }

  /** Declares every queue of the job on this channel, once per channel. */
  async declare(
    channel: amqp.ConfirmChannel,
    job: JobDefinition<any>,
  ): Promise<void> {
    let done = this.declared.get(channel);
    if (!done) {
      done = new Set();
      this.declared.set(channel, done);
    }
    if (done.has(job.name)) return;

    const names = this.names(job);
    await channel.assertExchange(this.exchange, 'direct', { durable: true });
    await channel.assertQueue(names.main, { durable: true });
    await channel.bindQueue(names.main, this.exchange, job.name);
    for (const index of job.retryDelaysMs.keys()) {
      await this.declareWaitQueue(
        channel,
        job,
        names.retry(index + 1),
        this.retryTtl(job, index + 1),
      );
    }
    if (names.delay) {
      await this.declareWaitQueue(
        channel,
        job,
        names.delay,
        this.delayTtl(job.delayMs as number),
      );
    }
    await channel.assertQueue(names.dlq, { durable: true });
    done.add(job.name);
  }

  /** A queue where messages wait `ttlMs`, then go back to the job's main queue. */
  private async declareWaitQueue(
    channel: amqp.ConfirmChannel,
    job: JobDefinition<any>,
    queue: string,
    ttlMs: number,
  ): Promise<void> {
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-message-ttl': ttlMs,
        'x-dead-letter-exchange': this.exchange,
        'x-dead-letter-routing-key': job.name,
      },
    });
  }

  /** How long a message waits in retry queue `n` (1-based) before it goes back to the main queue. */
  private retryTtl(job: JobDefinition<any>, n: number): number {
    return Math.max(1, Math.round(job.retryDelaysMs[n - 1] * this.delayScale));
  }

  /** How long a new message waits in the delay queue before it first reaches the main queue. */
  private delayTtl(delayMs: number): number {
    return Math.max(1, Math.round(delayMs * this.delayScale));
  }
}
