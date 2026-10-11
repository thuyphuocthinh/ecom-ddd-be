/**
 * Something that happened, told to whoever cares. It is an "integration event": it crosses the
 * border of the process, unlike the in-process `DomainEvent` of the domain layer. Business code
 * builds these and never touches the message broker: it only knows this port.
 */
export interface IntegrationEvent {
  /**
   * Stable and unique, chosen by the sender. A receiver uses it to recognise a message that
   * arrives twice (delivery is at-least-once, so that can happen).
   */
  readonly id: string;
  /**
   * What happened, as words joined by dots, from general to specific: `order.created`,
   * `order.status_changed`. It is the routing key, so a listener can ask for `order.*`.
   */
  readonly name: string;
  readonly occurredAt: Date;
  /** Plain JSON: what the receivers need to know. Keep personal data out of it. */
  readonly data: unknown;
}

/**
 * Tells the system that something happened. A job queue (`IJobQueue`) hands ONE worker a piece of
 * work; an event bus tells EVERY interested listener, each listener with its own queue.
 *
 * Only the sending side exists for now: a listener creates its own queue and binds it to the
 * exchange by hand. A listener API (own queue, retries, dead letters) comes with the first real
 * listener.
 */
export interface IEventBus {
  /**
   * Sends the event and returns once the broker has confirmed that it received and stored it.
   * Rejects with `ServiceUnavailableException` when that did not happen: the caller must then
   * treat the event as NOT sent (the outbox keeps the row unsent and tries again).
   * Rejects with an `Error` when the event itself is not valid (a mistake in the code).
   */
  publish(event: IntegrationEvent): Promise<void>;
}

/** DI token for the active IEventBus. */
export const EVENT_BUS = 'IEventBus';

/** Tuning that only tests change; the defaults are the real behaviour. */
export interface EventBusOptions {
  /** Prefix for the exchange name, so a test run never touches the real one. */
  namespace?: string;
}

export const EVENT_BUS_OPTIONS = 'EVENT_BUS_OPTIONS';

/** The message as it goes over the wire: everything an event has, with the time as text. */
export interface EventMessageBody {
  id: string;
  name: string;
  occurredAt: string;
  data: unknown;
}

/** Throws when the event cannot be sent as it is; used by every adapter before it does anything. */
export function assertValidEvent(event: IntegrationEvent): void {
  if (typeof event.id !== 'string' || event.id.trim() === '') {
    throw new Error('An event needs an id');
  }
  if (typeof event.name !== 'string' || event.name.trim() === '') {
    throw new Error(`Event ${event.id} needs a name`);
  }
  if (
    !(event.occurredAt instanceof Date) ||
    Number.isNaN(event.occurredAt.getTime())
  ) {
    throw new Error(`Event ${event.id} needs a valid occurredAt`);
  }
}

export function toMessageBody(event: IntegrationEvent): EventMessageBody {
  return {
    id: event.id,
    name: event.name,
    occurredAt: event.occurredAt.toISOString(),
    data: event.data,
  };
}
