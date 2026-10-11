import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventBusModule } from './event-bus.module.js';
import { createEventBus } from './event-bus.factory.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';
import { RabbitMqEventBus } from './rabbitmq-event-bus.js';
import { EVENT_BUS } from './event-bus.port.js';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';

describe('createEventBus', () => {
  const rabbit = {} as RabbitMQService;

  it('defaults to RabbitMQ', () => {
    expect(createEventBus({}, rabbit, {})).toBeInstanceOf(RabbitMqEventBus);
  });

  it.each([
    ['rabbitmq', RabbitMqEventBus],
    ['inline', InMemoryEventBus],
  ])('picks the adapter named by JOB_QUEUE=%s', (kind, adapter) => {
    expect(createEventBus({ JOB_QUEUE: kind }, rabbit, {})).toBeInstanceOf(
      adapter,
    );
  });

  it('refuses an unknown value instead of silently picking one', () => {
    expect(() => createEventBus({ JOB_QUEUE: 'kafka' }, rabbit, {})).toThrow(
      /Unknown JOB_QUEUE/,
    );
  });
});

describe('EventBusModule (AC-16)', () => {
  const original = process.env.JOB_QUEUE;
  let start: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    start = vi.spyOn(RabbitMQService.prototype, 'start');
  });
  afterEach(() => {
    if (original === undefined) delete process.env.JOB_QUEUE;
    else process.env.JOB_QUEUE = original;
    vi.restoreAllMocks();
  });

  it('builds the in-memory bus for JOB_QUEUE=inline and never opens a RabbitMQ connection', async () => {
    process.env.JOB_QUEUE = 'inline';

    const moduleRef = await Test.createTestingModule({
      imports: [EventBusModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(EVENT_BUS)).toBeInstanceOf(InMemoryEventBus);
    expect(start).not.toHaveBeenCalled();
    expect(moduleRef.get(RabbitMQService).isConnected()).toBe(false);
    await moduleRef.close();
  });

  it('reads JOB_QUEUE when the module is built, not when the file is imported', async () => {
    process.env.JOB_QUEUE = 'inline';
    const first = await Test.createTestingModule({
      imports: [EventBusModule],
    }).compile();
    expect(first.get(EVENT_BUS)).toBeInstanceOf(InMemoryEventBus);

    process.env.JOB_QUEUE = 'rabbitmq';
    const second = await Test.createTestingModule({
      imports: [EventBusModule],
    }).compile();
    expect(second.get(EVENT_BUS)).toBeInstanceOf(RabbitMqEventBus);
    // Built but not initialised: nothing connected
    expect(start).not.toHaveBeenCalled();
  });
});
