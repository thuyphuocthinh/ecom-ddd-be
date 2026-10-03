import {
  BeforeApplicationShutdown,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type * as amqp from 'amqplib';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import type {
  IJobQueue,
  JobDefinition,
  JobHandler,
  JobQueueOptions,
} from './job-queue.port.js';
import { describeFailure } from './job-failure.js';

const DRAIN_TIMEOUT_MS = 30_000;
const REQUEUE_PAUSE_MS = 1_000;
const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

interface KnownJob {
  job: JobDefinition<any>;
  handler?: JobHandler<any>;
  consumerTag?: string;
  channel?: amqp.ConfirmChannel;
}

/**
 * Job queue on RabbitMQ. One exchange (`jobs`) and, per kind of job:
 *
 *   jobs.<name>          main queue; workers consume here
 *   jobs.<name>.retry.N.<ms>ms  one queue per retry, with a fixed TTL; when it expires the job is
 *                        dead-lettered back to the main queue. The TTL is in the name, because
 *                        RabbitMQ refuses to redeclare a queue with different arguments: changing a
 *                        retry delay creates a new queue instead of breaking every start-up. The TTL is fixed per queue
 *                        because a message with a long TTL at the head of a queue holds back
 *                        the shorter ones behind it.
 *   jobs.<name>.dlq      jobs that failed after the last retry, kept for people to look at
 *
 * A failing job is retried by publishing a copy to the next retry queue and only then
 * acknowledging the original, so it is never lost; dying between the two steps can at worst
 * run it twice. Nothing sleeps inside a consumer, so a waiting retry holds no worker.
 */
export class RabbitMqJobQueue
  implements IJobQueue, OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RabbitMqJobQueue.name);
  private readonly jobs = new Map<string, KnownJob>();
  private readonly asserted = new WeakMap<amqp.ConfirmChannel, Set<string>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly namespace: string;
  private readonly delayScale: number;
  private draining = false;
  // prefetch and consume are two calls; two jobs set up at the same time must not interleave them
  private setUpChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rabbit: RabbitMQService,
    options: JobQueueOptions = {},
  ) {
    this.namespace = options.namespace ?? '';
    this.delayScale = options.retryDelayScale ?? 1;
  }

  onModuleInit(): void {
    this.rabbit.onConnected((channel) => this.setUp(channel));
    this.rabbit.start();
  }

  register<T>(job: JobDefinition<T>, handler: JobHandler<T>): void {
    const known = this.know(job);
    known.handler = handler;
    const channel = this.rabbit.getChannel();
    if (channel) {
      this.serially(() => this.setUpJob(channel, known)).catch((error: Error) =>
        this.logger.error(
          `Could not start workers for "${job.name}": ${error.message}`,
        ),
      );
    }
  }

  async enqueue<T>(job: JobDefinition<T>, data: T): Promise<void> {
    this.know(job);
    const channel = this.rabbit.getChannel();
    if (!channel) {
      throw new ServiceUnavailableException('Message broker is unavailable');
    }
    try {
      await this.assertTopology(channel, job);
    } catch (error) {
      this.logger.error(
        `Could not prepare queues for "${job.name}": ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException('Message broker is unavailable');
    }
    await this.rabbit.publish(
      this.exchange,
      job.name,
      Buffer.from(JSON.stringify(data)),
      {
        contentType: 'application/json',
        messageId: randomUUID(),
        headers: { 'x-attempt': 0 },
      },
    );
  }

  /** Stop taking new jobs and let the ones running finish (up to 30 s) before the connection closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true;
    for (const known of this.jobs.values()) {
      if (known.consumerTag && known.channel) {
        await known.channel.cancel(known.consumerTag).catch(() => undefined);
      }
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(this.inFlight),
      new Promise((resolve) => {
        timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  private get exchange(): string {
    return `${this.namespace}jobs`;
  }

  private queueNames(job: JobDefinition<any>) {
    const main = `${this.exchange}.${job.name}`;
    return {
      main,
      retry: (n: number) => `${main}.retry.${n}.${this.retryTtl(job, n)}ms`,
      dlq: `${main}.dlq`,
    };
  }

  /** How long a message waits in retry queue `n` (1-based) before it goes back to the main queue. */
  private retryTtl(job: JobDefinition<any>, n: number): number {
    return Math.max(1, Math.round(job.retryDelaysMs[n - 1] * this.delayScale));
  }

  private know(job: JobDefinition<any>): KnownJob {
    let known = this.jobs.get(job.name);
    if (!known) {
      if (!NAME_PATTERN.test(job.name)) {
        throw new Error(`Invalid job name "${job.name}"`);
      }
      const concurrency = job.concurrency ?? 1;
      if (
        !Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 1000
      ) {
        throw new Error(`Job "${job.name}" needs a concurrency of 1 to 1000`);
      }
      if (job.retryDelaysMs.some((ms) => !(ms > 0))) {
        throw new Error(`Job "${job.name}" has a non-positive retry delay`);
      }
      known = { job };
      this.jobs.set(job.name, known);
    }
    return known;
  }

  /** Runs after every (re)connection: declare all queues and start all workers again. */
  private setUp(channel: amqp.ConfirmChannel): Promise<void> {
    return this.serially(async () => {
      for (const known of this.jobs.values()) {
        known.consumerTag = undefined;
        await this.setUpJob(channel, known);
      }
    });
  }

  private serially<T>(task: () => Promise<T>): Promise<T> {
    const result = this.setUpChain.then(task);
    this.setUpChain = result.catch(() => undefined);
    return result;
  }

  private async setUpJob(
    channel: amqp.ConfirmChannel,
    known: KnownJob,
  ): Promise<void> {
    await this.assertTopology(channel, known.job);
    if (!known.handler || known.consumerTag || this.draining) return;

    const { job, handler } = known;
    await channel.prefetch(job.concurrency ?? 1);
    const { consumerTag } = await channel.consume(
      this.queueNames(job).main,
      (message) => {
        if (!message) {
          // The broker cancelled this consumer (e.g. the queue was deleted): listen again
          this.logger.warn(
            `Workers for "${job.name}" were cancelled by the broker; restarting them`,
          );
          known.consumerTag = undefined;
          if (!this.draining) {
            this.serially(() => this.setUpJob(channel, known)).catch(
              (error: Error) =>
                this.logger.error(
                  `Could not restart workers for "${job.name}": ${error.message}`,
                ),
            );
          }
          return;
        }
        const running = this.handle(channel, job, handler, message);
        this.inFlight.add(running);
        void running.finally(() => this.inFlight.delete(running));
      },
      { noAck: false },
    );
    known.consumerTag = consumerTag;
    known.channel = channel;
  }

  private async assertTopology(
    channel: amqp.ConfirmChannel,
    job: JobDefinition<any>,
  ): Promise<void> {
    let done = this.asserted.get(channel);
    if (!done) {
      done = new Set();
      this.asserted.set(channel, done);
    }
    if (done.has(job.name)) return;

    const names = this.queueNames(job);
    await channel.assertExchange(this.exchange, 'direct', { durable: true });
    await channel.assertQueue(names.main, { durable: true });
    await channel.bindQueue(names.main, this.exchange, job.name);
    for (const index of job.retryDelaysMs.keys()) {
      await channel.assertQueue(names.retry(index + 1), {
        durable: true,
        arguments: {
          'x-message-ttl': this.retryTtl(job, index + 1),
          'x-dead-letter-exchange': this.exchange,
          'x-dead-letter-routing-key': job.name,
        },
      });
    }
    await channel.assertQueue(names.dlq, { durable: true });
    done.add(job.name);
  }

  private async handle(
    channel: amqp.ConfirmChannel,
    job: JobDefinition<any>,
    handler: JobHandler<any>,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    const attempt = Number(message.properties.headers?.['x-attempt']) || 0;

    let data: unknown;
    try {
      data = JSON.parse(message.content.toString());
    } catch {
      this.logger.error(`Job "${job.name}": unreadable message; dead-lettered`);
      await this.deadLetter(channel, job, message, attempt, 'UNREADABLE');
      return;
    }

    try {
      await handler(data);
      this.settle(() => channel.ack(message));
    } catch (error) {
      const reason = describeFailure(error);
      if (attempt < job.retryDelaysMs.length) {
        this.logger.warn(
          `Job "${job.name}" (${message.properties.messageId}) failed on attempt ${attempt + 1}: ${reason}; retrying`,
        );
        await this.republish(
          channel,
          message,
          this.queueNames(job).retry(attempt + 1),
          attempt + 1,
          reason,
        );
      } else {
        this.logger.error(
          `Job "${job.name}" (${message.properties.messageId}) failed for good after ${attempt + 1} attempts: ${reason}`,
        );
        await this.deadLetter(channel, job, message, attempt, reason);
      }
    }
  }

  private deadLetter(
    channel: amqp.ConfirmChannel,
    job: JobDefinition<any>,
    message: amqp.ConsumeMessage,
    attempt: number,
    reason: string,
  ): Promise<void> {
    return this.republish(
      channel,
      message,
      this.queueNames(job).dlq,
      attempt + 1,
      reason,
    );
  }

  /**
   * Publishes a copy to `queue`, and only after the broker confirmed it acknowledges the
   * original. If the copy cannot be published the original goes back to its queue instead.
   */
  private async republish(
    channel: amqp.ConfirmChannel,
    message: amqp.ConsumeMessage,
    queue: string,
    attempt: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.rabbit.publish(
        '',
        queue,
        message.content,
        {
          contentType: message.properties.contentType,
          messageId: message.properties.messageId,
          headers: { 'x-attempt': attempt, 'x-failure': reason },
        },
        // The channel the message came on: its ack must follow the publish on the same channel
        channel,
      );
    } catch {
      // Without a pause a refusing broker would turn this into a tight redelivery loop
      await new Promise((resolve) => setTimeout(resolve, REQUEUE_PAUSE_MS));
      this.settle(() => channel.nack(message, false, true));
      return;
    }
    this.settle(() => channel.ack(message));
  }

  /** Ack or nack on a channel that may have closed meanwhile; the broker redelivers anyway. */
  private settle(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logger.warn(
        `Could not acknowledge a job (${(error as Error).message}); the broker will redeliver it`,
      );
    }
  }
}
