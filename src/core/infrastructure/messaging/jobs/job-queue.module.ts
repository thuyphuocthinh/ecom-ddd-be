import { Global, Module } from '@nestjs/common';
import { RabbitMQModule } from '../rabbitmq/rabbitmq.module.js';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import { createJobQueue } from './job-queue.factory.js';
import {
  JOB_QUEUE,
  JOB_QUEUE_OPTIONS,
  type JobQueueOptions,
} from './job-queue.port.js';

/**
 * Chooses the job queue by `JOB_QUEUE`: `rabbitmq` (default) or `inline`. The choice is made
 * when the module is built, not when this file is imported, so tests can set it first.
 * Global: any feature can inject `JOB_QUEUE` without importing this module.
 */
@Global()
@Module({
  imports: [RabbitMQModule],
  providers: [
    { provide: JOB_QUEUE_OPTIONS, useValue: {} satisfies JobQueueOptions },
    {
      provide: JOB_QUEUE,
      inject: [RabbitMQService, JOB_QUEUE_OPTIONS],
      useFactory: (rabbit: RabbitMQService, options: JobQueueOptions) =>
        createJobQueue(process.env, rabbit, options),
    },
  ],
  exports: [JOB_QUEUE],
})
export class JobQueueModule {}
