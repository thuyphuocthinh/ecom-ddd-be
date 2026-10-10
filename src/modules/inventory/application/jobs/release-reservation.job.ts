import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  JOB_QUEUE,
  defineJob,
  type IJobQueue,
  type JobDefinition,
} from '@/core/index.js';
import { ReleaseExpiredReservationCommand } from '../commands/release-expired-reservation.command.js';

/** DI token for the job definition, built from the configured hold time. */
export const RELEASE_RESERVATION_JOB = 'RELEASE_RESERVATION_JOB';

/** What travels through the queue: only the order id (no personal data). */
export interface ReleaseReservationJobData {
  orderId: string;
}

/**
 * "Give the held units back": enqueued when stock is held, runs once the hold time has passed
 * (`delayMs`). If the order was paid or cancelled meanwhile, the release finds nothing to do.
 * Built from the configured hold time rather than a constant, since that time is a setting.
 */
export function createReleaseReservationJob(
  holdSeconds: number,
): JobDefinition<ReleaseReservationJobData> {
  return defineJob<ReleaseReservationJobData>({
    name: 'release-reservation',
    delayMs: holdSeconds * 1000,
    retryDelaysMs: [10_000, 30_000, 90_000],
    concurrency: 5,
  });
}

@Injectable()
export class ReleaseReservationJobHandler implements OnModuleInit {
  constructor(
    @Inject(JOB_QUEUE) private readonly jobs: IJobQueue,
    @Inject(RELEASE_RESERVATION_JOB)
    private readonly job: JobDefinition<ReleaseReservationJobData>,
    private readonly commandBus: CommandBus,
  ) {}

  onModuleInit(): void {
    this.jobs.register(this.job, (data) => this.handle(data));
  }

  async handle(data: ReleaseReservationJobData): Promise<void> {
    await this.commandBus.execute(
      new ReleaseExpiredReservationCommand(data.orderId),
    );
  }
}
