import type { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import type { EventBusOptions, IEventBus } from './event-bus.port.js';
import { InMemoryEventBus } from './in-memory-event-bus.js';
import { RabbitMqEventBus } from './rabbitmq-event-bus.js';

/**
 * Picks the adapter for `JOB_QUEUE` (validated at boot by `validateEnv`): the same value that
 * picks the job queue, so a machine without RabbitMQ needs one switch, not two.
 */
export function createEventBus(
  env: NodeJS.ProcessEnv,
  rabbit: RabbitMQService,
  options: EventBusOptions,
): IEventBus {
  const kind = env.JOB_QUEUE ?? 'rabbitmq';
  switch (kind) {
    case 'inline':
      return new InMemoryEventBus();
    case 'rabbitmq':
      return new RabbitMqEventBus(rabbit, options);
    default:
      throw new Error(`Unknown JOB_QUEUE "${kind}"`);
  }
}
