import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { InventoryConfig } from '../../inventory.config.js';
import { ReservationReleaser } from '../services/reservation-releaser.service.js';
import { ReleaseExpiredReservationsHandler } from './release-expired-reservations.handler.js';
import { RepairInFlightHoldsHandler } from './repair-in-flight-holds.handler.js';

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('ReleaseExpiredReservationsHandler (AC-15)', () => {
  let reservationRepo: any;
  let releaser: { release: ReturnType<typeof vi.fn> };
  let handler: ReleaseExpiredReservationsHandler;

  beforeEach(() => {
    reservationRepo = { findExpiredOrderIds: vi.fn() };
    releaser = { release: vi.fn().mockResolvedValue(true) };
    handler = new ReleaseExpiredReservationsHandler(
      reservationRepo,
      releaser as unknown as ReservationReleaser,
    );
  });

  it('releases every expired order, only if it is really expired, and counts them', async () => {
    reservationRepo.findExpiredOrderIds.mockResolvedValue(['O1', 'O2']);

    const released = await handler.execute();

    expect(released).toBe(2);
    expect(releaser.release).toHaveBeenCalledWith('O1', {
      onlyIfExpired: true,
    });
    expect(releaser.release).toHaveBeenCalledWith('O2', {
      onlyIfExpired: true,
    });
  });

  it('does nothing, and asks only once, when nothing has expired', async () => {
    reservationRepo.findExpiredOrderIds.mockResolvedValue([]);

    await expect(handler.execute()).resolves.toBe(0);

    expect(releaser.release).not.toHaveBeenCalled();
    expect(reservationRepo.findExpiredOrderIds).toHaveBeenCalledTimes(1);
  });

  it('does not count an order that someone else released first', async () => {
    reservationRepo.findExpiredOrderIds.mockResolvedValue(['O1', 'O2']);
    releaser.release.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(handler.execute()).resolves.toBe(1);
  });

  it('carries on with the other orders when one fails', async () => {
    reservationRepo.findExpiredOrderIds.mockResolvedValue(['O1', 'O2']);
    releaser.release
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(true);

    await expect(handler.execute()).resolves.toBe(1);
    expect(releaser.release).toHaveBeenCalledTimes(2);
  });

  it('works through a full batch and asks again, but never loops for ever', async () => {
    const full = Array.from({ length: 100 }, (_, i) => `O${i}`);
    reservationRepo.findExpiredOrderIds.mockResolvedValue(full);

    await handler.execute();

    // A batch that is always full (an order that keeps failing) stops after 10 rounds
    expect(reservationRepo.findExpiredOrderIds).toHaveBeenCalledTimes(10);
  });
});

describe('RepairInFlightHoldsHandler (AC-21)', () => {
  const CONFIG = {
    reservationTtlSeconds: 900,
    maintenanceIntervalSeconds: 0,
    inflightGraceSeconds: 120,
  } as InventoryConfig;
  let reservationRepo: any;
  let store: any;
  let handler: RepairInFlightHoldsHandler;
  const ITEMS = [{ skuId: 'A', qty: 2 }];

  beforeEach(() => {
    reservationRepo = { existsForOrder: vi.fn() };
    store = {
      listStaleInflight: vi.fn().mockResolvedValue(['O1']),
      readInflight: vi.fn().mockResolvedValue(ITEMS),
      undoHold: vi.fn().mockResolvedValue(true),
      finishHold: vi.fn().mockResolvedValue(undefined),
    };
    handler = new RepairInFlightHoldsHandler(reservationRepo, store, CONFIG);
  });

  it('looks only for records older than the grace period (in milliseconds)', async () => {
    await handler.execute();

    expect(store.listStaleInflight).toHaveBeenCalledWith(120_000, 100);
  });

  it('gives the units back when Postgres has no reservation: the process died before saving', async () => {
    reservationRepo.existsForOrder.mockResolvedValue(false);

    const result = await handler.execute();

    expect(store.undoHold).toHaveBeenCalledWith('O1', ITEMS);
    expect(store.finishHold).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: 0, returned: 1 });
  });

  it('only clears the record when Postgres already has the reservation: the process died after saving', async () => {
    reservationRepo.existsForOrder.mockResolvedValue(true);

    const result = await handler.execute();

    expect(store.finishHold).toHaveBeenCalledWith('O1');
    expect(store.undoHold).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: 1, returned: 0 });
  });

  it('cleans the index entry when the record itself is already gone', async () => {
    reservationRepo.existsForOrder.mockResolvedValue(false);
    store.readInflight.mockResolvedValue(null);

    const result = await handler.execute();

    expect(store.finishHold).toHaveBeenCalledWith('O1');
    expect(store.undoHold).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: 1, returned: 0 });
  });

  it('counts nothing returned when another repair undid it first', async () => {
    reservationRepo.existsForOrder.mockResolvedValue(false);
    store.undoHold.mockResolvedValue(false);

    await expect(handler.execute()).resolves.toEqual({
      cleared: 0,
      returned: 0,
    });
  });

  it('carries on with the other orders when one fails', async () => {
    store.listStaleInflight.mockResolvedValue(['O1', 'O2']);
    reservationRepo.existsForOrder
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(false);

    const result = await handler.execute();

    expect(result).toEqual({ cleared: 0, returned: 1 });
  });

  it('does nothing when there is nothing stale', async () => {
    store.listStaleInflight.mockResolvedValue([]);

    await expect(handler.execute()).resolves.toEqual({
      cleared: 0,
      returned: 0,
    });
    expect(reservationRepo.existsForOrder).not.toHaveBeenCalled();
  });
});
