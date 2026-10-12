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
 * A listener is named and says which events it wants (`subscribe`); the bus gives it its own queue
 * and a dead-letter queue for the events it could not handle.
 */
export interface IEventBus {
  /**
   * Sends the event and returns once the broker has confirmed that it received and stored it.
   * Rejects with `ServiceUnavailableException` when that did not happen: the caller must then
   * treat the event as NOT sent (the outbox keeps the row unsent and tries again).
   * Rejects with an `Error` when the event itself is not valid (a mistake in the code).
   */
  publish(event: IntegrationEvent): Promise<void>;

  /**
   * Starts listening: `handler` is called for every event whose name matches the pattern. Call it
   * while the application starts; it takes effect at once when the broker is connected, and again
   * after every reconnection.
   *
   * Delivery is at least once: the handler can see the same event twice, so it must cope (see the
   * event id). The event counts as handled when the handler returns; when it throws, the event
   * is moved to the dead-letter queue (`<name>.dead`) instead of being lost or retried for ever.
   * The in-memory bus calls the handlers inside `publish` and only logs a handler's error.
   *
   * Throws an `Error` for an invalid subscription or a name that is already in use.
   */
  subscribe(subscription: EventSubscription, handler: EventHandler): void;
}

/** What a listener wants to hear. */
export interface EventSubscription {
  /**
   * Names the listener, and with it its queue and its dead-letter queue (`<name>.dead`): lowercase
   * letters, digits, dots and hyphens, such as `payments.order-events`. Unique in the system.
   */
  readonly name: string;
  /**
   * Which events, as a routing-key pattern: words joined by dots where `*` stands for exactly one
   * word and `#` for any number of words (`order.*`, `order.status_changed`, `#`).
   */
  readonly pattern: string;
}

export type EventHandler = (event: IntegrationEvent) => Promise<void>;

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

const SUBSCRIPTION_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PATTERN_WORD = /^[A-Za-z0-9_-]+$/;

/** Throws when the subscription cannot be used as it is; used by every adapter. */
export function assertValidSubscription(subscription: EventSubscription): void {
  if (
    typeof subscription?.name !== 'string' ||
    !SUBSCRIPTION_NAME.test(subscription.name)
  ) {
    throw new Error(
      'A listener name is lowercase letters, digits, dots and hyphens (at most 100 characters)',
    );
  }
  const pattern = subscription.pattern;
  if (
    typeof pattern !== 'string' ||
    pattern === '' ||
    !pattern
      .split('.')
      .every((word) => word === '*' || word === '#' || PATTERN_WORD.test(word))
  ) {
    throw new Error(
      `Listener ${subscription.name} needs a pattern of words joined by dots (* and # stand for words)`,
    );
  }
}

/**
 * Reads a message body back into an event. Returns null when it is not one (not JSON, or without
 * an id, a name or a valid time): such a message can never be handled, so the adapter dead-letters it.
 */
export function fromMessageBody(text: string): IntegrationEvent | null {
  let body: Partial<EventMessageBody>;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !body ||
    typeof body.id !== 'string' ||
    body.id.trim() === '' ||
    typeof body.name !== 'string' ||
    body.name.trim() === '' ||
    typeof body.occurredAt !== 'string'
  ) {
    return null;
  }
  const occurredAt = new Date(body.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return null;
  return { id: body.id, name: body.name, occurredAt, data: body.data };
}
