import { Global, Module } from '@nestjs/common';
import { RabbitMQModule } from '../rabbitmq/rabbitmq.module.js';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import { createEventBus } from './event-bus.factory.js';
import {
  EVENT_BUS,
  EVENT_BUS_OPTIONS,
  type EventBusOptions,
} from './event-bus.port.js';

/**
 * Chooses the event bus by `JOB_QUEUE` (the same switch as the job queue): `rabbitmq` (default)
 * or `inline`. The choice is made when the module is built, not when this file is imported, so
 * tests can set it first. Global: any feature can inject `EVENT_BUS` without importing this module.
 */
@Global()
@Module({
  imports: [RabbitMQModule],
  providers: [
    { provide: EVENT_BUS_OPTIONS, useValue: {} satisfies EventBusOptions },
    {
      provide: EVENT_BUS,
      inject: [RabbitMQService, EVENT_BUS_OPTIONS],
      useFactory: (rabbit: RabbitMQService, options: EventBusOptions) =>
        createEventBus(process.env, rabbit, options),
    },
  ],
  exports: [EVENT_BUS],
})
export class EventBusModule {}
