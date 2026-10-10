import { vi, describe, it, expect } from 'vitest';
import {
  ReleaseReservationJobHandler,
  createReleaseReservationJob,
} from './release-reservation.job.js';
import { ReleaseExpiredReservationCommand } from '../commands/release-expired-reservation.command.js';

describe('release-reservation job (AC-1, AC-14)', () => {
  it('is held back for exactly the hold time before it first runs', () => {
    const job = createReleaseReservationJob(900);

    expect(job.name).toBe('release-reservation');
    expect(job.delayMs).toBe(900_000);
  });

  it('follows the configured hold time', () => {
    expect(createReleaseReservationJob(60).delayMs).toBe(60_000);
    expect(createReleaseReservationJob(7 * 24 * 3600).delayMs).toBe(
      604_800_000,
    );
  });

  it('retries a failed run with growing waits, then lets the sweep catch it', () => {
    expect(createReleaseReservationJob(900).retryDelaysMs).toEqual([
      10_000, 30_000, 90_000,
    ]);
  });

  it('registers its handler with the queue when the module starts', () => {
    const jobs = { register: vi.fn() };
    const job = createReleaseReservationJob(900);

    new ReleaseReservationJobHandler(jobs as any, job, {
      execute: vi.fn(),
    } as any).onModuleInit();

    expect(jobs.register).toHaveBeenCalledWith(job, expect.any(Function));
  });

  it('turns a job into a release that only acts on an expired hold', async () => {
    const commandBus = { execute: vi.fn().mockResolvedValue(undefined) };
    const handler = new ReleaseReservationJobHandler(
      { register: vi.fn() } as any,
      createReleaseReservationJob(900),
      commandBus as any,
    );

    await handler.handle({ orderId: 'O1' });

    expect(commandBus.execute).toHaveBeenCalledWith(
      new ReleaseExpiredReservationCommand('O1'),
    );
  });

  it('lets a failure reach the queue, which retries the job', async () => {
    const handler = new ReleaseReservationJobHandler(
      { register: vi.fn() } as any,
      createReleaseReservationJob(900),
      { execute: vi.fn().mockRejectedValue(new Error('db down')) } as any,
    );

    await expect(handler.handle({ orderId: 'O1' })).rejects.toThrow('db down');
  });
});
