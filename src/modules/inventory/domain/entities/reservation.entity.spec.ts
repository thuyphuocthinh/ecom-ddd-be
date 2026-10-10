import { describe, it, expect } from 'vitest';
import { InventoryErrorCodes } from '@/core/index.js';
import { Reservation, ReservationStatus } from './reservation.entity.js';

const NOW = new Date('2026-10-10T10:00:00Z');

describe('Reservation', () => {
  describe('create', () => {
    it('makes a RESERVED reservation whose id is the order id and that expires one hold time later', () => {
      const reservation = Reservation.create(
        'O1',
        [{ skuId: 'A', qty: 2 }],
        NOW,
        900,
      );

      expect(reservation.id).toBe('O1');
      expect(reservation.orderId).toBe('O1');
      expect(reservation.status).toBe(ReservationStatus.RESERVED);
      expect(reservation.expiresAt).toEqual(new Date('2026-10-10T10:15:00Z'));
    });

    it('keeps the items sorted by SKU, whatever order they came in', () => {
      const reservation = Reservation.create(
        'O1',
        [
          { skuId: 'C', qty: 1 },
          { skuId: 'A', qty: 1 },
          { skuId: 'B', qty: 1 },
        ],
        NOW,
        900,
      );

      expect(reservation.items.map((item) => item.skuId)).toEqual([
        'A',
        'B',
        'C',
      ]);
    });

    it('does not let the caller change the stored items afterwards', () => {
      const input = [{ skuId: 'A', qty: 2 }];
      const reservation = Reservation.create('O1', input, NOW, 900);

      input[0].qty = 99;
      reservation.items[0].qty = 77;

      expect(reservation.items).toEqual([{ skuId: 'A', qty: 2 }]);
    });

    it.each([
      ['an empty order id', '', [{ skuId: 'A', qty: 1 }]],
      ['a blank order id', '   ', [{ skuId: 'A', qty: 1 }]],
      [
        'an order id longer than the column',
        'x'.repeat(101),
        [{ skuId: 'A', qty: 1 }],
      ],
      ['no items', 'O1', []],
      ['a blank SKU id', 'O1', [{ skuId: ' ', qty: 1 }]],
      ['a quantity of 0', 'O1', [{ skuId: 'A', qty: 0 }]],
      ['a negative quantity', 'O1', [{ skuId: 'A', qty: -1 }]],
      ['a quantity that is not whole', 'O1', [{ skuId: 'A', qty: 1.5 }]],
      [
        'a quantity that is not a number',
        'O1',
        [{ skuId: 'A', qty: Number.NaN }],
      ],
      ['a quantity over the limit', 'O1', [{ skuId: 'A', qty: 1001 }]],
    ])('refuses %s with INV-002', (_, orderId, items) => {
      expect(() => Reservation.create(orderId, items, NOW, 900)).toThrowError(
        expect.objectContaining({
          code: InventoryErrorCodes.INVALID_RESERVATION_REQUEST.code,
        }),
      );
    });

    it('refuses the same SKU on two lines, naming it', () => {
      expect(() =>
        Reservation.create(
          'O1',
          [
            { skuId: 'A', qty: 1 },
            { skuId: 'A', qty: 2 },
          ],
          NOW,
          900,
        ),
      ).toThrowError(/SKU A appears more than once/);
    });

    it('accepts the limits themselves: 50 items and a quantity of 1000', () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        skuId: `S${i}`,
        qty: 1000,
      }));

      expect(() => Reservation.create('O1', items, NOW, 900)).not.toThrow();
      expect(() =>
        Reservation.create(
          'O1',
          [...items, { skuId: 'one-too-many', qty: 1 }],
          NOW,
          900,
        ),
      ).toThrow();
    });
  });

  describe('fingerprint and hasSameContentAs', () => {
    const make = (items: { skuId: string; qty: number }[]) =>
      Reservation.create('O1', items, NOW, 900);

    it('is the same for the same content in any order, and different for different content', () => {
      const one = make([
        { skuId: 'A', qty: 2 },
        { skuId: 'B', qty: 1 },
      ]);
      const reordered = make([
        { skuId: 'B', qty: 1 },
        { skuId: 'A', qty: 2 },
      ]);
      const other = make([
        { skuId: 'A', qty: 3 },
        { skuId: 'B', qty: 1 },
      ]);

      expect(one.fingerprint()).toBe(reordered.fingerprint());
      expect(one.fingerprint()).not.toBe(other.fingerprint());
      expect(one.fingerprint()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('compares content with a list of items', () => {
      const reservation = make([
        { skuId: 'A', qty: 2 },
        { skuId: 'B', qty: 1 },
      ]);

      expect(
        reservation.hasSameContentAs([
          { skuId: 'B', qty: 1 },
          { skuId: 'A', qty: 2 },
        ]),
      ).toBe(true);
      expect(reservation.hasSameContentAs([{ skuId: 'A', qty: 2 }])).toBe(
        false,
      );
      expect(
        reservation.hasSameContentAs([
          { skuId: 'A', qty: 2 },
          { skuId: 'B', qty: 2 },
        ]),
      ).toBe(false);
    });
  });

  describe('restore', () => {
    it('rebuilds a stored reservation in any status without re-validating it', () => {
      const reservation = Reservation.restore({
        orderId: 'O1',
        items: [{ skuId: 'A', qty: 2 }],
        status: ReservationStatus.CONFIRMED,
        expiresAt: NOW,
      });

      expect(reservation.status).toBe(ReservationStatus.CONFIRMED);
      expect(reservation.expiresAt).toEqual(NOW);
      expect(reservation.id).toBe('O1');
    });
  });
});
