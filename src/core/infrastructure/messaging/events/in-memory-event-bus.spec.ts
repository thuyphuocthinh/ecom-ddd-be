import { describe, it, expect } from 'vitest';
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
