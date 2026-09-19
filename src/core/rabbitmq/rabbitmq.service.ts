import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import * as amqp from 'amqplib';

export interface TopologyConfig {
  exchange: string;
  exchangeType?: 'direct' | 'topic' | 'fanout' | 'headers';
  queue: string;
  routingKey: string;
  dlx?: string;
  dlq?: string;
}

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  private isConnecting = false;
  private isShuttingDown = false;
  private readonly MAX_RETRIES = 3;

  async onModuleInit() {
    await this.connectWithRetry();
  }

  private async connectWithRetry(retryCount = 0): Promise<void> {
    if (this.isShuttingDown || this.isConnecting) return;
    this.isConnecting = true;

    try {
      const url =
        process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';
      this.connection = await amqp.connect(url);

      this.connection.on('error', (err: unknown) => {
        const error = err as Error;
        this.logger.error(`RabbitMQ Connection Error: ${error.message}`);
        this.connection = null;
        this.connectWithRetry();
      });

      this.connection.on('close', () => {
        if (!this.isShuttingDown) {
          this.logger.warn('RabbitMQ Connection Closed. Reconnecting...');
          this.connection = null;
          this.connectWithRetry();
        }
      });

      this.channel = await this.connection.createConfirmChannel();
      this.logger.log('Connected to RabbitMQ and created ConfirmChannel');
      this.isConnecting = false;
    } catch (err: unknown) {
      const error = err as Error;
      this.isConnecting = false;
      this.logger.error(
        `Failed to connect to RabbitMQ (Retry ${retryCount}): ${error.message}`,
      );

      // Exponential backoff
      const timeout = Math.min(Math.pow(2, retryCount) * 1000, 30000);
      await new Promise((res) => setTimeout(res, timeout));
      return this.connectWithRetry(retryCount + 1);
    }
  }

  getChannel(): amqp.ConfirmChannel {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not initialized');
    }
    return this.channel;
  }

  async publish<T = unknown>(
    exchange: string,
    routingKey: string,
    message: T,
  ): Promise<boolean> {
    const channel = this.getChannel();
    const content = Buffer.from(JSON.stringify(message));

    return new Promise((resolve, reject) => {
      channel.publish(
        exchange,
        routingKey,
        content,
        { persistent: true },
        (err) => {
          if (err) {
            this.logger.error(
              `Publish failed for routingKey ${routingKey}`,
              err,
            );
            return reject(err);
          }
          resolve(true);
        },
      );
    });
  }

  async assertTopology(config: TopologyConfig): Promise<void> {
    const channel = this.getChannel();
    const exType = config.exchangeType || 'direct';
    const dlx = config.dlx || `${config.exchange}.dlx`;
    const dlq = config.dlq || `${config.queue}.dlq`;

    // 1. Setup DLX & DLQ
    await channel.assertExchange(dlx, 'direct', { durable: true });
    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, dlx, config.routingKey);

    // 2. Setup Main Exchange & Queue with DLX configuration
    await channel.assertExchange(config.exchange, exType, { durable: true });
    await channel.assertQueue(config.queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': dlx,
        'x-dead-letter-routing-key': config.routingKey,
      },
    });
    await channel.bindQueue(config.queue, config.exchange, config.routingKey);

    this.logger.log(`Topology asserted for Queue: ${config.queue}`);
  }

  async consume<T>(
    queue: string,
    handler: (message: T) => Promise<void>,
  ): Promise<void> {
    const channel = this.getChannel();
    await channel.prefetch(1); // Process one by one for safe retry

    await channel.consume(
      queue,
      async (msg) => {
        if (!msg) return;

        const content = msg.content.toString();
        let parsed: T;

        try {
          parsed = JSON.parse(content);
        } catch {
          this.logger.error(`Unparseable message format in queue ${queue}`);
          channel.nack(msg, false, false); // Send to DLQ immediately
          return;
        }

        let attempt = 0;

        while (attempt <= this.MAX_RETRIES) {
          try {
            await handler(parsed);
            channel.ack(msg);
            return; // Success, exit loop
          } catch (err: unknown) {
            attempt++;
            const error = err as Error;
            this.logger.warn(
              `Processing failed for queue ${queue}. Attempt: ${attempt}. Error: ${error.message}`,
            );

            if (attempt > this.MAX_RETRIES) {
              this.logger.error(
                `Max retries reached (${this.MAX_RETRIES}). Sending to DLQ. Queue: ${queue}`,
              );
              channel.nack(msg, false, false); // Nack with requeue=false -> routes to DLQ
              return;
            } else {
              // Wait exponentially before retry: 1s, 2s, 4s...
              const delay = Math.pow(2, attempt - 1) * 1000;
              await new Promise((res) => setTimeout(res, delay));
            }
          }
        }
      },
      { noAck: false },
    );
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;
    if (this.channel) {
      await this.channel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }
  }
}
