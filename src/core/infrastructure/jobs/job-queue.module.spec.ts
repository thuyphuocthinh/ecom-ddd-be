import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { JobQueueModule } from './job-queue.module.js';
import { createJobQueue } from './job-queue.factory.js';
import { InlineJobQueue } from './inline-job-queue.js';
import { RabbitMqJobQueue } from './rabbitmq-job-queue.js';
import { JOB_QUEUE } from './job-queue.port.js';
import { RabbitMQService } from '../rabbitmq/rabbitmq.service.js';

describe('createJobQueue', () => {
  const rabbit = {} as RabbitMQService;

  it('defaults to RabbitMQ', () => {
    expect(createJobQueue({}, rabbit, {})).toBeInstanceOf(RabbitMqJobQueue);
  });

  it.each([
    ['rabbitmq', RabbitMqJobQueue],
    ['inline', InlineJobQueue],
  ])('picks the adapter named by JOB_QUEUE=%s', (kind, adapter) => {
    expect(createJobQueue({ JOB_QUEUE: kind }, rabbit, {})).toBeInstanceOf(
      adapter,
    );
  });

  it('refuses an unknown value instead of silently picking one', () => {
    expect(() => createJobQueue({ JOB_QUEUE: 'kafka' }, rabbit, {})).toThrow(
      /Unknown JOB_QUEUE/,
    );
  });
});

describe('JobQueueModule', () => {
  const original = process.env.JOB_QUEUE;
  let start: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    start = vi.spyOn(RabbitMQService.prototype, 'start');
  });
  afterEach(() => {
    if (original === undefined) delete process.env.JOB_QUEUE;
    else process.env.JOB_QUEUE = original;
    vi.restoreAllMocks();
  });

  it('builds the inline queue and never opens a RabbitMQ connection (AC-9)', async () => {
    process.env.JOB_QUEUE = 'inline';

    const moduleRef = await Test.createTestingModule({
      imports: [JobQueueModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(JOB_QUEUE)).toBeInstanceOf(InlineJobQueue);
    expect(start).not.toHaveBeenCalled();
    expect(moduleRef.get(RabbitMQService).isConnected()).toBe(false);
    await moduleRef.close();
  });

  it('reads JOB_QUEUE when the module is built, not when the file is imported', async () => {
    process.env.JOB_QUEUE = 'inline';
    const first = await Test.createTestingModule({
      imports: [JobQueueModule],
    }).compile();
    expect(first.get(JOB_QUEUE)).toBeInstanceOf(InlineJobQueue);

    process.env.JOB_QUEUE = 'rabbitmq';
    const second = await Test.createTestingModule({
      imports: [JobQueueModule],
    }).compile();
    expect(second.get(JOB_QUEUE)).toBeInstanceOf(RabbitMqJobQueue);
    // Built but not initialised: nothing connected
    expect(start).not.toHaveBeenCalled();
  });
});
