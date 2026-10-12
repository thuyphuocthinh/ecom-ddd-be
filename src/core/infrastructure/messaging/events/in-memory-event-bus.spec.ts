import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { InMemoryEventBus } from './in-memory-event-bus.js';
import type { IntegrationEvent } from './event-bus.port.js';

const event = (
  overrides: Partial<IntegrationEvent> = {},
): IntegrationEvent => ({
  id: 'ev-1',
  name: 'order.created',
  occurredAt: new Date('2026-10-11T08:00:00.000Z'),
  data: { orderId: 'O1' },
  ...overrides,
});

describe('InMemoryEventBus (AC-16)', () => {
  it('remembers what was sent, oldest first', async () => {
    const bus = new InMemoryEventBus();

    await bus.publish(event());
    await bus.publish(event({ id: 'ev-2', name: 'order.status_changed' }));

    expect(bus.published.map((e) => e.id)).toEqual(['ev-1', 'ev-2']);
    expect(bus.published[1].name).toBe('order.status_changed');
  });

  it('keeps plain data: a later change to the sender object does not reach what was recorded', async () => {
    const bus = new InMemoryEventBus();
    const data = { orderId: 'O1', items: [{ skuId: 'A' }] };

    await bus.publish(event({ data }));
    data.items.push({ skuId: 'B' });

    expect(bus.published[0].data).toEqual({
      orderId: 'O1',
      items: [{ skuId: 'A' }],
    });
  });

  it('refuses an event that could not be sent for real (the same check as the RabbitMQ bus)', async () => {
    const bus = new InMemoryEventBus();

    await expect(bus.publish(event({ id: '' }))).rejects.toThrow(/id/);
    await expect(bus.publish(event({ name: '' }))).rejects.toThrow(/name/);
    expect(bus.published).toHaveLength(0);
  });

  it('forgets everything on clear()', async () => {
    const bus = new InMemoryEventBus();
    await bus.publish(event());

    bus.clear();

    expect(bus.published).toHaveLength(0);
  });
});

describe('InMemoryEventBus.subscribe (AC-14)', () => {
  const quiet = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  it('calls a listener for the events that match its pattern, and only those, inside publish', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe({ name: 'orders', pattern: 'order.*' }, async (e) => {
      seen.push(e.id);
    });

    await bus.publish(event({ id: 'A', name: 'order.created' }));
    await bus.publish(event({ id: 'B', name: 'payment.succeeded' }));
    await bus.publish(event({ id: 'C', name: 'order.status_changed' }));

    expect(seen).toEqual(['A', 'C']);
    expect(bus.published).toHaveLength(3); // everything is still recorded
  });

  it('gives every listener its own copy of the event', async () => {
    const bus = new InMemoryEventBus();
    const first: IntegrationEvent[] = [];
    const second: IntegrationEvent[] = [];
    bus.subscribe({ name: 'one', pattern: '#' }, async (e) => {
      (e.data as { n: number }).n = 99; // a listener changing what it got
      first.push(e);
    });
    bus.subscribe({ name: 'two', pattern: '#' }, async (e) => {
      second.push(e);
    });

    await bus.publish(event({ data: { n: 1 } }));

    expect(first[0].data).toEqual({ n: 99 });
    expect(second[0].data).toEqual({ n: 1 });
    expect(bus.published[0].data).toEqual({ n: 1 });
    expect(second[0].occurredAt).toEqual(new Date('2026-10-11T08:00:00.000Z'));
  });

  it('calls the listeners one after the other, and a listener that throws neither stops the others nor fails publish', async () => {
    const logged = quiet();
    const bus = new InMemoryEventBus();
    const order: string[] = [];
    bus.subscribe({ name: 'bad', pattern: '#' }, async () => {
      order.push('bad');
      throw new Error('boom');
    });
    bus.subscribe({ name: 'good', pattern: '#' }, async () => {
      order.push('good');
    });

    await expect(bus.publish(event())).resolves.toBeUndefined();

    expect(order).toEqual(['bad', 'good']);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('waits for a slow listener before publish returns', async () => {
    const bus = new InMemoryEventBus();
    let done = false;
    bus.subscribe({ name: 'slow', pattern: '#' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done = true;
    });

    await bus.publish(event());

    expect(done).toBe(true);
  });

  it('keeps its listeners when the record is cleared', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe({ name: 'x', pattern: '#' }, async (e) => {
      seen.push(e.id);
    });
    await bus.publish(event({ id: 'A' }));

    bus.clear();
    await bus.publish(event({ id: 'B' }));

    expect(seen).toEqual(['A', 'B']);
    expect(bus.published.map((e) => e.id)).toEqual(['B']);
  });

  it('refuses a name that is already used, and an invalid subscription', () => {
    const bus = new InMemoryEventBus();
    bus.subscribe({ name: 'x', pattern: '#' }, async () => undefined);

    expect(() =>
      bus.subscribe({ name: 'x', pattern: 'a.b' }, async () => undefined),
    ).toThrow(/already exists/);
    expect(() =>
      bus.subscribe({ name: 'UPPER', pattern: '#' }, async () => undefined),
    ).toThrow(/name/);
    expect(() =>
      bus.subscribe({ name: 'y', pattern: 'a b' }, async () => undefined),
    ).toThrow(/pattern/);
  });

  it('does not call a listener for an event that is not valid', async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn(async () => undefined);
    bus.subscribe({ name: 'x', pattern: '#' }, handler);

    await expect(bus.publish(event({ id: '' }))).rejects.toThrow(/id/);

    expect(handler).not.toHaveBeenCalled();
  });
});
