import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CommandBus } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import {
  CoreErrorCodes,
  DomainException,
  type LockService,
} from '@/core/index.js';
import {
  FinishPaidPaymentsCommand,
  ReconcilePendingPaymentsCommand,
  RefundPendingPaymentsCommand,
  ReopenStuckOrdersCommand,
} from '../commands/sweep-commands.js';
import { PaymentMaintenance } from './payment-maintenance.service.js';

describe('PaymentMaintenance', () => {
  let executed: string[];
  let bus: { execute: ReturnType<typeof vi.fn> };
  let locks: { run: ReturnType<typeof vi.fn> };
  let lockOptions: unknown;
  const build = (maintenanceIntervalSeconds = 0) =>
    new PaymentMaintenance(
      bus as unknown as CommandBus,
      locks as unknown as LockService,
      { maintenanceIntervalSeconds } as never,
    );

  beforeEach(() => {
    executed = [];
    lockOptions = undefined;
    bus = {
      execute: vi.fn(async (command: object) => {
        executed.push(command.constructor.name);
        return 0;
      }),
    };
    locks = {
      run: vi.fn(
        async (
          _name: string,
          work: () => Promise<unknown>,
          options: unknown,
        ) => {
          lockOptions = options;
          return work();
        },
      ),
    };
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the four sweeps in this order: ask the gateway, finish paid, refund, open stuck orders', async () => {
    await build().runOnce();

    expect(executed).toEqual([
      ReconcilePendingPaymentsCommand.name,
      FinishPaidPaymentsCommand.name,
      RefundPendingPaymentsCommand.name,
      ReopenStuckOrdersCommand.name,
    ]);
  });

  it('works under one lock that it does not wait for', async () => {
    await build().runOnce();

    expect(locks.run).toHaveBeenCalledWith(
      'payment:maintenance',
      expect.any(Function),
      expect.anything(),
    );
    expect(lockOptions).toMatchObject({ waitMs: 0 });
  });

  it('skips the round, quietly, when another copy of the server holds the lock', async () => {
    locks.run.mockRejectedValueOnce(
      new DomainException(CoreErrorCodes.RESOURCE_BUSY),
    );

    await expect(build().runOnce()).resolves.toBeUndefined();

    expect(bus.execute).not.toHaveBeenCalled();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('logs and survives any other failure of the lock (for example Redis down)', async () => {
    locks.run.mockRejectedValueOnce(new Error('Redis down'));

    await expect(build().runOnce()).resolves.toBeUndefined();

    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('Redis down'),
    );
  });

  it('a sweep that fails does not stop the next ones', async () => {
    bus.execute.mockImplementationOnce(async () => {
      throw new Error('first sweep broke');
    });

    await expect(build().runOnce()).resolves.toBeUndefined();

    expect(bus.execute).toHaveBeenCalledTimes(4);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('first sweep broke'),
    );
  });

  it('runs on a timer when the interval is set, and stops when the module is destroyed', async () => {
    vi.useFakeTimers();
    const maintenance = build(60);

    maintenance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(locks.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(locks.run).toHaveBeenCalledTimes(2);

    maintenance.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(locks.run).toHaveBeenCalledTimes(2);
  });

  it('does not start a timer when the interval is 0 (tests and one-off runs)', async () => {
    vi.useFakeTimers();
    const maintenance = build(0);

    maintenance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(locks.run).not.toHaveBeenCalled();
    maintenance.onModuleDestroy();
  });
});
