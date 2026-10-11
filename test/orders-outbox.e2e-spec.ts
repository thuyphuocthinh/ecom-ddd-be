import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import {
  EVENT_BUS,
  PrismaService,
  RabbitMQModule,
  RabbitMQService,
} from '../src/core/index.js';
import { EVENT_BUS_OPTIONS } from '../src/core/infrastructure/messaging/events/event-bus.port.js';
import { EventBusModule } from '../src/core/infrastructure/messaging/events/event-bus.module.js';
import { RabbitMqEventBus } from '../src/core/infrastructure/messaging/events/rabbitmq-event-bus.js';
import { PrismaOutboxStore } from '../src/modules/orders/infrastructure/database/prisma-outbox.store.js';
import { OutboxRelay } from '../src/modules/orders/infrastructure/outbox/outbox-relay.service.js';
import { ordersConfig } from '../src/modules/orders/orders.config.js';

/**
 * The outbox against the real Postgres and the real RabbitMQ: an event written to the outbox
 * arrives on a listener's queue, and when RabbitMQ is unreachable it stays in the outbox until it
 * is back. Every run uses its own exchange and queue, deleted at the end.
 */
const NAMESPACE = `e2e-${randomUUID().slice(0, 8)}.`;
const EXCHANGE = `${NAMESPACE}events`;
const QUEUE = `${NAMESPACE}test.orders`;
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';

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

describe('Outbox to RabbitMQ (e2e)', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;
  let admin: amqp.ChannelModel;
  let channel: amqp.Channel;
  let prisma: PrismaService;
  let relay: OutboxRelay;
  const original = { ...process.env };

  const depth = async () => (await channel.checkQueue(QUEUE)).messageCount;
  const drain = async () => {
    for (;;) {
      if (!(await channel.get(QUEUE, { noAck: true }))) return;
    }
  };
  const addEvent = async (type = 'order.created') => {
    const id = randomUUID();
    await prisma.outboxEvent.create({
      data: {
        id,
        type,
        aggregateId: 'order-1',
        payload: { orderId: 'order-1', total: 3990000 },
      },
    });
    return id;
  };

  beforeAll(async () => {
    process.env.JOB_QUEUE = 'rabbitmq';
    process.env.RABBITMQ_URL = RABBITMQ_URL;
    admin = await amqp.connect(RABBITMQ_URL);
    channel = await admin.createChannel();

    moduleRef = await Test.createTestingModule({
      imports: [EventBusModule, RabbitMQModule],
      providers: [
        PrismaService,
        PrismaOutboxStore,
        { provide: 'IOutboxStore', useExisting: PrismaOutboxStore },
        // The timer is off: the test runs the rounds itself
        {
          provide: ordersConfig.KEY,
          useValue: {
            outboxIntervalMs: 0,
            outboxBatchSize: 50,
            maintenanceIntervalSeconds: 0,
          },
        },
        OutboxRelay,
      ],
    })
      .overrideProvider(EVENT_BUS_OPTIONS)
      .useValue({ namespace: NAMESPACE })
      .compile();
    await moduleRef.init();
    await until(
      () => moduleRef.get(RabbitMQService).isConnected(),
      'the RabbitMQ connection',
    );
    expect(moduleRef.get(EVENT_BUS)).toBeInstanceOf(RabbitMqEventBus);
    prisma = moduleRef.get(PrismaService);
    relay = moduleRef.get(OutboxRelay);

    await until(async () => {
      try {
        const probe = await admin.createChannel();
        await probe.checkExchange(EXCHANGE);
        await probe.close();
        return true;
      } catch {
        return false;
      }
    }, 'the exchange');
    await channel.assertQueue(QUEUE, { durable: true });
    await channel.bindQueue(QUEUE, EXCHANGE, 'order.*');
  });

  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany();
    await drain();
  });

  afterAll(async () => {
    await prisma?.outboxEvent.deleteMany();
    await moduleRef?.close();
    const remove = async (action: (ch: amqp.Channel) => Promise<unknown>) => {
      const ch = await admin.createChannel();
      await action(ch).catch(() => undefined);
      await ch.close().catch(() => undefined);
    };
    await remove((ch) => ch.deleteQueue(QUEUE));
    await remove((ch) => ch.deleteExchange(EXCHANGE));
    await admin.close().catch(() => undefined);
    process.env = { ...original };
  });

  it('delivers an event written to the outbox to a listener, with its id and its data, and marks it sent', async () => {
    const id = await addEvent('order.created');

    const result = await relay.runOnce();

    expect(result).toEqual({ sent: 1, failure: null });
    await until(async () => (await depth()) === 1, 'the message on the queue');
    const message = await channel.get(QUEUE, { noAck: true });
    expect(message).not.toBe(false);
    if (message === false) return;
    expect(message.fields.routingKey).toBe('order.created');
    expect(message.properties.messageId).toBe(id);
    expect(JSON.parse(message.content.toString()).data).toEqual({
      orderId: 'order-1',
      total: 3990000,
    });
    expect(
      await prisma.outboxEvent.count({ where: { publishedAt: null } }),
    ).toBe(0);
  });

  it('delivers several events in the order they were written', async () => {
    const ids = [
      await addEvent(),
      await addEvent('order.status_changed'),
      await addEvent(),
    ];

    await relay.runOnce();

    await until(async () => (await depth()) === 3, 'three messages');
    const received: string[] = [];
    for (let i = 0; i < 3; i++) {
      const message = await channel.get(QUEUE, { noAck: true });
      if (message) received.push(message.properties.messageId as string);
    }
    expect(received).toEqual(ids);
  });

  it('keeps the event in the outbox while RabbitMQ is unreachable, and delivers it once it is back', async () => {
    const id = await addEvent();
    const rabbit = moduleRef.get(RabbitMQService);
    // Make the broker unreachable (a wrong port) and cut the connection the way a network failure
    // would; without the wrong port the service reconnects within milliseconds
    const connection = (rabbit as any).connection as amqp.ChannelModel;
    process.env.RABBITMQ_URL = 'amqp://admin:admin@localhost:5999';
    (connection as any).connection.stream.destroy(
      new Error('connection cut by the test'),
    );
    await until(() => !rabbit.isConnected(), 'the connection to drop');

    const down = await relay.runOnce();

    expect(down.sent).toBe(0);
    expect(down.failure).not.toBeNull();
    expect(
      await prisma.outboxEvent.count({ where: { publishedAt: null } }),
    ).toBe(1);

    process.env.RABBITMQ_URL = RABBITMQ_URL;
    await until(() => rabbit.isConnected(), 'the reconnection', 15_000);
    await until(
      async () => (await relay.runOnce()).sent === 1,
      'the event to be sent',
      15_000,
    );
    await until(async () => (await depth()) >= 1, 'the message on the queue');
    const message = await channel.get(QUEUE, { noAck: true });
    expect(message && message.properties.messageId).toBe(id);
    expect(
      await prisma.outboxEvent.count({ where: { publishedAt: null } }),
    ).toBe(0);
  }, 40_000);
});
