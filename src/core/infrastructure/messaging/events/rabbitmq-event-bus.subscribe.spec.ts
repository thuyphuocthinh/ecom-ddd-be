import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type * as amqp from 'amqplib';
import { RabbitMqEventBus } from './rabbitmq-event-bus.js';
import type { IntegrationEvent } from './event-bus.port.js';
import type { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';

type Delivery = (message: amqp.ConsumeMessage | null) => void;

const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'ev-1',
    name: 'order.status_changed',
    occurredAt: '2026-10-11T08:00:00.000Z',
    data: { orderId: 'O1', to: 'CANCELLED' },
    ...overrides,
  });
const message = (content: string) =>
  ({
    content: Buffer.from(content),
    fields: {},
    properties: {},
  }) as unknown as amqp.ConsumeMessage;
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('RabbitMqEventBus.subscribe (AC-14)', () => {
  let calls: string[];
  let deliveries: Record<string, Delivery>;
  let channel: Record<string, ReturnType<typeof vi.fn>>;
  let hooks: Array<(channel: amqp.ConfirmChannel) => Promise<void>>;
  let rabbit: {
    getChannel: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
    onConnected: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  };

  const makeChannel = () => {
    const c: Record<string, ReturnType<typeof vi.fn>> = {
      assertExchange: vi.fn(async () => {
        calls.push('exchange');
      }),
      assertQueue: vi.fn(async (queue: string) => {
        calls.push(`queue:${queue}`);
      }),
      bindQueue: vi.fn(async (queue: string, _e: string, pattern: string) => {
        calls.push(`bind:${queue}:${pattern}`);
      }),
      prefetch: vi.fn(async () => {
        calls.push('prefetch');
      }),
      consume: vi.fn(async (queue: string, onMessage: Delivery) => {
        calls.push(`consume:${queue}`);
        deliveries[queue] = onMessage;
        return { consumerTag: `tag-${queue}` };
      }),
      ack: vi.fn(),
      nack: vi.fn(),
      cancel: vi.fn(async () => undefined),
    };
    return c;
  };
  const makeBus = (namespace?: string) => {
    const bus = new RabbitMqEventBus(rabbit as unknown as RabbitMQService, {
      namespace,
    });
    bus.onModuleInit();
    return bus;
  };
  const connect = async (c = channel) => {
    for (const hook of hooks) await hook(c as unknown as amqp.ConfirmChannel);
  };

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    calls = [];
    deliveries = {};
    hooks = [];
    channel = makeChannel();
    rabbit = {
      getChannel: vi.fn(() => null),
      publish: vi.fn(),
      onConnected: vi.fn((hook) => {
        hooks.push(hook);
      }),
      start: vi.fn(),
    };
  });

  it('declares its own queue and a dead-letter queue, binds the pattern, then consumes, when the broker connects', async () => {
    const bus = makeBus();
    bus.subscribe(
      { name: 'payments.order-events', pattern: 'order.status_changed' },
      async () => undefined,
    );

    await connect();

    expect(calls).toEqual([
      'exchange',
      'queue:payments.order-events.dead',
      'queue:payments.order-events',
      'bind:payments.order-events:order.status_changed',
      'prefetch',
      'consume:payments.order-events',
    ]);
    expect(channel.assertQueue).toHaveBeenCalledWith('payments.order-events', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'payments.order-events.dead',
      },
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(
      'payments.order-events.dead',
      { durable: true },
    );
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'payments.order-events',
      'events',
      'order.status_changed',
    );
    expect(channel.consume).toHaveBeenCalledWith(
      'payments.order-events',
      expect.any(Function),
      { noAck: false },
    );
  });

  it('starts at once when it is subscribed after the broker is already connected', async () => {
    rabbit.getChannel.mockReturnValue(channel);
    const bus = makeBus();

    bus.subscribe({ name: 'late', pattern: '#' }, async () => undefined);
    await settleTicks();

    expect(channel.consume).toHaveBeenCalledWith('late', expect.any(Function), {
      noAck: false,
    });
  });

  it('prefixes the queues and the exchange with the namespace', async () => {
    const bus = makeBus('e2e-1.');
    bus.subscribe({ name: 'x', pattern: 'a.*' }, async () => undefined);

    await connect();

    expect(channel.assertQueue).toHaveBeenCalledWith(
      'e2e-1.x.dead',
      expect.anything(),
    );
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'e2e-1.x',
      'e2e-1.events',
      'a.*',
    );
  });

  it('listens again, on the new channel, after a reconnection', async () => {
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => undefined);
    await connect();
    const next = makeChannel();

    await connect(next);

    expect(next.consume).toHaveBeenCalledTimes(1);
    expect(channel.consume).toHaveBeenCalledTimes(1);
  });

  it('does not start a second consumer on the same channel', async () => {
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => undefined);
    await connect();

    await connect();

    expect(channel.consume).toHaveBeenCalledTimes(1);
  });

  it('gives the handler the event, and acknowledges it only AFTER the handler is done', async () => {
    const bus = makeBus();
    let finish!: () => void;
    const received: IntegrationEvent[] = [];
    bus.subscribe({ name: 'x', pattern: '#' }, (event) => {
      received.push(event);
      return new Promise<void>((resolve) => (finish = resolve));
    });
    await connect();
    const delivered = message(body());

    deliveries['x'](delivered);
    await settleTicks();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      id: 'ev-1',
      name: 'order.status_changed',
      occurredAt: new Date('2026-10-11T08:00:00.000Z'),
      data: { orderId: 'O1', to: 'CANCELLED' },
    });
    expect(channel.ack).not.toHaveBeenCalled(); // the handler is still working
    finish();
    await settleTicks();
    expect(channel.ack).toHaveBeenCalledWith(delivered);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('rejects an event without requeueing (so it goes to the dead-letter queue) when the handler throws', async () => {
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => {
      throw new Error('cannot handle it');
    });
    await connect();
    const delivered = message(body());

    deliveries['x'](delivered);
    await settleTicks();

    expect(channel.nack).toHaveBeenCalledWith(delivered, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'hello'],
    ['JSON without an id', body({ id: undefined })],
    ['JSON without a name', body({ name: '' })],
    ['JSON with a bad time', body({ occurredAt: 'yesterday' })],
    ['JSON that is not an object', '42'],
  ])(
    'moves a message that is not an event (%s) to the dead-letter queue without calling the handler',
    async (_, text) => {
      const handler = vi.fn(async () => undefined);
      const bus = makeBus();
      bus.subscribe({ name: 'x', pattern: '#' }, handler);
      await connect();
      const delivered = message(text);

      deliveries['x'](delivered);
      await settleTicks();

      expect(handler).not.toHaveBeenCalled();
      expect(channel.nack).toHaveBeenCalledWith(delivered, false, false);
    },
  );

  it('does not put the data of an event in the log when its handler fails', async () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => {
      throw new Error('boom');
    });
    await connect();

    deliveries['x'](message(body({ data: { phone: '0901234567' } })));
    await settleTicks();

    expect(logged.join(' ')).toContain('ev-1');
    expect(logged.join(' ')).not.toContain('0901234567');
  });

  it('survives an acknowledgement on a channel that has just closed', async () => {
    channel.ack.mockImplementation(() => {
      throw new Error('channel closed');
    });
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => undefined);
    await connect();

    expect(() => deliveries['x'](message(body()))).not.toThrow();
    await settleTicks();
  });

  it('listens again when the broker cancels the consumer', async () => {
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => undefined);
    await connect();

    deliveries['x'](null);
    await settleTicks();

    expect(channel.consume).toHaveBeenCalledTimes(2);
  });

  it('two listeners with different names each get their own queue', async () => {
    const bus = makeBus();
    bus.subscribe({ name: 'a', pattern: 'order.*' }, async () => undefined);
    bus.subscribe({ name: 'b', pattern: 'order.*' }, async () => undefined);

    await connect();

    expect(channel.bindQueue).toHaveBeenCalledWith('a', 'events', 'order.*');
    expect(channel.bindQueue).toHaveBeenCalledWith('b', 'events', 'order.*');
    expect(channel.consume).toHaveBeenCalledTimes(2);
    // prefetch and consume of one listener are never mixed with the other's
    expect(
      calls.filter((c) => c === 'prefetch' || c.startsWith('consume')),
    ).toEqual(['prefetch', 'consume:a', 'prefetch', 'consume:b']);
  });

  it('refuses a name that is already used, and an invalid subscription', () => {
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => undefined);

    expect(() =>
      bus.subscribe({ name: 'x', pattern: 'a' }, async () => undefined),
    ).toThrow(/already exists/);
    expect(() =>
      bus.subscribe({ name: 'Bad Name', pattern: '#' }, async () => undefined),
    ).toThrow(/name/);
    expect(() =>
      bus.subscribe({ name: 'y', pattern: 'a..b' }, async () => undefined),
    ).toThrow(/pattern/);
    expect(() =>
      bus.subscribe({ name: 'z', pattern: '' }, async () => undefined),
    ).toThrow(/pattern/);
  });

  it('on shutdown stops the consumers and waits for the events being handled', async () => {
    const bus = makeBus();
    let finish!: () => void;
    let done = false;
    bus.subscribe({ name: 'x', pattern: '#' }, async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      done = true;
    });
    await connect();
    deliveries['x'](message(body()));
    await settleTicks();

    const shutdown = bus.beforeApplicationShutdown();
    await settleTicks();
    expect(channel.cancel).toHaveBeenCalledWith('tag-x');
    expect(done).toBe(false);
    finish();
    await shutdown;

    expect(done).toBe(true);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('does not start listening again after shutdown began', async () => {
    const bus = makeBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => undefined);
    await bus.beforeApplicationShutdown();

    await connect();

    expect(channel.consume).not.toHaveBeenCalled();
  });
});
