import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import {
  RabbitMQModule,
  RabbitMQService,
  EVENT_BUS,
} from '../src/core/index.js';
import {
  EVENT_BUS_OPTIONS,
  type IEventBus,
  type IntegrationEvent,
} from '../src/core/infrastructure/messaging/events/event-bus.port.js';
import { EventBusModule } from '../src/core/infrastructure/messaging/events/event-bus.module.js';
import { RabbitMqEventBus } from '../src/core/infrastructure/messaging/events/rabbitmq-event-bus.js';

/**
 * The real event bus, against the RabbitMQ from docker-compose. Every run uses its own namespace
 * (its own exchange and queues, deleted at the end), so the real exchange is never touched.
 */
const NAMESPACE = `e2e-${randomUUID().slice(0, 8)}.`;
const EXCHANGE = `${NAMESPACE}events`;
// The queues of the listeners the tests below start (deleted at the end, with their dead-letter queues)
const LISTENERS = [
  'sub.alpha',
  'sub.beta',
  'sub.payments-only',
  'sub.failing',
  'sub.raw',
  'sub.crashing',
];
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

const event = (
  name: string,
  overrides: Partial<IntegrationEvent> = {},
): IntegrationEvent => ({
  id: randomUUID(),
  name,
  occurredAt: new Date(),
  data: { note: 'hello' },
  ...overrides,
});

describe('Event bus on RabbitMQ (e2e)', () => {
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;
  let admin: amqp.ChannelModel;
  let adminChannel: amqp.Channel;
  let bus: IEventBus;
  const original = { ...process.env };

  const queues = {
    orders: `${NAMESPACE}test.orders`,
    ordersToo: `${NAMESPACE}test.orders-too`,
    payments: `${NAMESPACE}test.payments`,
    everything: `${NAMESPACE}test.everything`,
  };

  // A missing queue makes the broker close the channel that asked, so ask on a throwaway channel
  const consumers = async (queue: string) => {
    const probe = await admin.createChannel();
    probe.on('error', () => undefined);
    try {
      return (await probe.checkQueue(queue)).consumerCount;
    } catch {
      return 0;
    } finally {
      await probe.close().catch(() => undefined);
    }
  };
  const depth = async (queue: string) =>
    (await adminChannel.checkQueue(queue)).messageCount;
  const take = async (queue: string) => {
    const message = await adminChannel.get(queue, { noAck: true });
    return message || null;
  };
  const drain = async (queue: string) => {
    for (;;) {
      if (!(await take(queue))) return;
    }
  };

  beforeAll(async () => {
    process.env.JOB_QUEUE = 'rabbitmq';
    process.env.RABBITMQ_URL = RABBITMQ_URL;
    admin = await amqp.connect(RABBITMQ_URL);
    adminChannel = await admin.createChannel();

    moduleRef = await Test.createTestingModule({
      imports: [EventBusModule, RabbitMQModule],
    })
      .overrideProvider(EVENT_BUS_OPTIONS)
      .useValue({ namespace: NAMESPACE })
      .compile();
    await moduleRef.init();
    await until(
      () => moduleRef.get(RabbitMQService).isConnected(),
      'the RabbitMQ connection',
    );
    bus = moduleRef.get<IEventBus>(EVENT_BUS);
    expect(bus).toBeInstanceOf(RabbitMqEventBus);

    // Listeners, as a real one would do it: its own queue bound to the exchange by a pattern.
    // The exchange exists because the bus declared it when it connected.
    await until(async () => {
      try {
        const channel = await admin.createChannel();
        await channel.checkExchange(EXCHANGE);
        await channel.close();
        return true;
      } catch {
        return false;
      }
    }, 'the exchange');
    for (const [queue, pattern] of [
      [queues.orders, 'order.*'],
      [queues.ordersToo, 'order.*'],
      [queues.payments, 'payment.*'],
      [queues.everything, '#'],
    ]) {
      await adminChannel.assertQueue(queue, { durable: true });
      await adminChannel.bindQueue(queue, EXCHANGE, pattern);
    }
  });

  afterAll(async () => {
    await moduleRef?.close();
    const remove = async (
      action: (channel: amqp.Channel) => Promise<unknown>,
    ) => {
      const channel = await admin.createChannel();
      await action(channel).catch(() => undefined);
      await channel.close().catch(() => undefined);
    };
    for (const queue of Object.values(queues)) {
      await remove((channel) => channel.deleteQueue(queue));
    }
    for (const name of LISTENERS) {
      await remove((channel) => channel.deleteQueue(`${NAMESPACE}${name}`));
      await remove((channel) =>
        channel.deleteQueue(`${NAMESPACE}${name}.dead`),
      );
    }
    await remove((channel) => channel.deleteExchange(EXCHANGE));
    await admin.close().catch(() => undefined);
    process.env = { ...original };
  });

  const clearQueues = async () => {
    for (const queue of Object.values(queues)) await drain(queue);
  };

  it('puts the event on the exchange with its name as routing key, persistent, with its id and a JSON body (AC-1)', async () => {
    await clearQueues();
    const sent = event('order.created', {
      occurredAt: new Date('2026-10-11T08:00:00.000Z'),
      data: { orderId: 'O1', total: 3990000 },
    });

    await bus.publish(sent);

    // `publish` returned, so the broker has confirmed it: the message is there at once, no waiting
    const message = await take(queues.orders);
    expect(message).not.toBeNull();
    expect(message!.fields.exchange).toBe(EXCHANGE);
    expect(message!.fields.routingKey).toBe('order.created');
    expect(message!.properties.messageId).toBe(sent.id);
    expect(message!.properties.deliveryMode).toBe(2); // persistent
    expect(message!.properties.contentType).toBe('application/json');
    expect(JSON.parse(message!.content.toString())).toEqual({
      id: sent.id,
      name: 'order.created',
      occurredAt: '2026-10-11T08:00:00.000Z',
      data: { orderId: 'O1', total: 3990000 },
    });
  });

  it('declares a durable topic exchange (AC-1)', async () => {
    // Asking for the same exchange with the same settings works; with other settings the broker refuses
    const channel = await admin.createChannel();
    await expect(
      channel.assertExchange(EXCHANGE, 'topic', { durable: true }),
    ).resolves.toBeDefined();
    await channel.close();

    const wrong = await admin.createChannel();
    wrong.on('error', () => undefined);
    await expect(
      wrong.assertExchange(EXCHANGE, 'direct', { durable: true }),
    ).rejects.toThrow();
  });

  it('sends each event to the queues whose pattern matches, and to no other (AC-2)', async () => {
    await clearQueues();

    await bus.publish(event('order.created', { id: 'A' }));
    await bus.publish(event('payment.captured', { id: 'B' }));
    await bus.publish(event('order.status_changed', { id: 'C' }));

    const ids = async (queue: string) => {
      const found: string[] = [];
      for (;;) {
        const message = await take(queue);
        if (!message) return found;
        found.push(JSON.parse(message.content.toString()).id);
      }
    };
    expect(await ids(queues.orders)).toEqual(['A', 'C']);
    expect(await ids(queues.payments)).toEqual(['B']);
    expect(await ids(queues.everything)).toEqual(['A', 'B', 'C']);
  });

  it('gives every listener its own copy: two queues with the same pattern both get each event (AC-2)', async () => {
    await clearQueues();

    await bus.publish(event('order.created'));

    expect(await depth(queues.orders)).toBe(1);
    expect(await depth(queues.ordersToo)).toBe(1);
    // taking it from one queue does not take it from the other
    await take(queues.orders);
    expect(await depth(queues.ordersToo)).toBe(1);
  });

  it('keeps an event that no listener wants out of every queue that does not match (AC-2)', async () => {
    await clearQueues();

    await bus.publish(event('shipment.created'));

    expect(await depth(queues.orders)).toBe(0);
    expect(await depth(queues.payments)).toBe(0);
    expect(await depth(queues.everything)).toBe(1); // only the catch-all
  });

  it('answers 503 and sends nothing when there is no connection to the broker (AC-2)', async () => {
    const lonely = new RabbitMqEventBus(new RabbitMQService(), {
      namespace: NAMESPACE,
    });
    await clearQueues();

    await expect(lonely.publish(event('order.created'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(await depth(queues.orders)).toBe(0);
  });

  it('refuses an invalid event before it reaches the broker', async () => {
    await clearQueues();

    await expect(
      bus.publish(event('order.created', { id: '' })),
    ).rejects.toThrow(/id/);
    expect(await depth(queues.everything)).toBe(0);
  });

  it('answers 503 at once while the broker is away, and works again, exchange included, once it is back (AC-2)', async () => {
    const rabbit = moduleRef.get(RabbitMQService);
    const connection = (rabbit as any).connection as amqp.ChannelModel;

    // Make the broker unreachable (a wrong port) and cut the connection the way a network failure
    // would. Without the wrong port the service reconnects within milliseconds and the "away"
    // moment is too short to observe.
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
    await expect(bus.publish(event('order.created'))).rejects.toMatchObject({
      status: 503,
    });
    expect(Date.now() - started).toBeLessThan(1_000);

    // The broker is reachable again: the service reconnects by itself, the bus declares its
    // exchange on the new channel, and events flow again
    process.env.RABBITMQ_URL = goodUrl;
    await until(() => rabbit.isConnected(), 'the reconnection', 15_000);
    await clearQueues();
    await bus.publish(event('order.created'));
    expect(await depth(queues.orders)).toBe(1);
  }, 40_000);
  describe('listeners (subscribe)', () => {
    const ids = (seen: IntegrationEvent[]) => seen.map((e) => e.id);
    const queueOf = (name: string) => `${NAMESPACE}${name}`;

    it('gives every listener its own copy of each event that matches its pattern, and none of the others (AC-14)', async () => {
      const alpha: IntegrationEvent[] = [];
      const beta: IntegrationEvent[] = [];
      const paymentsOnly: IntegrationEvent[] = [];
      bus.subscribe({ name: 'sub.alpha', pattern: 'order.*' }, async (e) => {
        alpha.push(e);
      });
      bus.subscribe({ name: 'sub.beta', pattern: 'order.*' }, async (e) => {
        beta.push(e);
      });
      bus.subscribe(
        { name: 'sub.payments-only', pattern: 'payment.#' },
        async (e) => {
          paymentsOnly.push(e);
        },
      );
      for (const name of ['sub.alpha', 'sub.beta', 'sub.payments-only']) {
        await until(
          async () => (await consumers(queueOf(name))) === 1,
          `the listener ${name} to be consuming`,
        );
      }

      await bus.publish(event('order.created', { id: 'L1' }));
      await bus.publish(event('payment.succeeded', { id: 'L2' }));
      await bus.publish(event('order.status_changed', { id: 'L3' }));

      await until(
        () =>
          alpha.length === 2 && beta.length === 2 && paymentsOnly.length === 1,
        'the events to arrive',
      );
      expect(ids(alpha)).toEqual(['L1', 'L3']);
      expect(ids(beta)).toEqual(['L1', 'L3']);
      expect(ids(paymentsOnly)).toEqual(['L2']);
      expect(alpha[0]).toEqual({
        id: 'L1',
        name: 'order.created',
        occurredAt: expect.any(Date),
        data: { note: 'hello' },
      });
      // Handled and acknowledged: nothing waits in any of the queues
      await until(
        async () => (await depth(queueOf('sub.alpha'))) === 0,
        'the queue to be empty',
      );
      expect(await depth(queueOf('sub.beta'))).toBe(0);
    });

    it('moves an event to the dead-letter queue when its handler throws, once, without a retry loop (AC-14)', async () => {
      let calls = 0;
      bus.subscribe({ name: 'sub.failing', pattern: 'failing.*' }, async () => {
        calls++;
        throw new Error('cannot handle it');
      });
      await until(
        async () => (await consumers(queueOf('sub.failing'))) === 1,
        'the listener to be consuming',
      );

      await bus.publish(event('failing.thing', { id: 'F1' }));

      await until(
        async () => (await depth(`${queueOf('sub.failing')}.dead`)) === 1,
        'the event in the dead-letter queue',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(calls).toBe(1);
      expect(await depth(queueOf('sub.failing'))).toBe(0);
      const dead = await take(`${queueOf('sub.failing')}.dead`);
      expect(JSON.parse(dead!.content.toString()).id).toBe('F1');
      expect(dead!.properties.messageId).toBe('F1');
    });

    it('moves a message that is not an event to the dead-letter queue without calling the handler (AC-14)', async () => {
      const handler = vi.fn(async () => undefined);
      bus.subscribe({ name: 'sub.raw', pattern: 'raw.*' }, handler);
      await until(
        async () => (await consumers(queueOf('sub.raw'))) === 1,
        'the listener to be consuming',
      );

      adminChannel.publish(
        EXCHANGE,
        'raw.garbage',
        Buffer.from('this is not JSON'),
      );

      await until(
        async () => (await depth(`${queueOf('sub.raw')}.dead`)) === 1,
        'the message in the dead-letter queue',
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers an event again to the listener when the connection is lost in the middle of its handler (acknowledged only after it is done), and keeps listening after reconnecting (AC-14)', async () => {
      const rabbit = moduleRef.get(RabbitMQService);
      const seen: string[] = [];
      let release!: () => void;
      const stuck = new Promise<void>((resolve) => (release = resolve));
      bus.subscribe(
        { name: 'sub.crashing', pattern: 'crashing.*' },
        async (e) => {
          seen.push(e.id);
          if (seen.length === 1) await stuck; // the first delivery never finishes
        },
      );
      await until(
        async () => (await consumers(queueOf('sub.crashing'))) === 1,
        'the listener to be consuming',
      );
      await bus.publish(event('crashing.thing', { id: 'C1' }));
      await until(() => seen.length === 1, 'the handler to start');

      // The connection drops while the handler is working: the event was not acknowledged
      const connection = (rabbit as any).connection as amqp.ChannelModel;
      const goodUrl = process.env.RABBITMQ_URL;
      process.env.RABBITMQ_URL = 'amqp://admin:admin@localhost:5999';
      (connection as any).connection.stream.destroy(
        new Error('connection cut by the test'),
      );
      await until(
        () => !rabbit.isConnected(),
        'the connection to be noticed as lost',
      );
      process.env.RABBITMQ_URL = goodUrl;
      await until(() => rabbit.isConnected(), 'the reconnection', 15_000);

      // The broker gives the same event again, to the listener that came back
      await until(
        () => seen.length === 2,
        'the event to be delivered again',
        15_000,
      );
      expect(seen).toEqual(['C1', 'C1']);
      await until(
        async () => (await depth(queueOf('sub.crashing'))) === 0,
        'the queue to be empty',
      );
      // And new events still arrive
      await bus.publish(event('crashing.thing', { id: 'C2' }));
      await until(() => seen.includes('C2'), 'the next event');
      release(); // let the first, abandoned handler finish so shutdown does not wait for it
    }, 60_000);

    it('refuses a listener name that is already used', () => {
      expect(() =>
        bus.subscribe(
          { name: 'sub.alpha', pattern: '#' },
          async () => undefined,
        ),
      ).toThrow(/already exists/);
    });
  });
});
