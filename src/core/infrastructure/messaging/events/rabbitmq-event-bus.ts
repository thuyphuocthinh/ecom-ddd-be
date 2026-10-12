import {
  BeforeApplicationShutdown,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type * as amqp from 'amqplib';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';
import {
  assertValidEvent,
  assertValidSubscription,
  fromMessageBody,
  toMessageBody,
  type EventHandler,
  type EventSubscription,
  type IntegrationEvent,
  type EventBusOptions,
  type IEventBus,
} from './event-bus.port.js';

// How many events a listener works on at once. Each one is acknowledged only when it is done.
const PREFETCH = 10;

interface Listener {
  subscription: EventSubscription;
  handler: EventHandler;
  /** Set while a consumer is running on `channel`. */
  consumerTag?: string;
  channel?: amqp.ConfirmChannel;
}

/**
 * Event bus on RabbitMQ: one exchange of the `topic` kind, named `events`. An event goes in with
 * its name as the routing key (`order.created`); a listener has its own queue bound to the exchange
 * with a pattern (`order.*`) and gets a copy of every event that matches. The exchange and the
 * queues are durable, and every message is persistent.
 *
 * `publish` waits for the broker's confirmation (the connection class does that), so a caller
 * that sees it return knows the broker has the message; a caller that sees an error must assume
 * it does not. It also declares the exchange on the channel before the first publish: publishing
 * to an exchange that does not exist makes the broker close the channel.
 *
 * A listener's queue is `<name>` and its dead-letter queue `<name>.dead` (declared as the dead
 * letter target of the first one). An event is acknowledged only AFTER the handler returned, so a
 * process that dies in the middle of a handler gets the event again (at least once). A handler
 * that throws, or a message that is not an event at all, is rejected without requeueing, which
 * moves it to the dead-letter queue: it is not lost and it does not come back in a loop.
 */
export class RabbitMqEventBus
  implements IEventBus, OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RabbitMqEventBus.name);
  private readonly declared = new WeakSet<amqp.ConfirmChannel>();
  private readonly exchange: string;
  private readonly namespace: string;
  private readonly listeners = new Map<string, Listener>();
  private readonly inFlight = new Set<Promise<void>>();
  private draining = false;
  // `prefetch` applies to the consumers started after it, so it and `consume` must not interleave
  // between two listeners
  private setUpChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rabbit: RabbitMQService,
    options: EventBusOptions = {},
  ) {
    this.namespace = options.namespace ?? '';
    this.exchange = `${this.namespace}events`;
  }

  onModuleInit(): void {
    // After every (re)connection the new channel gets the exchange and every listener again
    this.rabbit.onConnected(async (channel) => {
      await this.declareExchange(channel);
      for (const listener of this.listeners.values()) {
        await this.serially(() => this.setUpListener(channel, listener));
      }
    });
    this.rabbit.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true;
    for (const listener of this.listeners.values()) {
      const { consumerTag, channel } = listener;
      listener.consumerTag = undefined;
      if (consumerTag && channel) {
        await channel.cancel(consumerTag).catch(() => undefined);
      }
    }
    await Promise.allSettled(this.inFlight);
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

  subscribe(subscription: EventSubscription, handler: EventHandler): void {
    assertValidSubscription(subscription);
    if (this.listeners.has(subscription.name)) {
      throw new Error(`Listener "${subscription.name}" already exists`);
    }
    const listener: Listener = { subscription, handler };
    this.listeners.set(subscription.name, listener);

    // Already connected: start now. Otherwise the connection hook does it when it comes.
    const channel = this.rabbit.getChannel();
    if (channel) {
      this.serially(() => this.setUpListener(channel, listener)).catch(
        (error: Error) =>
          this.logger.error(
            `Could not start listener "${subscription.name}": ${error.message}`,
          ),
      );
    }
  }

  private async declareExchange(channel: amqp.ConfirmChannel): Promise<void> {
    if (this.declared.has(channel)) return;
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    this.declared.add(channel);
  }

  private async setUpListener(
    channel: amqp.ConfirmChannel,
    listener: Listener,
  ): Promise<void> {
    if (this.draining) return;
    if (listener.consumerTag && listener.channel === channel) return;

    const { name, pattern } = listener.subscription;
    const queue = `${this.namespace}${name}`;
    const dead = `${queue}.dead`;
    await this.declareExchange(channel);
    await channel.assertQueue(dead, { durable: true });
    await channel.assertQueue(queue, {
      durable: true,
      // A message rejected without requeueing goes through the default exchange to the dead queue
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': dead,
      },
    });
    await channel.bindQueue(queue, this.exchange, pattern);

    await channel.prefetch(PREFETCH);
    const { consumerTag } = await channel.consume(
      queue,
      (message) => {
        if (!message) {
          // The broker cancelled this consumer (e.g. the queue was deleted): listen again
          this.logger.warn(
            `Listener "${name}" was cancelled by the broker; restarting it`,
          );
          listener.consumerTag = undefined;
          if (!this.draining) {
            this.serially(() => this.setUpListener(channel, listener)).catch(
              (error: Error) =>
                this.logger.error(
                  `Could not restart listener "${name}": ${error.message}`,
                ),
            );
          }
          return;
        }
        const running = this.handle(channel, listener, message);
        this.inFlight.add(running);
        void running.finally(() => this.inFlight.delete(running));
      },
      { noAck: false },
    );
    listener.consumerTag = consumerTag;
    listener.channel = channel;
  }

  private async handle(
    channel: amqp.ConfirmChannel,
    listener: Listener,
    message: amqp.ConsumeMessage,
  ): Promise<void> {
    const { name } = listener.subscription;
    const event = fromMessageBody(message.content.toString());
    if (!event) {
      this.logger.error(
        `Listener "${name}": a message that is not an event was moved to the dead-letter queue`,
      );
      this.settle(() => channel.nack(message, false, false));
      return;
    }

    try {
      await listener.handler(event);
    } catch (error) {
      // Only the id and the name are logged: the data belongs to the event, not to the log
      this.logger.error(
        `Listener "${name}" failed on event ${event.id} (${event.name}); moved to the dead-letter queue: ${(error as Error).message}`,
      );
      this.settle(() => channel.nack(message, false, false));
      return;
    }
    this.settle(() => channel.ack(message));
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.setUpChain.then(work, work);
    this.setUpChain = run.catch(() => undefined);
    return run;
  }

  /** Ack or nack on a channel that may have closed meanwhile; the broker redelivers anyway. */
  private settle(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logger.warn(
        `Could not acknowledge an event (${(error as Error).message}); the broker will redeliver it`,
      );
    }
  }
}
