import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { InventoryErrorCodes } from '@/core/index.js';
import { ReservationReleaser } from '../services/reservation-releaser.service.js';
import { ConfirmReservationCommand } from './confirm-reservation.command.js';
import { ConfirmReservationHandler } from './confirm-reservation.handler.js';
import { ReleaseReservationCommand } from './release-reservation.command.js';
import { ReleaseReservationHandler } from './release-reservation.handler.js';
import { ReleaseExpiredReservationCommand } from './release-expired-reservation.command.js';
import { ReleaseExpiredReservationHandler } from './release-expired-reservation.handler.js';

describe('ConfirmReservationHandler (AC-11)', () => {
  let reservationRepo: any;
  let handler: ConfirmReservationHandler;

  beforeEach(() => {
    reservationRepo = { confirm: vi.fn() };
    handler = new ConfirmReservationHandler(reservationRepo);
  });

  const confirm = () => handler.execute(new ConfirmReservationCommand('O1'));

  it.each(['CONFIRMED', 'ALREADY_CONFIRMED'])(
    'succeeds when the order is %s, so confirming twice is fine',
    async (outcome) => {
      reservationRepo.confirm.mockResolvedValue(outcome);

      await expect(confirm()).resolves.toBeUndefined();
      expect(reservationRepo.confirm).toHaveBeenCalledWith('O1');
    },
  );

  it('refuses an order whose units were already given back (INV-006)', async () => {
    reservationRepo.confirm.mockResolvedValue('RELEASED');

    await expect(confirm()).rejects.toMatchObject({
      code: InventoryErrorCodes.RESERVATION_RELEASED.code,
    });
  });

  it('refuses an order that holds nothing (INV-003)', async () => {
    reservationRepo.confirm.mockResolvedValue('NOT_FOUND');

    await expect(confirm()).rejects.toMatchObject({
      code: InventoryErrorCodes.RESERVATION_NOT_FOUND.code,
    });
  });
});

describe('ReservationReleaser (AC-12, AC-19)', () => {
  let reservationRepo: any;
  let store: any;
  let releaser: ReservationReleaser;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message: any) => {
      logged.push(String(message));
    });
    reservationRepo = { release: vi.fn() };
    store = { giveBack: vi.fn().mockResolvedValue(undefined) };
    releaser = new ReservationReleaser(reservationRepo, store);
  });

  it('adds the released units back in Redis, after Postgres changed the status', async () => {
    const lines = [
      { skuId: 'A', qty: 2 },
      { skuId: 'B', qty: 1 },
    ];
    reservationRepo.release.mockResolvedValue(lines);

    const released = await releaser.release('O1', { onlyIfExpired: false });

    expect(released).toBe(true);
    expect(reservationRepo.release).toHaveBeenCalledWith('O1', {
      onlyIfExpired: false,
    });
    expect(store.giveBack).toHaveBeenCalledWith(lines);
  });

  it('adds nothing back when Postgres had nothing to release, so a repeat cannot count twice', async () => {
    reservationRepo.release.mockResolvedValue([]);

    const released = await releaser.release('O1', { onlyIfExpired: true });

    expect(released).toBe(false);
    expect(store.giveBack).not.toHaveBeenCalled();
  });

  it('does not fail when Redis cannot take the units back, and says which SKUs to rebuild', async () => {
    reservationRepo.release.mockResolvedValue([{ skuId: 'A', qty: 2 }]);
    store.giveBack.mockRejectedValue(new Error('redis down'));

    await expect(
      releaser.release('O1', { onlyIfExpired: false }),
    ).resolves.toBe(true);

    expect(logged.join('\n')).toContain('rebuild: A');
  });
});

describe('ReleaseReservationHandler and ReleaseExpiredReservationHandler', () => {
  let releaser: { release: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    releaser = { release: vi.fn().mockResolvedValue(true) };
  });

  it('a cancellation gives the units back whatever the expiry says', async () => {
    await new ReleaseReservationHandler(
      releaser as unknown as ReservationReleaser,
    ).execute(new ReleaseReservationCommand('O1'));

    expect(releaser.release).toHaveBeenCalledWith('O1', {
      onlyIfExpired: false,
    });
  });

  it('a timer only gives the units back once the hold has really expired (AC-14)', async () => {
    await new ReleaseExpiredReservationHandler(
      releaser as unknown as ReservationReleaser,
    ).execute(new ReleaseExpiredReservationCommand('O1'));

    expect(releaser.release).toHaveBeenCalledWith('O1', {
      onlyIfExpired: true,
    });
  });

  it('an order that holds nothing is not an error', async () => {
    releaser.release.mockResolvedValue(false);

    await expect(
      new ReleaseReservationHandler(
        releaser as unknown as ReservationReleaser,
      ).execute(new ReleaseReservationCommand('nope')),
    ).resolves.toBeUndefined();
  });
});
