import {
  assertValidEvent,
  type IntegrationEvent,
  type IEventBus,
} from './event-bus.port.js';

/**
 * Event bus that only remembers what was sent, for tests and for a machine without RabbitMQ
 * (`JOB_QUEUE=inline`). Nobody listens: a test reads `published` to see what was sent.
 */
export class InMemoryEventBus implements IEventBus {
  private readonly sent: IntegrationEvent[] = [];

  async publish(event: IntegrationEvent): Promise<void> {
    assertValidEvent(event);
    // A copy through JSON, so a test sees what a real receiver would: plain data, no shared objects
    this.sent.push({
      ...event,
      data: JSON.parse(JSON.stringify(event.data ?? null)),
    });
  }

  /** Everything sent so far, oldest first. */
  get published(): readonly IntegrationEvent[] {
    return this.sent;
  }

  /** Forgets what was sent. */
  clear(): void {
    this.sent.length = 0;
  }
}
