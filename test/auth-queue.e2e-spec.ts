import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  EMAIL_SENDER,
  JOB_QUEUE_OPTIONS,
} from './../src/core/index.js';
import type { EmailMessage } from './../src/core/index.js';

/**
 * Registration end to end with the real queue (RabbitMQ from docker-compose): the request
 * answers at once, the email reaches the mailbox through the worker, and the code from it
 * completes the registration. Uses its own exchange and queues, deleted at the end.
 */
const API = '/api/v1';
const NAMESPACE = `e2e-auth-${randomUUID().slice(0, 8)}.`;
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';
const EMAIL = 'queued@example.com';
const PASSWORD = 'Sunny-Giraffe-42!';

const mailbox = {
  sent: [] as EmailMessage[],
  hang: null as Promise<void> | null,
  async send(message: EmailMessage): Promise<void> {
    if (this.hang) await this.hang;
    this.sent.push(message);
  },
};

const until = async (condition: () => boolean, what: string, ms = 8_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('Auth registration through the RabbitMQ queue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  const original = { ...process.env };

  beforeAll(async () => {
    process.env.JOB_QUEUE = 'rabbitmq';
    process.env.RABBITMQ_URL = RABBITMQ_URL;
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JOB_QUEUE_OPTIONS)
      .useValue({ namespace: NAMESPACE, retryDelayScale: 0.01 })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailbox)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(app.get(ClsService)));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix(API.replace('/', ''));
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    const { RabbitMQService } = await import('./../src/core/index.js');
    await until(
      () => app.get(RabbitMQService).isConnected(),
      'the RabbitMQ connection',
    );
  });

  afterAll(async () => {
    await app?.close();
    const admin = await amqp.connect(RABBITMQ_URL);
    const remove = async (action: (c: amqp.Channel) => Promise<unknown>) => {
      const channel = await admin.createChannel();
      await action(channel).catch(() => undefined);
      await channel.close().catch(() => undefined);
    };
    for (const suffix of [
      '',
      '.dlq',
      '.retry.1.10000ms',
      '.retry.1.100ms',
      '.retry.2.300ms',
      '.retry.3.900ms',
    ]) {
      await remove((c) =>
        c.deleteQueue(`${NAMESPACE}jobs.send-email${suffix}`),
      );
    }
    await remove((c) => c.deleteExchange(`${NAMESPACE}jobs`));
    await admin.close();
    process.env = { ...original };
  });

  beforeEach(async () => {
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await redis.getClient().flushdb();
    mailbox.sent.length = 0;
    mailbox.hang = null;
  });

  const register = () =>
    request(app.getHttpServer())
      .post(`${API}/auth/register`)
      .send({ email: EMAIL, password: PASSWORD });

  it('answers register before the provider is done: a hanging provider does not hold the request up (AC-1)', async () => {
    let release!: () => void;
    mailbox.hang = new Promise<void>((resolve) => (release = resolve));

    const started = Date.now();
    const res = await register().expect(202);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.body.data.resendAvailableInSeconds).toBeGreaterThan(0);
    expect(mailbox.sent).toHaveLength(0);
    release();
    await until(() => mailbox.sent.length === 1, 'the email to arrive');
  });

  it('delivers the code through the worker, and the code completes the registration (AC-12)', async () => {
    await register().expect(202);
    await until(() => mailbox.sent.length === 1, 'the email to arrive');

    const code = mailbox.sent[0].text.match(/\b(\d{6})\b/)![1];
    expect(mailbox.sent[0].to).toBe(EMAIL);
    const verified = await request(app.getHttpServer())
      .post(`${API}/auth/verify-email`)
      .send({ email: EMAIL, code, password: PASSWORD })
      .expect(200);

    expect(typeof verified.body.data.accessToken).toBe('string');
    expect(await prisma.user.count()).toBe(1);
  });

  it('resend-verification also goes through the queue and is limited as before (AC-12)', async () => {
    await register().expect(202);
    await until(() => mailbox.sent.length === 1, 'the first email');

    await request(app.getHttpServer())
      .post(`${API}/auth/resend-verification`)
      .send({ email: EMAIL })
      .expect(429);
  });
});
