import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InventoryErrorCodes } from '@/core/index.js';
import { ExtendReservationCommand } from './extend-reservation.command.js';
import {
  ExtendReservationHandler,
  MAX_EXTENSION_SECONDS,
} from './extend-reservation.handler.js';

describe('ExtendReservationHandler (AC-27)', () => {
  let reservationRepo: any;
  let handler: ExtendReservationHandler;

  beforeEach(() => {
    reservationRepo = { extend: vi.fn() };
    handler = new ExtendReservationHandler(reservationRepo);
  });

  const extend = (orderId = 'O1', seconds = 900) =>
    handler.execute(new ExtendReservationCommand(orderId, seconds));

  it('asks for the hold to last that many seconds more, and returns the new expiry', async () => {
    const expiresAt = new Date('2026-10-12T10:15:00.000Z');
    reservationRepo.extend.mockResolvedValue({ kind: 'EXTENDED', expiresAt });

    await expect(extend('O1', 900)).resolves.toEqual({
      orderId: 'O1',
      expiresAt,
    });
    expect(reservationRepo.extend).toHaveBeenCalledWith('O1', 900);
  });

  it('refuses a hold that is returned, paid, or past its expiry (INV-009, 409)', async () => {
    reservationRepo.extend.mockResolvedValue({ kind: 'NOT_EXTENDABLE' });

    await expect(extend()).rejects.toMatchObject({
      code: InventoryErrorCodes.EXTEND_NOT_ALLOWED.code,
      status: 409,
    });
  });

  it('refuses an order that holds nothing (INV-003, 404)', async () => {
    reservationRepo.extend.mockResolvedValue({ kind: 'NOT_FOUND' });

    await expect(extend()).rejects.toMatchObject({
      code: InventoryErrorCodes.RESERVATION_NOT_FOUND.code,
      status: 404,
    });
  });

  it.each([
    ['no seconds', 0],
    ['a negative number', -5],
    ['a fraction', 1.5],
    ['not a number', Number.NaN],
    ['more than a week', MAX_EXTENSION_SECONDS + 1],
  ])(
    'refuses %s before touching the database (INV-002)',
    async (_, seconds) => {
      await expect(extend('O1', seconds)).rejects.toMatchObject({
        code: InventoryErrorCodes.INVALID_RESERVATION_REQUEST.code,
      });
      expect(reservationRepo.extend).not.toHaveBeenCalled();
    },
  );

  it('refuses an empty order id', async () => {
    await expect(extend('  ', 900)).rejects.toMatchObject({
      code: InventoryErrorCodes.INVALID_RESERVATION_REQUEST.code,
    });
    expect(reservationRepo.extend).not.toHaveBeenCalled();
  });

  it('accepts the longest extension, a week', async () => {
    reservationRepo.extend.mockResolvedValue({
      kind: 'EXTENDED',
      expiresAt: new Date(),
    });

    await expect(extend('O1', MAX_EXTENSION_SECONDS)).resolves.toBeDefined();
  });
});
