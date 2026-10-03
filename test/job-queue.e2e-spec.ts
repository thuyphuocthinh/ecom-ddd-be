import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { RabbitMQModule, RabbitMQService } from '../src/core/index.js';
import {
  JOB_QUEUE,
  JOB_QUEUE_OPTIONS,
  defineJob,
  type IJobQueue,
} from '../src/core/infrastructure/messaging/jobs/job-queue.port.js';
import { JobQueueModule } from '../src/core/infrastructure/messaging/jobs/job-queue.module.js';
import { EmailModule } from '../src/core/infrastructure/email/email.module.js';
import { EMAIL_SENDER } from '../src/core/infrastructure/email/email-sender.port.js';
import { EMAIL_DISPATCHER } from '../src/core/infrastructure/email/email-dispatcher.port.js';
import type { IEmailDispatcher } from '../src/core/infrastructure/email/email-dispatcher.port.js';

/**
 * The real queue, against the RabbitMQ from docker-compose. Every run uses its own namespace
 * (its own exchange and queues, deleted at the end) and retry delays shrunk 100 times, so
 * the real queues are never touched and a "10 second" retry takes a tenth of a second.
 */
const NAMESPACE = `e2e-${randomUUID().slice(0, 8)}.`;
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';
const COOKIE = 'otp-482915-secret';
const MESSAGE = {
  to: 'jane.doe@example.com',
  subject: 'Your code',
  text: `Code: ${COOKIE}`,
  html: `<p>${COOKIE}</p>`,
};

const until = async (
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 8_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('Job queue on RabbitMQ (e2e)', () => {
  const sent: any[] = [];
  const sender = {
    failures: 0,
    hang: null as Promise<void> | null,
    async send(message: any) {
      if (sender.hang) await sender.hang;
      if (sender.failures > 0) {
        sender.failures -= 1;
        throw Object.assign(new Error(`550 <${message.to}> unknown`), {
          code: 'EENVELOPE',
        });
      }
      sent.push(message);
    },
  };
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;
  let admin: amqp.ChannelModel;
  let adminChannel: amqp.Channel;
  let logged: string[];
  const original = { ...process.env };

  const names = (job: string) => ({
    main: `${NAMESPACE}jobs.${job}`,
    dlq: `${NAMESPACE}jobs.${job}.dlq`,
    retries: (job === 'test-other' ? [10] : [100, 300, 900]).map(
      (ms, i) => `${NAMESPACE}jobs.${job}.retry.${i + 1}.${ms}ms`,
    ),
  });

  /** Reads one message from a queue without keeping it */
  const peek = async (queue: string) => {
    const message = await adminChannel.get(queue, { noAck: true });
    return message || null;
  };
  const depth = async (queue: string) =>
    (await adminChannel.checkQueue(queue)).messageCount;

  const build = async () => {
    process.env.JOB_QUEUE = 'rabbitmq';
    process.env.RABBITMQ_URL = RABBITMQ_URL;
    process.env.JWT_ACCESS_SECRET = 's'.repeat(32);
    const builder = Test.createTestingModule({
      imports: [JobQueueModule, EmailModule, RabbitMQModule],
    })
      .overrideProvider(JOB_QUEUE_OPTIONS)
      .useValue({ namespace: NAMESPACE, retryDelayScale: 0.01 })
      .overrideProvider(EMAIL_SENDER)
      .useValue(sender);
    moduleRef = await builder.compile();
    await moduleRef.init();
    await until(
      () => moduleRef.get(RabbitMQService).isConnected(),
      'the RabbitMQ connection',
    );
  };

  beforeAll(async () => {
    admin = await amqp.connect(RABBITMQ_URL);
    adminChannel = await admin.createChannel();
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      const original = Logger.prototype[level];
      Logger.prototype[level] = function (
        this: any,
        message: any,
        ...rest: any[]
      ) {
        logged.push(String(message));
        return original.call(this, message, ...rest);
      } as any;
    }
    await build();
  });

  afterAll(async () => {
    await moduleRef?.close();
    // Each deletion on a fresh channel: deleting something that does not exist closes the channel
    const remove = async (
      action: (channel: amqp.Channel) => Promise<unknown>,
    ) => {
      const channel = await admin.createChannel();
      await action(channel).catch(() => undefined);
      await channel.close().catch(() => undefined);
    };
    for (const job of ['send-email', 'test-other']) {
      const n = names(job);
      for (const queue of [n.main, n.dlq, ...n.retries]) {
        await remove((channel) => channel.deleteQueue(queue));
      }
    }
    await remove((channel) => channel.deleteExchange(`${NAMESPACE}jobs`));
    await admin.close().catch(() => undefined);
    process.env = { ...original };
  });

  beforeEach(async () => {
    sent.length = 0;
    sender.failures = 0;
    sender.hang = null;
    logged.length = 0;
    for (const queue of [names('send-email').dlq]) {
      await adminChannel.purgeQueue(queue).catch(() => undefined);
    }
  });

  const dispatcher = () => moduleRef.get<IEmailDispatcher>(EMAIL_DISPATCHER);

  it('delivers a dispatched email through the worker with the same content (AC-2, AC-12)', async () => {
    await dispatcher().dispatch(MESSAGE);

    await until(() => sent.length === 1, 'the email to be sent');
    expect(sent[0]).toEqual(MESSAGE);
    await until(
      async () => (await depth(names('send-email').main)) === 0,
      'the queue to drain',
    );
  });

  it('answers before the provider is done: a hanging provider does not hold the caller up (AC-1)', async () => {
    let release!: () => void;
    sender.hang = new Promise<void>((resolve) => (release = resolve));

    const started = Date.now();
    await dispatcher().dispatch(MESSAGE);
    const took = Date.now() - started;

    expect(took).toBeLessThan(2_000);
    expect(sent).toHaveLength(0);
    release();
    await until(() => sent.length === 1, 'the email to be sent');
  });

  it('retries after a transient failure and delivers it once it works (AC-3)', async () => {
    sender.failures = 2;

    await dispatcher().dispatch(MESSAGE);

    await until(() => sent.length === 1, 'the email to be sent after retries');
    expect(sender.failures).toBe(0);
    expect(sent[0]).toEqual(MESSAGE);
  });

  it('sets a job aside in the dead-letter queue after the last retry, still encrypted, and logs without the data (AC-4, AC-5)', async () => {
    sender.failures = 99;

    await dispatcher().dispatch(MESSAGE);

    await until(
      async () => (await depth(names('send-email').dlq)) === 1,
      'the job to reach the dead-letter queue',
    );
    const dead = (await peek(names('send-email').dlq))!;
    expect(dead.properties.headers!['x-attempt']).toBe(4);
    expect(dead.properties.headers!['x-failure']).toBe('EENVELOPE Error');
    const body = dead.content.toString();
    expect(body).not.toContain('jane.doe');
    expect(body).not.toContain(COOKIE);
    expect(Object.keys(JSON.parse(body))).toEqual(['payload']);

    const everything = logged.join('\n');
    expect(everything).toContain('failed for good');
    expect(everything).not.toContain('jane.doe');
    expect(everything).not.toContain(COOKIE);
    expect(sent).toHaveLength(0);
  });

  it('never has the code or the address in plain text in a waiting message (AC-5)', async () => {
    let release!: () => void;
    sender.hang = new Promise<void>((resolve) => (release = resolve));
    // 5 workers are busy, so the 6th message has to wait on the queue where it can be read
    for (let i = 0; i < 6; i++) await dispatcher().dispatch(MESSAGE);
    await until(
      async () => (await depth(names('send-email').main)) === 1,
      'one message to be waiting',
    );

    const waiting = (await peek(names('send-email').main))!;

    const body = waiting.content.toString();
    expect(body).not.toContain('jane.doe');
    expect(body).not.toContain(COOKIE);
    expect(waiting.properties.deliveryMode).toBe(2); // persistent
    release();
    await until(() => sent.length === 5, 'the busy workers to finish');
  });

  it('runs a second kind of job on its own queues with the same port, without touching email (AC-11)', async () => {
    const OTHER = defineJob<{ id: string }>({
      name: 'test-other',
      retryDelaysMs: [1_000],
    });
    const queue = moduleRef.get<IJobQueue>(JOB_QUEUE);
    const seen: string[] = [];
    let failFirst = true;
    queue.register(OTHER, async (data) => {
      if (failFirst) {
        failFirst = false;
        throw new Error('first attempt fails');
      }
      seen.push(data.id);
    });

    await queue.enqueue(OTHER, { id: 'abc' });

    await until(() => seen.length === 1, 'the other job to run after a retry');
    expect(seen).toEqual(['abc']);
    expect(sent).toHaveLength(0);
    expect(
      (await adminChannel.checkQueue(`${NAMESPACE}jobs.test-other.dlq`))
        .messageCount,
    ).toBe(0);
  });

  it('keeps a message that arrived while nobody was listening, and delivers it when a worker starts (AC-6)', async () => {
    await moduleRef.close();
    sender.hang = null;

    // Put a message on the queue with no application running
    adminChannel = await admin.createChannel();
    await adminChannel.checkQueue(names('send-email').main);
    // The encrypted payload of MESSAGE, made the way the dispatcher makes it
    const { JobPayloadCipher } =
      await import('../src/core/infrastructure/messaging/jobs/job-payload-cipher.js');
    const payload = new JobPayloadCipher(
      's'.repeat(32),
      'jobs-email-v1',
    ).encrypt(MESSAGE);
    adminChannel.sendToQueue(
      names('send-email').main,
      Buffer.from(JSON.stringify({ payload })),
      { persistent: true, headers: { 'x-attempt': 0 } },
    );
    await adminChannel.checkQueue(names('send-email').main);

    await build();

    await until(() => sent.length === 1, 'the waiting message to be delivered');
    expect(sent[0]).toEqual(MESSAGE);
  });

  it('answers 503 at once while the broker is away, and works again once it is back (AC-7, AC-8)', async () => {
    const rabbit = moduleRef.get(RabbitMQService);
    const connection = (rabbit as any).connection as amqp.ChannelModel;

    // Make the broker unreachable (a wrong port) and cut the connection the way a network
    // failure would. Without the wrong port the service reconnects within milliseconds and
    // the "away" moment is too short to observe.
    const goodUrl = process.env.RABBITMQ_URL;
    process.env.RABBITMQ_URL = 'amqp://admin:admin@localhost:5999';
    (connection as any).connection.stream.destroy(
      new Error('connection cut by the test'),
    );
    await until(
      () => !rabbit.isConnected(),
      'the connection to be noticed as lost',
    );

    const started = Date.now();
    await expect(dispatcher().dispatch(MESSAGE)).rejects.toMatchObject({
      status: 503,
    });
    expect(Date.now() - started).toBeLessThan(1_000);

    // The broker is reachable again: the service reconnects by itself and the workers listen again
    process.env.RABBITMQ_URL = goodUrl;
    await until(() => rabbit.isConnected(), 'the reconnection', 15_000);
    await dispatcher().dispatch(MESSAGE);
    await until(
      () => sent.length === 1,
      'the email to be sent after reconnecting',
      15_000,
    );
  }, 40_000);

  it('lets the job that is running finish when the application shuts down (AC-10)', async () => {
    let release!: () => void;
    sender.hang = new Promise<void>((resolve) => (release = resolve));
    await dispatcher().dispatch(MESSAGE);
    await until(
      async () => (await depth(names('send-email').main)) === 0,
      'the worker to pick the job up',
    );

    let closed = false;
    const closing = moduleRef.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closed).toBe(false);

    release();
    await closing;

    expect(sent).toHaveLength(1);
    // closed: rebuild so afterAll has something to close
    await build();
  }, 20_000);
});
