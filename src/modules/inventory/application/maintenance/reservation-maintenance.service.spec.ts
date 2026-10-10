import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { CoreErrorCodes, DomainException } from '@/core/index.js';
import type { InventoryConfig } from '../../inventory.config.js';
import { ReleaseExpiredReservationsCommand } from '../commands/release-expired-reservations.command.js';
import { RepairInFlightHoldsCommand } from '../commands/repair-in-flight-holds.command.js';
import { ReservationMaintenance } from './reservation-maintenance.service.js';

const config = (maintenanceIntervalSeconds: number) =>
  ({
    reservationTtlSeconds: 900,
    maintenanceIntervalSeconds,
    inflightGraceSeconds: 120,
  }) as InventoryConfig;

describe('ReservationMaintenance (AC-15, AC-21)', () => {
  let commandBus: { execute: ReturnType<typeof vi.fn> };
  let locks: { run: ReturnType<typeof vi.fn> };
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message: any) => {
      logged.push(String(message));
    });
    commandBus = { execute: vi.fn().mockResolvedValue(undefined) };
    locks = {
      run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const make = (seconds: number) =>
    new ReservationMaintenance(
      commandBus as any,
      locks as any,
      config(seconds),
    );

  describe('one round', () => {
    it('releases the expired holds, then repairs the half-done ones', async () => {
      await make(60).runOnce();

      expect(commandBus.execute.mock.calls.map(([c]) => c)).toEqual([
        new ReleaseExpiredReservationsCommand(),
        new RepairInFlightHoldsCommand(),
      ]);
    });

    it('runs under a lock it does not wait for, so only one instance works at a time', async () => {
      await make(60).runOnce();

      const [name, , options] = locks.run.mock.calls[0];
      expect(name).toBe('inventory:maintenance');
      expect(options.waitMs).toBe(0);
    });

    it('skips the round quietly when another instance holds the lock', async () => {
      locks.run.mockRejectedValue(
        new DomainException(CoreErrorCodes.RESOURCE_BUSY),
      );

      await expect(make(60).runOnce()).resolves.toBeUndefined();

      expect(commandBus.execute).not.toHaveBeenCalled();
      expect(logged).toEqual([]);
    });

    it('logs any other failure and never throws, so the timer keeps going', async () => {
      locks.run.mockRejectedValue(new Error('redis down'));

      await expect(make(60).runOnce()).resolves.toBeUndefined();

      expect(logged.join('\n')).toContain('redis down');
    });
  });

  describe('the timer', () => {
    it('runs a round every interval after the application started', () => {
      vi.useFakeTimers();
      const maintenance = make(60);

      maintenance.onApplicationBootstrap();
      expect(locks.run).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(locks.run).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(locks.run).toHaveBeenCalledTimes(2);

      maintenance.onModuleDestroy();
    });

    it('does not keep the process alive and stops when the module is destroyed', () => {
      vi.useFakeTimers();
      const unref = vi.fn();
      const realSetInterval = globalThis.setInterval;
      vi.spyOn(globalThis, 'setInterval').mockImplementation(((
        ...args: Parameters<typeof setInterval>
      ) => {
        const timer = realSetInterval(...args);
        timer.unref = unref;
        return timer;
      }) as typeof setInterval);
      const maintenance = make(60);

      maintenance.onApplicationBootstrap();
      expect(unref).toHaveBeenCalledOnce();

      maintenance.onModuleDestroy();
      vi.advanceTimersByTime(120_000);
      expect(locks.run).not.toHaveBeenCalled();
    });

    it('is switched off by an interval of 0 (tests call runOnce themselves)', () => {
      vi.useFakeTimers();
      const maintenance = make(0);

      maintenance.onApplicationBootstrap();
      vi.advanceTimersByTime(3_600_000);

      expect(locks.run).not.toHaveBeenCalled();
    });
  });
});
