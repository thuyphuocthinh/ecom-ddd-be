import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import * as amqp from 'amqplib';
import { RabbitMQService } from './rabbitmq.service.js';

vi.mock('amqplib', () => ({ connect: vi.fn() }));

class FakeChannel extends EventEmitter {
  // Confirms by default; a test can change what the broker answers
  confirm: (cb: (error: Error | null) => void) => void = (cb) => cb(null);
  published: any[] = [];
  close = vi.fn(async () => undefined);
  publish = vi.fn(
    (
      exchange: string,
      key: string,
      content: Buffer,
      options: any,
      cb: (error: Error | null) => void,
    ) => {
      this.published.push({ exchange, key, content, options });
      this.confirm(cb);
      return true;
    },
  );
}

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  close = vi.fn(async () => {
    this.emit('close');
  });
  createConfirmChannel = vi.fn(async () => this.channel);
}

const connectMock = vi.mocked(amqp.connect) as unknown as ReturnType<
  typeof vi.fn
>;

/** Let pending promise callbacks run (without moving fake timers) */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('RabbitMQService', () => {
  let service: RabbitMQService;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    connectMock.mockReset();
    service = new RabbitMQService();
  });
  afterEach(async () => {
    await service.onApplicationShutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('connecting', () => {
    it('does not block the caller while the broker is away: start returns at once (AC-8)', async () => {
      connectMock.mockRejectedValue(new Error('ECONNREFUSED'));

      service.start();
      await flush();

      expect(service.isConnected()).toBe(false);
    });

    it('retries with a growing pause (1 s, 2 s, 4 s) until the broker answers (AC-8)', async () => {
      const connection = new FakeConnection();
      connectMock
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(connection);

      service.start();
      await flush();
      expect(connectMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(connectMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(connectMock).toHaveBeenCalledTimes(4);

      expect(service.isConnected()).toBe(true);
    });

    it('caps the pause at 30 seconds', async () => {
      connectMock.mockRejectedValue(new Error('down'));

      service.start();
      // 1 + 2 + 4 + 8 + 16 = 31 s of pauses, then every further pause is 30 s
      await vi.advanceTimersByTimeAsync(31_000);
      const callsBefore = connectMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(29_000);
      expect(connectMock.mock.calls.length).toBe(callsBefore);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectMock.mock.calls.length).toBe(callsBefore + 1);
    });

    it('starts only one connection loop however often start is called', async () => {
      connectMock.mockResolvedValue(new FakeConnection());

      service.start();
      service.start();
      await flush();

      expect(connectMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('hooks (AC-8)', () => {
    it('runs a hook registered before connecting, with the new channel', async () => {
      const connection = new FakeConnection();
      connectMock.mockResolvedValue(connection);
      const hook = vi.fn().mockResolvedValue(undefined);
      service.onConnected(hook);

      service.start();
      await flush();

      expect(hook).toHaveBeenCalledWith(connection.channel);
    });

    it('runs a hook registered after connecting straight away', async () => {
      connectMock.mockResolvedValue(new FakeConnection());
      service.start();
      await flush();
      const hook = vi.fn().mockResolvedValue(undefined);

      service.onConnected(hook);

      expect(hook).toHaveBeenCalledOnce();
    });

    it('reconnects when the connection drops and runs the hook again on the new channel', async () => {
      const first = new FakeConnection();
      const second = new FakeConnection();
      connectMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const hook = vi.fn().mockResolvedValue(undefined);
      service.onConnected(hook);
      service.start();
      await flush();
      expect(hook).toHaveBeenCalledTimes(1);

      first.emit('close');
      await flush();
      await vi.advanceTimersByTimeAsync(0);
      await flush();

      expect(hook).toHaveBeenCalledTimes(2);
      expect(hook).toHaveBeenLastCalledWith(second.channel);
      expect(service.isConnected()).toBe(true);
    });

    it('drops the connection and tries again when a hook fails, rather than run half set up', async () => {
      const first = new FakeConnection();
      const second = new FakeConnection();
      connectMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const hook = vi
        .fn()
        .mockRejectedValueOnce(new Error('PRECONDITION_FAILED'))
        .mockResolvedValue(undefined);
      service.onConnected(hook);

      service.start();
      await flush();
      expect(service.isConnected()).toBe(false);
      expect(first.close).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(hook).toHaveBeenCalledTimes(2);
      expect(service.isConnected()).toBe(true);
    });
  });

  describe('publish', () => {
    it('answers 503 at once when there is no connection (AC-7)', async () => {
      await expect(
        service.publish('jobs', 'send-email', Buffer.from('x')),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('waits for the broker to confirm, and publishes persistent messages (AC-1)', async () => {
      const connection = new FakeConnection();
      connectMock.mockResolvedValue(connection);
      service.start();
      await flush();

      await service.publish('jobs', 'send-email', Buffer.from('x'), {
        headers: { 'x-attempt': 0 },
      });

      const sent = connection.channel.published[0];
      expect(sent.exchange).toBe('jobs');
      expect(sent.key).toBe('send-email');
      expect(sent.options).toEqual({
        persistent: true,
        headers: { 'x-attempt': 0 },
      });
    });

    it('does not return before the confirmation arrives', async () => {
      const connection = new FakeConnection();
      let confirm!: () => void;
      connection.channel.confirm = (cb) => {
        confirm = () => cb(null);
      };
      connectMock.mockResolvedValue(connection);
      service.start();
      await flush();

      let done = false;
      const publishing = service
        .publish('jobs', 'k', Buffer.from('x'))
        .then(() => (done = true));
      await flush();
      expect(done).toBe(false);

      confirm();
      await publishing;
      expect(done).toBe(true);
    });

    it('answers 503 when the broker refuses the message (AC-7)', async () => {
      const connection = new FakeConnection();
      connection.channel.confirm = (cb) => cb(new Error('nack'));
      connectMock.mockResolvedValue(connection);
      service.start();
      await flush();

      await expect(
        service.publish('jobs', 'k', Buffer.from('x')),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('answers 503 instead of hanging when no confirmation ever comes (AC-7)', async () => {
      const connection = new FakeConnection();
      connection.channel.confirm = () => undefined;
      connectMock.mockResolvedValue(connection);
      service.start();
      await flush();

      const publishing = service.publish('jobs', 'k', Buffer.from('x'));
      const outcome = expect(publishing).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await outcome;
    });
  });

  describe('shutting down', () => {
    it('closes the channel and the connection and stops reconnecting (AC-10)', async () => {
      const connection = new FakeConnection();
      connectMock.mockResolvedValue(connection);
      service.start();
      await flush();

      await service.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(connection.channel.close).toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
      expect(connectMock).toHaveBeenCalledTimes(1);
      expect(service.isConnected()).toBe(false);
    });

    it('stops waiting to reconnect when the application shuts down', async () => {
      connectMock.mockRejectedValue(new Error('down'));
      service.start();
      await flush();

      await service.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(connectMock).toHaveBeenCalledTimes(1);
    });
  });
});
