import type { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import { InlineJobQueue } from './inline-job-queue.js';
import type { IJobQueue, JobQueueOptions } from './job-queue.port.js';
import { RabbitMqJobQueue } from './rabbitmq-job-queue.js';

/** Picks the adapter for `JOB_QUEUE` (validated at boot by `validateEnv`). */
export function createJobQueue(
  env: NodeJS.ProcessEnv,
  rabbit: RabbitMQService,
  options: JobQueueOptions,
): IJobQueue {
  const kind = env.JOB_QUEUE ?? 'rabbitmq';
  switch (kind) {
    case 'inline':
      return new InlineJobQueue();
    case 'rabbitmq':
      return new RabbitMqJobQueue(rabbit, options);
    default:
      throw new Error(`Unknown JOB_QUEUE "${kind}"`);
  }
}
