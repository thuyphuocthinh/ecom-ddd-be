import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as amqp from 'amqplib';

/** Runs every time a connection and channel are (re)established. Rejecting restarts the connection. */
export type ConnectedHook = (channel: amqp.ConfirmChannel) => Promise<void>;

const MAX_BACKOFF_MS = 30_000;
const PUBLISH_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * The connection to RabbitMQ and nothing else: connect in the background, reconnect with
 * exponential backoff (1 s, 2 s, 4 s ... 30 s), and publish with the broker's confirmation.
 *
 * It does not block the application from starting while the broker is away, and `publish`
 * fails at once (503) instead of hanging when there is no connection. What to publish and
 * consume belongs to the layers above (see `RabbitMqJobQueue`); they use `onConnected`
 * to set themselves up again after every reconnect, because a new connection starts with
 * no queues bound and no consumers.
 */
@Injectable()
export class RabbitMQService implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.ConfirmChannel | null = null;
  private readonly hooks: ConnectedHook[] = [];
  private started = false;
  private connecting = false;
  private shuttingDown = false;
  private cancelWait: (() => void) | null = null;

  /** Starts connecting in the background. Safe to call more than once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connectLoop();
  }

  /** Registers a hook for every (re)connection; runs it now when already connected. */
  onConnected(hook: ConnectedHook): void {
    this.hooks.push(hook);
    const channel = this.channel;
    if (channel) {
      hook(channel).catch((error: Error) => {
        this.logger.error(`RabbitMQ setup hook failed: ${error.message}`);
        this.restart();
      });
    }
  }

  /** The live channel, or null while disconnected. */
  getChannel(): amqp.ConfirmChannel | null {
    return this.channel;
  }

  isConnected(): boolean {
    return this.channel !== null;
  }

  /**
   * Publishes (on `onChannel`, by default the live one) and waits for the broker to confirm it stored the message. Rejects with a
   * 503 when there is no connection, the broker refuses, or no confirmation arrives in time.
   */
  async publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: amqp.Options.Publish = {},
    onChannel: amqp.ConfirmChannel | null = this.channel,
  ): Promise<void> {
    const channel = onChannel;
    if (!channel) {
      throw new ServiceUnavailableException('Message broker is unavailable');
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          channel.publish(
            exchange,
            routingKey,
            content,
            { persistent: true, ...options },
            (error) => (error ? reject(error) : resolve()),
          );
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('publish confirmation timed out')),
            PUBLISH_CONFIRM_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.logger.error(
        `Publish to "${routingKey}" failed: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException('Message broker is unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.cancelWait?.();
    const { channel, connection } = this;
    this.channel = null;
    this.connection = null;
    try {
      await channel?.close();
      await connection?.close();
    } catch {
      // Already closed: nothing left to release
    }
  }

  private async connectLoop(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    let attempt = 0;

    while (!this.shuttingDown) {
      try {
        const url =
          process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';
        const connection = await amqp.connect(url);
        if (this.shuttingDown) {
          await connection.close().catch(() => undefined);
          break;
        }
        // 'error' is always followed by 'close'; reconnecting happens there
        connection.on('error', (error: Error) =>
          this.logger.error(`RabbitMQ connection error: ${error.message}`),
        );
        connection.on('close', () => this.handleClosed(connection));

        const channel = await connection.createConfirmChannel();
        // A channel error (e.g. declaring a queue with different arguments) closes only the
        // channel; start over with a clean connection rather than carry on without one
        channel.on('error', (error: Error) =>
          this.logger.error(`RabbitMQ channel error: ${error.message}`),
        );
        channel.on('close', () => {
          if (this.channel === channel) {
            this.channel = null;
            connection.close().catch(() => undefined);
          }
        });

        try {
          for (const hook of this.hooks) await hook(channel);
        } catch (error) {
          await connection.close().catch(() => undefined);
          throw error;
        }

        if (this.shuttingDown) {
          await connection.close().catch(() => undefined);
          break;
        }
        this.connection = connection;
        this.channel = channel;
        this.logger.log('Connected to RabbitMQ');
        this.connecting = false;
        return;
      } catch (error) {
        const delay = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
        this.logger.warn(
          `RabbitMQ not ready (${(error as Error).message}); retrying in ${delay / 1000}s`,
        );
        attempt += 1;
        await this.wait(delay);
      }
    }
    this.connecting = false;
  }

  private handleClosed(connection: amqp.ChannelModel): void {
    if (this.connection !== connection) return;
    this.connection = null;
    this.channel = null;
    if (this.shuttingDown) return;
    this.logger.warn('RabbitMQ connection closed; reconnecting');
    void this.connectLoop();
  }

  private restart(): void {
    const connection = this.connection;
    if (connection) connection.close().catch(() => undefined);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.cancelWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
