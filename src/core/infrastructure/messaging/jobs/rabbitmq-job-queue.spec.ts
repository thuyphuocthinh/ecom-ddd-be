import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { RabbitMqJobQueue } from './rabbitmq-job-queue.js';
import { defineJob } from './job-queue.port.js';
import type { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';

interface Delivery {
  content: Buffer;
  properties: { headers?: Record<string, unknown>; messageId?: string };
}

/** A channel that records what was declared and lets a test deliver messages to the consumer. */
class FakeChannel {
  exchanges: string[] = [];
  queues = new Map<string, { durable?: boolean; arguments?: any }>();
  bindings: Array<[string, string, string]> = [];
  consumers = new Map<string, (message: any) => void>();
  cancelled: string[] = [];
  prefetchCalls: number[] = [];
  acked: Delivery[] = [];
  nacked: Array<{ message: Delivery; requeue: boolean }> = [];
  order: string[] = [];
  private tag = 0;

  assertExchange = vi.fn(async (name: string) => {
    this.exchanges.push(name);
  });
  assertQueue = vi.fn(async (name: string, options: any) => {
    this.queues.set(name, options);
  });
  bindQueue = vi.fn(async (queue: string, exchange: string, key: string) => {
    this.bindings.push([queue, exchange, key]);
  });
  prefetch = vi.fn(async (count: number) => {
    this.prefetchCalls.push(count);
  });
  consume = vi.fn(async (queue: string, callback: (m: any) => void) => {
    const consumerTag = `tag-${++this.tag}`;
    this.consumers.set(queue, callback);
    this.consumerTags.set(consumerTag, queue);
    return { consumerTag };
  });
  consumerTags = new Map<string, string>();
  cancel = vi.fn(async (tag: string) => {
    this.cancelled.push(tag);
  });
  ack = vi.fn((message: Delivery) => {
    this.order.push('ack');
    this.acked.push(message);
  });
  nack = vi.fn((message: Delivery, _all: boolean, requeue: boolean) => {
    this.order.push('nack');
    this.nacked.push({ message, requeue });
  });

  deliver(queue: string, body: unknown, attempt = 0): Delivery {
    const message: Delivery = {
      content: Buffer.from(
        typeof body === 'string' ? body : JSON.stringify(body),
      ),
      properties: { headers: { 'x-attempt': attempt }, messageId: 'msg-1' },
    };
    this.consumers.get(queue)!(message);
    return message;
  }
}

/** Stands in for RabbitMQService: connecting means running the registered hooks on a channel. */
class FakeRabbit {
  hooks: Array<(channel: any) => Promise<void>> = [];
  channel: FakeChannel | null = null;
  published: Array<{
    exchange: string;
    key: string;
    content: Buffer;
    options: any;
    channel?: any;
  }> = [];
  publishError: Error | null = null;
  order: string[] | null = null;

  start = vi.fn();
  onConnected = vi.fn((hook: (channel: any) => Promise<void>) => {
    this.hooks.push(hook);
  });
  getChannel = () => this.channel as any;
  publish = vi.fn(
    async (
      exchange: string,
      key: string,
      content: Buffer,
      options: any,
      channel?: any,
    ) => {
      if (this.publishError) throw this.publishError;
      this.order?.push('publish');
      this.published.push({ exchange, key, content, options, channel });
    },
  );

  async connect(channel = new FakeChannel()) {
    this.channel = channel;
    channel.order = this.order ?? channel.order;
    for (const hook of this.hooks) await hook(channel);
    return channel;
  }
}

const EMAIL = defineJob<{ n: number }>({
  name: 'send-email',
  retryDelaysMs: [10_000, 30_000, 90_000],
  concurrency: 5,
});
const OTHER = defineJob<{ id: string }>({
  name: 'other-job',
  retryDelaysMs: [1_000],
});

/** Let queued promise callbacks run */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RabbitMqJobQueue', () => {
  let rabbit: FakeRabbit;
  let queue: RabbitMqJobQueue;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: any) => {
        logged.push(String(message));
      });
    }
    rabbit = new FakeRabbit();
    queue = new RabbitMqJobQueue(rabbit as unknown as RabbitMQService);
    queue.onModuleInit();
  });
  afterEach(() => vi.restoreAllMocks());

  describe('start-up', () => {
    it('starts connecting and asks to be set up again after every connection (AC-8)', () => {
      expect(rabbit.start).toHaveBeenCalledOnce();
      expect(rabbit.onConnected).toHaveBeenCalledOnce();
    });
  });

  describe('topology', () => {
    it('declares the exchange, the main queue, one queue per retry with its own TTL, and the dead-letter queue', async () => {
      queue.register(EMAIL, async () => {});
      const channel = await rabbit.connect();

      expect(channel.exchanges).toContain('jobs');
      expect(channel.bindings).toContainEqual([
        'jobs.send-email',
        'jobs',
        'send-email',
      ]);
      expect([...channel.queues.keys()]).toEqual([
        'jobs.send-email',
        'jobs.send-email.retry.1.10000ms',
        'jobs.send-email.retry.2.30000ms',
        'jobs.send-email.retry.3.90000ms',
        'jobs.send-email.dlq',
      ]);
      for (const [n, ttl] of [
        [1, 10_000],
        [2, 30_000],
        [3, 90_000],
      ]) {
        expect(
          channel.queues.get(`jobs.send-email.retry.${n}.${ttl}ms`),
        ).toEqual({
          durable: true,
          arguments: {
            'x-message-ttl': ttl,
            'x-dead-letter-exchange': 'jobs',
            'x-dead-letter-routing-key': 'send-email',
          },
        });
      }
    });

    it('makes every queue durable', async () => {
      queue.register(EMAIL, async () => {});
      const channel = await rabbit.connect();

      for (const options of channel.queues.values()) {
        expect(options.durable).toBe(true);
      }
    });

    it('prefixes names with the namespace and scales the retry delays (for tests)', async () => {
      queue = new RabbitMqJobQueue(rabbit as unknown as RabbitMQService, {
        namespace: 't1.',
        retryDelayScale: 0.01,
      });
      queue.onModuleInit();
      queue.register(EMAIL, async () => {});
      const channel = await rabbit.connect();

      expect(channel.queues.has('t1.jobs.send-email')).toBe(true);
      expect(
        channel.queues.get('t1.jobs.send-email.retry.1.100ms')!.arguments[
          'x-message-ttl'
        ],
      ).toBe(100);
    });

    it.each([0, -1, 1.5, 1001, Number.NaN])(
      'rejects a concurrency of %s: 0 would mean no limit at all in RabbitMQ',
      (concurrency) => {
        expect(() =>
          queue.register(
            defineJob({ name: 'ok-name', retryDelaysMs: [], concurrency }),
            async () => {},
          ),
        ).toThrow(/concurrency/);
      },
    );

    it('rejects an invalid job name or a non-positive retry delay', () => {
      expect(() =>
        queue.register(
          defineJob({ name: 'Bad Name', retryDelaysMs: [] }),
          async () => {},
        ),
      ).toThrow(/Invalid job name/);
      expect(() =>
        queue.register(
          defineJob({ name: 'ok-name', retryDelaysMs: [0] }),
          async () => {},
        ),
      ).toThrow(/non-positive/);
    });
  });

  describe('enqueue', () => {
    it('publishes a persistent JSON message to the exchange with the job name as routing key and waits for the broker (AC-1)', async () => {
      await rabbit.connect();

      await queue.enqueue(EMAIL, { n: 7 });

      expect(rabbit.published).toHaveLength(1);
      const sent = rabbit.published[0];
      expect(sent.exchange).toBe('jobs');
      expect(sent.key).toBe('send-email');
      expect(JSON.parse(sent.content.toString())).toEqual({ n: 7 });
      expect(sent.options.headers).toEqual({ 'x-attempt': 0 });
      expect(sent.options.contentType).toBe('application/json');
      expect(sent.options.messageId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('declares the queues before publishing, even for a job nobody listens to here', async () => {
      const channel = await rabbit.connect();

      await queue.enqueue(OTHER, { id: 'x' });

      expect(channel.queues.has('jobs.other-job')).toBe(true);
      expect(channel.queues.has('jobs.other-job.dlq')).toBe(true);
    });

    it('answers 503 at once when there is no connection (AC-7)', async () => {
      await expect(queue.enqueue(EMAIL, { n: 1 })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(rabbit.published).toHaveLength(0);
    });

    it('answers 503 when the broker does not confirm the message (AC-7)', async () => {
      await rabbit.connect();
      rabbit.publishError = new ServiceUnavailableException();

      await expect(queue.enqueue(EMAIL, { n: 1 })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('workers', () => {
    it('listens on the main queue with the job concurrency as prefetch and acknowledges by hand (AC-2)', async () => {
      queue.register(EMAIL, async () => {});
      const channel = await rabbit.connect();

      expect(channel.prefetchCalls).toEqual([5]);
      expect(channel.consume).toHaveBeenCalledWith(
        'jobs.send-email',
        expect.any(Function),
        { noAck: false },
      );
    });

    it('runs the handler with the parsed data and acknowledges (AC-2)', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.register(EMAIL, handler);
      const channel = await rabbit.connect();

      const message = channel.deliver('jobs.send-email', { n: 3 });
      await settle();

      expect(handler).toHaveBeenCalledWith({ n: 3 });
      expect(channel.acked).toEqual([message]);
      expect(rabbit.published).toHaveLength(0);
    });

    it('starts a worker at once when the handler is registered after connecting', async () => {
      const channel = await rabbit.connect();

      queue.register(EMAIL, async () => {});
      await settle();

      expect(channel.consumers.has('jobs.send-email')).toBe(true);
    });

    it('starts the workers again on a new channel after a reconnect, and declares the queues again (AC-8)', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.register(EMAIL, handler);
      await rabbit.connect();

      const second = await rabbit.connect(new FakeChannel());

      expect(second.queues.has('jobs.send-email.dlq')).toBe(true);
      second.deliver('jobs.send-email', { n: 9 });
      await settle();
      expect(handler).toHaveBeenCalledWith({ n: 9 });
    });
  });

  describe('retrying', () => {
    let channel: FakeChannel;

    beforeEach(async () => {
      rabbit.order = [];
      queue.register(EMAIL, async () => {
        throw Object.assign(new Error('550 <a@example.com> unknown'), {
          code: 'EENVELOPE',
        });
      });
      channel = await rabbit.connect();
    });

    it('publishes a copy to the first retry queue with the attempt counted up, and only then acknowledges (AC-3)', async () => {
      const message = channel.deliver('jobs.send-email', { n: 1 });
      await settle();

      expect(rabbit.published).toHaveLength(1);
      const copy = rabbit.published[0];
      expect(copy.exchange).toBe('');
      expect(copy.key).toBe('jobs.send-email.retry.1.10000ms');
      expect(copy.content).toEqual(message.content);
      expect(copy.options.headers['x-attempt']).toBe(1);
      expect(copy.options.messageId).toBe('msg-1');
      expect(rabbit.order).toEqual(['publish', 'ack']);
    });

    it.each([
      [1, 'jobs.send-email.retry.2.30000ms', 2],
      [2, 'jobs.send-email.retry.3.90000ms', 3],
    ])(
      'moves a job that already failed %i time(s) to %s (AC-3)',
      async (attempt, retryQueue, nextAttempt) => {
        channel.deliver('jobs.send-email', { n: 1 }, attempt);
        await settle();

        expect(rabbit.published[0].key).toBe(retryQueue);
        expect(rabbit.published[0].options.headers['x-attempt']).toBe(
          nextAttempt,
        );
      },
    );

    it('sends a job that failed after the last retry to the dead-letter queue, with the reason, and acknowledges (AC-4)', async () => {
      channel.deliver('jobs.send-email', { n: 1 }, 3);
      await settle();

      expect(rabbit.published).toHaveLength(1);
      const dead = rabbit.published[0];
      expect(dead.key).toBe('jobs.send-email.dlq');
      expect(dead.options.headers['x-attempt']).toBe(4);
      expect(dead.options.headers['x-failure']).toBe('EENVELOPE Error');
      expect(rabbit.order).toEqual(['publish', 'ack']);
    });

    it('logs the failure without the payload, the address or the provider message (AC-4)', async () => {
      channel.deliver('jobs.send-email', { n: 424242 }, 3);
      await settle();

      const everything = logged.join('\n');
      expect(everything).toContain('failed for good');
      expect(everything).toContain('EENVELOPE');
      expect(everything).not.toContain('424242');
      expect(everything).not.toContain('a@example.com');
    });

    it('dead-letters an unreadable message at once without running the handler (AC-4)', async () => {
      channel.deliver('jobs.send-email', 'not json {');
      await settle();

      expect(rabbit.published[0].key).toBe('jobs.send-email.dlq');
      expect(rabbit.published[0].options.headers['x-failure']).toBe(
        'UNREADABLE',
      );
    });

    it('puts the job back on its queue, after a pause, when the copy cannot be published, so it is never lost', async () => {
      vi.useFakeTimers();
      try {
        rabbit.publishError = new ServiceUnavailableException();
        const message = channel.deliver('jobs.send-email', { n: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(channel.nacked).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(channel.nacked).toEqual([{ message, requeue: true }]);
        expect(channel.acked).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let a closed channel crash the worker when acknowledging', async () => {
      channel.ack.mockImplementation(() => {
        throw new Error('Channel closed');
      });

      channel.deliver('jobs.send-email', { n: 1 });
      await settle();

      expect(logged.join('\n')).toContain('will redeliver');
    });
  });

  describe('the broker takes a worker away', () => {
    it('listens again when it cancels the consumer, e.g. because the queue was deleted', async () => {
      queue.register(EMAIL, async () => {});
      const channel = await rabbit.connect();
      expect(channel.consume).toHaveBeenCalledTimes(1);

      // RabbitMQ signals a cancelled consumer by delivering null
      channel.consumers.get('jobs.send-email')!(null);
      await settle();

      expect(channel.consume).toHaveBeenCalledTimes(2);
      expect(logged.join('\n')).toContain('cancelled by the broker');
    });
  });

  describe('publishing a retry', () => {
    it('publishes on the channel the message came from, so the ack follows on the same channel', async () => {
      queue.register(EMAIL, async () => {
        throw new Error('boom');
      });
      const channel = await rabbit.connect();

      channel.deliver('jobs.send-email', { n: 1 });
      await settle();

      expect(rabbit.published[0].channel).toBe(channel);
    });
  });

  describe('a second kind of job (AC-11)', () => {
    it('runs, retries and dead-letters on its own queues, without touching the first', async () => {
      const first = vi.fn().mockResolvedValue(undefined);
      const second = vi.fn().mockRejectedValue(new Error('boom'));
      queue.register(EMAIL, first);
      queue.register(OTHER, second);
      const channel = await rabbit.connect();

      channel.deliver('jobs.other-job', { id: 'a' }, 1);
      await settle();

      expect(second).toHaveBeenCalledWith({ id: 'a' });
      expect(first).not.toHaveBeenCalled();
      expect(rabbit.published[0].key).toBe('jobs.other-job.dlq');
    });
  });

  describe('shutting down (AC-10)', () => {
    it('stops listening, then waits for the job that is running before returning', async () => {
      let finish!: () => void;
      const running = new Promise<void>((resolve) => (finish = resolve));
      queue.register(EMAIL, () => running);
      const channel = await rabbit.connect();
      channel.deliver('jobs.send-email', { n: 1 });

      let done = false;
      const shutdown = queue.beforeApplicationShutdown().then(() => {
        done = true;
      });
      await settle();

      expect(channel.cancelled).toHaveLength(1);
      expect(done).toBe(false);

      finish();
      await shutdown;
      expect(done).toBe(true);
    });

    it('does not start workers once it is shutting down', async () => {
      await queue.beforeApplicationShutdown();
      queue.register(EMAIL, async () => {});

      const channel = await rabbit.connect();

      expect(channel.consumers.size).toBe(0);
    });
  });
});
