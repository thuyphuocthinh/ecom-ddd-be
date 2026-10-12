import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  InMemoryEventBus,
  PrismaService,
  type IEventBus,
  type IntegrationEvent,
} from '@/core/index.js';
import { PrismaOutboxStore } from '../database/prisma-outbox.store.js';
import { OutboxPublisher } from './outbox-publisher.service.js';
import type { OrdersConfig } from '../../orders.config.js';

// The publisher only sends, so these fakes only publish
type Publisher = Pick<IEventBus, 'publish'>;

/** Against the real Postgres: the order of events, the row locks, and what a failure leaves behind. */
describe('OutboxPublisher (Integration)', () => {
  let prisma: PrismaService;
  let store: PrismaOutboxStore;

  const config = (overrides: Partial<OrdersConfig> = {}): OrdersConfig => ({
    outboxIntervalMs: 0,
    outboxBatchSize: 50,
    maintenanceIntervalSeconds: 0,
    ...overrides,
  });
  const publisherWith = (
    bus: Publisher,
    overrides: Partial<OrdersConfig> = {},
  ) => new OutboxPublisher(store, bus as IEventBus, config(overrides));

  const addEvents = async (count: number, type = 'order.created') => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      ids.push(id);
      await prisma.outboxEvent.create({
        data: { id, type, aggregateId: `agg-${i}`, payload: { n: i } },
      });
    }
    return ids;
  };
  const unsent = () =>
    prisma.outboxEvent.count({ where: { publishedAt: null } });
  const until = async (
    condition: () => boolean | Promise<boolean>,
    what: string,
  ) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService, PrismaOutboxStore],
    }).compile();
    prisma = module.get(PrismaService);
    store = module.get(PrismaOutboxStore);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany();
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.$disconnect();
    vi.restoreAllMocks();
  });

  it('sends the unsent events in the order they were written, and marks them sent', async () => {
    const ids = await addEvents(5);
    const bus = new InMemoryEventBus();

    const result = await publisherWith(bus).runOnce();

    expect(result).toEqual({ sent: 5, failure: null });
    expect(bus.published.map((e) => e.id)).toEqual(ids);
    expect(await unsent()).toBe(0);
  });

  it('sends the event with its id, its name, its data and the time it was written', async () => {
    const [id] = await addEvents(1, 'order.status_changed');
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    const bus = new InMemoryEventBus();

    await publisherWith(bus).runOnce();

    expect(bus.published[0]).toEqual({
      id,
      name: 'order.status_changed',
      occurredAt: row.createdAt,
      data: { n: 0 },
    });
  });

  it('does nothing when there is nothing to send', async () => {
    const bus = new InMemoryEventBus();

    expect(await publisherWith(bus).runOnce()).toEqual({
      sent: 0,
      failure: null,
    });
    expect(bus.published).toHaveLength(0);
  });

  it('does not send an event that was already sent', async () => {
    await addEvents(3);
    const bus = new InMemoryEventBus();
    const publisher = publisherWith(bus);
    await publisher.runOnce();
    bus.clear();

    await publisher.runOnce();

    expect(bus.published).toHaveLength(0);
  });

  it('sends at most one batch per round, and the next round continues where it stopped', async () => {
    const ids = await addEvents(5);
    const bus = new InMemoryEventBus();
    const publisher = publisherWith(bus, { outboxBatchSize: 2 });

    expect((await publisher.runOnce()).sent).toBe(2);
    expect((await publisher.runOnce()).sent).toBe(2);
    expect((await publisher.runOnce()).sent).toBe(1);
    expect((await publisher.runOnce()).sent).toBe(0);

    expect(bus.published.map((e) => e.id)).toEqual(ids);
  });

  describe('when sending fails halfway', () => {
    const failingFrom = (position: number) => {
      const received: string[] = [];
      let calls = 0;
      const bus: Publisher = {
        async publish(event: IntegrationEvent) {
          if (calls++ >= position) {
            throw new ServiceUnavailableException('The broker is down');
          }
          received.push(event.id);
        },
      };
      return { bus, received };
    };

    it('marks the events before the failure, leaves that one and the rest unsent, and says why', async () => {
      const ids = await addEvents(5);
      const { bus, received } = failingFrom(2);

      const result = await publisherWith(bus).runOnce();

      expect(result.sent).toBe(2);
      expect(result.failure).toBeInstanceOf(ServiceUnavailableException);
      expect(received).toEqual(ids.slice(0, 2));
      const stillUnsent = await prisma.outboxEvent.findMany({
        where: { publishedAt: null },
        orderBy: { seq: 'asc' },
      });
      expect(stillUnsent.map((e) => e.id)).toEqual(ids.slice(2));
    });

    it('sends the rest in the next round once the broker is back, in the same order', async () => {
      const ids = await addEvents(5);
      await publisherWith(failingFrom(2).bus).runOnce();
      const bus = new InMemoryEventBus();

      const result = await publisherWith(bus).runOnce();

      expect(result).toEqual({ sent: 3, failure: null });
      expect(bus.published.map((e) => e.id)).toEqual(ids.slice(2));
    });

    it('keeps everything unsent when the very first event fails', async () => {
      await addEvents(3);

      const result = await publisherWith(failingFrom(0).bus).runOnce();

      expect(result.sent).toBe(0);
      expect(result.failure).not.toBeNull();
      expect(await unsent()).toBe(3);
    });
  });

  describe('two publishers at the same time', () => {
    it('never send the same event in the same moment: together they send every event exactly once', async () => {
      const ids = await addEvents(40);
      const first = new InMemoryEventBus();
      const second = new InMemoryEventBus();

      const [a, b] = await Promise.all([
        publisherWith(first, { outboxBatchSize: 10 }).runOnce(),
        publisherWith(second, { outboxBatchSize: 10 }).runOnce(),
      ]);

      // Each took its own 10 rows: the one that came second skipped the rows the first held
      expect(a.sent + b.sent).toBe(20);
      const all = [...first.published, ...second.published].map((e) => e.id);
      expect(new Set(all).size).toBe(20);
      expect(await unsent()).toBe(20);

      // And draining the rest in parallel still sends each event once
      const rest = [new InMemoryEventBus(), new InMemoryEventBus()];
      await Promise.all(
        rest.map((bus) =>
          publisherWith(bus, { outboxBatchSize: 10 }).runOnce(),
        ),
      );
      const every = [
        ...first.published,
        ...second.published,
        ...rest.flatMap((b) => [...b.published]),
      ].map((e) => e.id);
      expect([...every].sort()).toEqual([...ids].sort());
      expect(await unsent()).toBe(0);
    });

    it('a second publisher skips the rows the first one is holding while it sends', async () => {
      const ids = await addEvents(3);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: Publisher = { publish: () => gate };
      const second = new InMemoryEventBus();

      const first = publisherWith(slow).runOnce();
      // Wait until the first publisher has locked its rows
      await new Promise((resolve) => setTimeout(resolve, 200));
      const whileHeld = await publisherWith(second).runOnce();
      release();
      await first;

      expect(whileHeld).toEqual({ sent: 0, failure: null });
      expect(second.published).toHaveLength(0);
      expect(await unsent()).toBe(0);
      expect(ids).toHaveLength(3);
    });
  });

  it('sends an event again when the process dies after sending but before marking it (at least once)', async () => {
    const [id] = await addEvents(1);
    const bus = new InMemoryEventBus();
    // The broker took the event, then the round was cut off before the "sent" mark was committed
    const crashing: Publisher = {
      async publish(event) {
        await bus.publish(event);
        throw new Error('process died');
      },
    };
    await publisherWith(crashing).runOnce();

    await publisherWith(bus).runOnce();

    // Two copies of the same event, with the same id: a receiver drops the second by that id
    expect(bus.published.map((e) => e.id)).toEqual([id, id]);
    expect(await unsent()).toBe(0);
  });

  describe('on a timer', () => {
    it('sends events by itself, without overlapping with itself', async () => {
      const ids = await addEvents(3);
      let active = 0;
      let mostAtOnce = 0;
      const sent: string[] = [];
      const bus: Publisher = {
        async publish(event) {
          active++;
          mostAtOnce = Math.max(mostAtOnce, active);
          await new Promise((resolve) => setTimeout(resolve, 60));
          sent.push(event.id);
          active--;
        },
      };
      const publisher = publisherWith(bus, {
        outboxIntervalMs: 10,
        outboxBatchSize: 1,
      });

      publisher.onModuleInit();
      await until(() => sent.length === 3, 'the three events');
      await publisher.onApplicationShutdown();

      expect(sent).toEqual(ids);
      expect(mostAtOnce).toBe(1);
      expect(await unsent()).toBe(0);
    });

    it('keeps going after a failed round, and picks the event up when the broker is back', async () => {
      await addEvents(1);
      let healthy = false;
      const bus = new InMemoryEventBus();
      const flaky: Publisher = {
        publish: (event) =>
          healthy
            ? bus.publish(event)
            : Promise.reject(new ServiceUnavailableException('down')),
      };
      const publisher = publisherWith(flaky, { outboxIntervalMs: 10 });

      publisher.onModuleInit();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(bus.published).toHaveLength(0);
      healthy = true;
      await until(() => bus.published.length === 1, 'the event after recovery');
      await publisher.onApplicationShutdown();

      expect(await unsent()).toBe(0);
    });

    it('is off when the interval is 0: nothing is sent by itself', async () => {
      await addEvents(2);
      const bus = new InMemoryEventBus();
      const publisher = publisherWith(bus, { outboxIntervalMs: 0 });

      publisher.onModuleInit();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await publisher.onApplicationShutdown();

      expect(bus.published).toHaveLength(0);
      expect(await unsent()).toBe(2);
    });

    it('waits for the round in progress when the application shuts down', async () => {
      await addEvents(1);
      let finished = false;
      const bus: Publisher = {
        async publish() {
          await new Promise((resolve) => setTimeout(resolve, 150));
          finished = true;
        },
      };
      const publisher = publisherWith(bus, { outboxIntervalMs: 10 });

      publisher.onModuleInit();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await publisher.onApplicationShutdown();

      expect(finished).toBe(true);
      expect(await unsent()).toBe(0);
    });
  });
});
