import { Logger } from '@nestjs/common';
import {
  assertValidEvent,
  assertValidSubscription,
  type EventHandler,
  type EventSubscription,
  type IntegrationEvent,
  type IEventBus,
} from './event-bus.port.js';
import { matchesTopic } from './topic-match.js';

interface Listener {
  subscription: EventSubscription;
  handler: EventHandler;
}

/**
 * Event bus that remembers what was sent, for tests and for a machine without RabbitMQ
 * (`JOB_QUEUE=inline`). `published` lets a test read back what was sent. Listeners are called
 * inside `publish`, one after the other, so a test sees their effect as soon as `publish`
 * returns; a listener that throws is logged and does not stop the others or fail `publish`
 * (on RabbitMQ the event would go to the dead-letter queue).
 */
export class InMemoryEventBus implements IEventBus {
  private readonly logger = new Logger(InMemoryEventBus.name);
  private readonly sent: IntegrationEvent[] = [];
  private readonly listeners = new Map<string, Listener>();

  async publish(event: IntegrationEvent): Promise<void> {
    assertValidEvent(event);
    // A copy through JSON, so a test sees what a real receiver would: plain data, no shared objects
    this.sent.push(copyOf(event));

    for (const { subscription, handler } of this.listeners.values()) {
      if (!matchesTopic(subscription.pattern, event.name)) continue;
      try {
        await handler(copyOf(event));
      } catch (error) {
        this.logger.error(
          `Listener "${subscription.name}" failed on event ${event.id} (${event.name}): ${(error as Error).message}`,
        );
      }
    }
  }

  subscribe(subscription: EventSubscription, handler: EventHandler): void {
    assertValidSubscription(subscription);
    if (this.listeners.has(subscription.name)) {
      throw new Error(`Listener "${subscription.name}" already exists`);
    }
    this.listeners.set(subscription.name, { subscription, handler });
  }

  /** Everything sent so far, oldest first. */
  get published(): readonly IntegrationEvent[] {
    return this.sent;
  }

  /** Forgets what was sent. The listeners stay. */
  clear(): void {
    this.sent.length = 0;
  }
}

function copyOf(event: IntegrationEvent): IntegrationEvent {
  return {
    ...event,
    occurredAt: new Date(event.occurredAt.getTime()),
    data: JSON.parse(JSON.stringify(event.data ?? null)),
  };
}
