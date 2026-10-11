import {
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type * as amqp from 'amqplib';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import {
  assertValidEvent,
  toMessageBody,
  type IntegrationEvent,
  type EventBusOptions,
  type IEventBus,
} from './event-bus.port.js';

/**
 * Event bus on RabbitMQ: one exchange of the `topic` kind, named `events`. An event goes in with
 * its name as the routing key (`order.created`); a listener binds its own queue to the exchange
 * with a pattern (`order.*`) and gets a copy of every event that matches. The exchange is
 * declared durable, and every message is persistent.
 *
 * `publish` waits for the broker's confirmation (the connection class does that), so a caller
 * that sees it return knows the broker has the message; a caller that sees an error must assume
 * it does not. It also declares the exchange on the channel before the first publish: publishing
 * to an exchange that does not exist makes the broker close the channel.
 */
export class RabbitMqEventBus implements IEventBus, OnModuleInit {
  private readonly logger = new Logger(RabbitMqEventBus.name);
  private readonly declared = new WeakSet<amqp.ConfirmChannel>();
  private readonly exchange: string;

  constructor(
    private readonly rabbit: RabbitMQService,
    options: EventBusOptions = {},
  ) {
    this.exchange = `${options.namespace ?? ''}events`;
  }

  onModuleInit(): void {
    // After every (re)connection the new channel gets the exchange again
    this.rabbit.onConnected((channel) => this.declareExchange(channel));
    this.rabbit.start();
  }

  async publish(event: IntegrationEvent): Promise<void> {
    assertValidEvent(event);

    const channel = this.rabbit.getChannel();
    if (!channel) {
      throw new ServiceUnavailableException('Message broker is unavailable');
    }
    try {
      await this.declareExchange(channel);
    } catch (error) {
      this.logger.error(
        `Could not prepare the exchange "${this.exchange}": ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException('Message broker is unavailable');
    }

    await this.rabbit.publish(
      this.exchange,
      event.name,
      Buffer.from(JSON.stringify(toMessageBody(event))),
      { contentType: 'application/json', messageId: event.id },
      // The channel the exchange was declared on
      channel,
    );
  }

  private async declareExchange(channel: amqp.ConfirmChannel): Promise<void> {
    if (this.declared.has(channel)) return;
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    this.declared.add(channel);
  }
}
