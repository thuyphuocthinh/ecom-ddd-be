import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { InventoryErrorCodes } from '@/core/index.js';
import {
  Reservation,
  ReservationAlreadyExistsError,
  ReservationStatus,
  InventoryDomainException,
} from '../../domain/index.js';
import type { InventoryConfig } from '../../inventory.config.js';
import { createReleaseReservationJob } from '../jobs/release-reservation.job.js';
import { ReserveStockCommand } from './reserve-stock.command.js';
import { ReserveStockHandler } from './reserve-stock.handler.js';

const CONFIG = {
  reservationTtlSeconds: 900,
  maintenanceIntervalSeconds: 0,
  inflightGraceSeconds: 120,
} as InventoryConfig;
const JOB = createReleaseReservationJob(900);

const ITEMS = [
  { skuId: 'A', qty: 2 },
  { skuId: 'B', qty: 1 },
];

/** A reservation already stored for O1, in the given status. */
const stored = (status: ReservationStatus, items = ITEMS) =>
  Reservation.restore({
    orderId: 'O1',
    items,
    status,
    expiresAt: new Date('2026-10-10T10:15:00Z'),
  });

describe('ReserveStockHandler', () => {
  let reservationRepo: any;
  let store: any;
  let rebuilder: any;
  let jobs: any;
  let handler: ReserveStockHandler;
  let calls: string[];

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    calls = [];
    reservationRepo = {
      findByOrderId: vi.fn().mockResolvedValue(null),
      create: vi.fn(async () => {
        calls.push('create');
      }),
    };
    store = {
      hold: vi.fn(async () => {
        calls.push('hold');
        return { kind: 'HELD' };
      }),
      finishHold: vi.fn(async () => {
        calls.push('finishHold');
      }),
      undoHold: vi.fn().mockResolvedValue(true),
      peek: vi.fn().mockResolvedValue(new Map()),
    };
    rebuilder = { rebuild: vi.fn().mockResolvedValue([]) };
    jobs = {
      enqueue: vi.fn(async () => {
        calls.push('enqueue');
      }),
    };
    handler = new ReserveStockHandler(
      reservationRepo,
      store,
      rebuilder,
      jobs,
      JOB,
      CONFIG,
    );
  });

  const reserve = (items = ITEMS, orderId = 'O1') =>
    handler.execute(new ReserveStockCommand(orderId, items));

  describe('a successful hold (AC-1)', () => {
    it('takes the units in Redis, saves the lines, clears the record, then sets the timer, in that order', async () => {
      await reserve();

      expect(calls).toEqual(['hold', 'create', 'finishHold', 'enqueue']);
    });

    it('saves a RESERVED reservation that expires one hold time from now', async () => {
      const before = Date.now();

      const result = await reserve();

      const saved: Reservation = reservationRepo.create.mock.calls[0][0];
      expect(saved.orderId).toBe('O1');
      expect(saved.status).toBe(ReservationStatus.RESERVED);
      expect(saved.items).toEqual(ITEMS);
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 900_000,
      );
      expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 900_000 + 1);
      expect(result.orderId).toBe('O1');
      expect(result.items).toEqual(ITEMS);
    });

    it('sets the give-back timer for this order', async () => {
      await reserve();

      expect(jobs.enqueue).toHaveBeenCalledWith(JOB, { orderId: 'O1' });
    });

    it('asks Redis with the order id, a fingerprint of the content and the items sorted by SKU', async () => {
      await reserve([
        { skuId: 'B', qty: 1 },
        { skuId: 'A', qty: 2 },
      ]);

      const [orderId, fingerprint, items] = store.hold.mock.calls[0];
      expect(orderId).toBe('O1');
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(items).toEqual(ITEMS);
    });
  });

  describe('not enough stock (AC-3, AC-4)', () => {
    const shortages = [
      { skuId: 'A', requested: 2, available: 1 },
      { skuId: 'B', requested: 1, available: 0 },
    ];

    it('answers INV-001 with every short SKU, and saves and schedules nothing', async () => {
      store.hold.mockResolvedValue({ kind: 'SHORT', shortages });

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.OUT_OF_STOCK.code,
        details: { shortages },
      });

      expect(reservationRepo.create).not.toHaveBeenCalled();
      expect(jobs.enqueue).not.toHaveBeenCalled();
      expect(store.undoHold).not.toHaveBeenCalled();
    });
  });

  describe('Redis lost the numbers (AC-5, AC-17)', () => {
    it('rebuilds the missing SKUs and asks again, instead of calling it sold out', async () => {
      store.hold
        .mockResolvedValueOnce({ kind: 'MISSING', skuIds: ['A'] })
        .mockResolvedValueOnce({ kind: 'HELD' });

      const result = await reserve();

      expect(rebuilder.rebuild).toHaveBeenCalledWith(['A']);
      expect(store.hold).toHaveBeenCalledTimes(2);
      expect(result.orderId).toBe('O1');
    });

    it('says sold out for a SKU that has no stock row, listing the other short SKUs too', async () => {
      store.hold.mockResolvedValue({ kind: 'MISSING', skuIds: ['B'] });
      rebuilder.rebuild.mockResolvedValue(['B']); // B has no stock row
      store.peek.mockResolvedValue(new Map([['A', 1]])); // A has 1, wants 2

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.OUT_OF_STOCK.code,
        details: {
          shortages: [
            { skuId: 'B', requested: 1, available: 0 },
            { skuId: 'A', requested: 2, available: 1 },
          ],
        },
      });
      expect(reservationRepo.create).not.toHaveBeenCalled();
    });

    it('gives up with INV-007 when the numbers keep disappearing', async () => {
      store.hold.mockResolvedValue({ kind: 'MISSING', skuIds: ['A'] });

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.STOCK_UNAVAILABLE.code,
      });

      expect(store.hold).toHaveBeenCalledTimes(3);
      expect(reservationRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('bad input (AC-6)', () => {
    it.each([
      ['an empty order id', '', ITEMS],
      ['no items', 'O1', []],
      ['a quantity of 0', 'O1', [{ skuId: 'A', qty: 0 }]],
      ['a quantity that is not whole', 'O1', [{ skuId: 'A', qty: 1.5 }]],
      ['a quantity over 1000', 'O1', [{ skuId: 'A', qty: 1001 }]],
      [
        'the same SKU twice',
        'O1',
        [
          { skuId: 'A', qty: 1 },
          { skuId: 'A', qty: 2 },
        ],
      ],
    ])(
      'refuses %s with INV-002 before touching Redis or Postgres',
      async (_, orderId, items) => {
        await expect(reserve(items, orderId)).rejects.toMatchObject({
          code: InventoryErrorCodes.INVALID_RESERVATION_REQUEST.code,
        });

        expect(reservationRepo.findByOrderId).not.toHaveBeenCalled();
        expect(store.hold).not.toHaveBeenCalled();
      },
    );

    it('refuses more than 50 items', async () => {
      const many = Array.from({ length: 51 }, (_, i) => ({
        skuId: `S${i}`,
        qty: 1,
      }));

      await expect(reserve(many)).rejects.toMatchObject({
        code: InventoryErrorCodes.INVALID_RESERVATION_REQUEST.code,
      });
    });
  });

  describe('an order that already has lines in Postgres (AC-7, AC-9, AC-10)', () => {
    it('answers a retry with the first answer, without touching Redis or setting a second timer', async () => {
      reservationRepo.findByOrderId.mockResolvedValue(
        stored(ReservationStatus.RESERVED),
      );

      const result = await reserve();

      expect(result.expiresAt).toEqual(new Date('2026-10-10T10:15:00Z'));
      expect(store.hold).not.toHaveBeenCalled();
      expect(reservationRepo.create).not.toHaveBeenCalled();
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('answers a retry of an order that was already paid the same way', async () => {
      reservationRepo.findByOrderId.mockResolvedValue(
        stored(ReservationStatus.CONFIRMED),
      );

      await expect(reserve()).resolves.toMatchObject({ orderId: 'O1' });
    });

    it('does not mind the order of the items in a retry', async () => {
      reservationRepo.findByOrderId.mockResolvedValue(
        stored(ReservationStatus.RESERVED),
      );

      await expect(
        reserve([
          { skuId: 'B', qty: 1 },
          { skuId: 'A', qty: 2 },
        ]),
      ).resolves.toMatchObject({ orderId: 'O1' });
    });

    it('refuses the same order with different content (INV-005)', async () => {
      reservationRepo.findByOrderId.mockResolvedValue(
        stored(ReservationStatus.RESERVED),
      );

      await expect(
        reserve([
          { skuId: 'A', qty: 3 },
          { skuId: 'B', qty: 1 },
        ]),
      ).rejects.toMatchObject({
        code: InventoryErrorCodes.RESERVATION_CONFLICT.code,
      });
      expect(store.hold).not.toHaveBeenCalled();
    });

    it('never brings back an order whose paid stock was already put back (INV-006)', async () => {
      reservationRepo.findByOrderId.mockResolvedValue(
        stored(ReservationStatus.RETURNED),
      );

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.RESERVATION_RELEASED.code,
      });
      expect(store.hold).not.toHaveBeenCalled();
    });

    it('never brings back an order whose units were already given back (INV-006)', async () => {
      reservationRepo.findByOrderId.mockResolvedValue(
        stored(ReservationStatus.RELEASED),
      );

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.RESERVATION_RELEASED.code,
      });
      expect(store.hold).not.toHaveBeenCalled();
    });
  });

  describe('the same order held by another request right now (AC-8)', () => {
    it('answers INV-004 and saves nothing', async () => {
      store.hold.mockResolvedValue({ kind: 'IN_PROGRESS' });

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.RESERVATION_IN_PROGRESS.code,
      });

      expect(reservationRepo.create).not.toHaveBeenCalled();
      expect(store.undoHold).not.toHaveBeenCalled();
    });
  });

  describe('Postgres cannot save the lines (AC-20)', () => {
    it('gives the units back in Redis and answers INV-007', async () => {
      reservationRepo.create.mockRejectedValue(new Error('connection lost'));

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.STOCK_UNAVAILABLE.code,
      });

      expect(store.undoHold).toHaveBeenCalledWith('O1', ITEMS);
      expect(store.finishHold).not.toHaveBeenCalled();
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('still answers INV-007 when Redis cannot take the units back either (the repair job will)', async () => {
      reservationRepo.create.mockRejectedValue(new Error('connection lost'));
      store.undoHold.mockRejectedValue(
        new InventoryDomainException(InventoryErrorCodes.STOCK_UNAVAILABLE),
      );

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.STOCK_UNAVAILABLE.code,
      });
    });

    it('treats a clash with another request that saved first as a retry, after giving its own units back', async () => {
      reservationRepo.create.mockRejectedValue(
        new ReservationAlreadyExistsError('O1'),
      );
      reservationRepo.findByOrderId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(stored(ReservationStatus.RESERVED));

      const result = await reserve();

      expect(store.undoHold).toHaveBeenCalledWith('O1', ITEMS);
      expect(result.expiresAt).toEqual(new Date('2026-10-10T10:15:00Z'));
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('once the reservation is saved, nothing turns the answer into a failure (AC-16, AC-21)', () => {
    it('still succeeds when the give-back timer cannot be set (the sweep will do it)', async () => {
      jobs.enqueue.mockRejectedValue(new Error('broker down'));

      await expect(reserve()).resolves.toMatchObject({ orderId: 'O1' });
    });

    it('still succeeds when the being-held record cannot be cleared (the repair job will)', async () => {
      store.finishHold.mockRejectedValue(new Error('redis down'));

      await expect(reserve()).resolves.toMatchObject({ orderId: 'O1' });
      expect(jobs.enqueue).toHaveBeenCalled();
    });
  });

  describe('Redis cannot be reached (AC-22)', () => {
    it('refuses with INV-007 and writes nothing to Postgres', async () => {
      store.hold.mockRejectedValue(
        new InventoryDomainException(InventoryErrorCodes.STOCK_UNAVAILABLE),
      );

      await expect(reserve()).rejects.toMatchObject({
        code: InventoryErrorCodes.STOCK_UNAVAILABLE.code,
      });

      expect(reservationRepo.create).not.toHaveBeenCalled();
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });
  });
});
