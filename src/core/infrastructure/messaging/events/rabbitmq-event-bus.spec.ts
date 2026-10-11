import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { RabbitMqEventBus } from './rabbitmq-event-bus.js';
import type { IntegrationEvent } from './event-bus.port.js';
import type { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';

const event = (
  overrides: Partial<IntegrationEvent> = {},
): IntegrationEvent => ({
  id: 'ev-1',
  name: 'order.created',
  occurredAt: new Date('2026-10-11T08:00:00.000Z'),
  data: { orderId: 'O1', total: 3990000 },
  ...overrides,
});

describe('RabbitMqEventBus (AC-16)', () => {
  let channel: { assertExchange: ReturnType<typeof vi.fn> };
  let rabbit: {
    getChannel: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
    onConnected: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  };
  let order: string[];

  const makeBus = (namespace?: string) =>
    new RabbitMqEventBus(rabbit as unknown as RabbitMQService, { namespace });

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    order = [];
    channel = {
      assertExchange: vi.fn(async () => {
        order.push('declare');
      }),
    };
    rabbit = {
      getChannel: vi.fn(() => channel),
      publish: vi.fn(async () => {
        order.push('publish');
      }),
      onConnected: vi.fn(),
      start: vi.fn(),
    };
  });

  it('puts the event on the exchange "events", with its name as the routing key, a JSON body and its id as messageId', async () => {
    await makeBus().publish(event());

    expect(rabbit.publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, content, options, onChannel] =
      rabbit.publish.mock.calls[0];
    expect(exchange).toBe('events');
    expect(routingKey).toBe('order.created');
    expect(JSON.parse((content as Buffer).toString())).toEqual({
      id: 'ev-1',
      name: 'order.created',
      occurredAt: '2026-10-11T08:00:00.000Z',
      data: { orderId: 'O1', total: 3990000 },
    });
    expect(options).toEqual({
      contentType: 'application/json',
      messageId: 'ev-1',
    });
    // on the very channel the exchange was declared on
    expect(onChannel).toBe(channel);
  });

  it('declares a durable topic exchange before the first publish, and only once per channel', async () => {
    const bus = makeBus();

    await bus.publish(event());
    await bus.publish(event({ id: 'ev-2' }));

    expect(channel.assertExchange).toHaveBeenCalledTimes(1);
    expect(channel.assertExchange).toHaveBeenCalledWith('events', 'topic', {
      durable: true,
    });
    expect(order).toEqual(['declare', 'publish', 'publish']);
  });

  it('declares the exchange again on a new channel (after a reconnect)', async () => {
    const bus = makeBus();
    await bus.publish(event());
    const next = { assertExchange: vi.fn(async () => undefined) };
    rabbit.getChannel.mockReturnValue(next);

    await bus.publish(event({ id: 'ev-2' }));

    expect(next.assertExchange).toHaveBeenCalledTimes(1);
  });

  it('declares the exchange at every (re)connection and starts connecting when the module starts', async () => {
    const bus = makeBus();

    bus.onModuleInit();

    expect(rabbit.start).toHaveBeenCalledTimes(1);
    expect(rabbit.onConnected).toHaveBeenCalledTimes(1);
    const hook = rabbit.onConnected.mock.calls[0][0];
    await hook(channel);
    expect(channel.assertExchange).toHaveBeenCalledWith('events', 'topic', {
      durable: true,
    });
  });

  it('prefixes the exchange name with the namespace, so a test never touches the real exchange', async () => {
    await makeBus('e2e-1.').publish(event());

    expect(channel.assertExchange.mock.calls[0][0]).toBe('e2e-1.events');
    expect(rabbit.publish.mock.calls[0][0]).toBe('e2e-1.events');
  });

  it('answers 503 and sends nothing when there is no connection', async () => {
    rabbit.getChannel.mockReturnValue(null);

    await expect(makeBus().publish(event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  it('answers 503 and sends nothing when the exchange cannot be declared', async () => {
    channel.assertExchange.mockRejectedValue(new Error('channel closed'));

    await expect(makeBus().publish(event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  it('lets the 503 of a publish that the broker did not confirm through, so the caller treats it as not sent', async () => {
    rabbit.publish.mockRejectedValue(
      new ServiceUnavailableException('Message broker is unavailable'),
    );

    await expect(makeBus().publish(event())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each([
    ['an empty id', { id: '' }],
    ['a blank name', { name: '   ' }],
    ['an invalid time', { occurredAt: new Date('nope') }],
  ])('refuses %s before doing anything', async (_, bad) => {
    await expect(makeBus().publish(event(bad))).rejects.toThrow(Error);

    expect(rabbit.getChannel).not.toHaveBeenCalled();
    expect(rabbit.publish).not.toHaveBeenCalled();
  });
});
