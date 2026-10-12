import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@/core/index.js';
import {
  Reservation,
  ReservationAlreadyExistsError,
  ReservationStatus,
} from '../../domain/index.js';
import { PrismaReservationRepository } from './prisma-reservation.repository.js';
import { PrismaStockRepository } from './prisma-stock.repository.js';

/** Against the real Postgres: the conditional updates, the constraints and the foreign keys. */
describe('Inventory repositories (Integration)', () => {
  let prisma: PrismaService;
  let reservations: PrismaReservationRepository;
  let stock: PrismaStockRepository;

  const FUTURE = () => new Date(Date.now() + 15 * 60_000);
  // Whether a hold has expired is judged by the DATABASE clock, which can differ from this
  // machine's by a second or so (a container's clock drifts). A hold that "expired a second
  // ago" by this clock may not have by the database's, so tests use a safe margin.
  const EXPIRED_AGO = 10_000;

  /** Two SKUs of one product, so reservations have something to point at. */
  const seedCatalog = async () => {
    await prisma.category.create({
      data: { id: 'inv_cat', name: 'Inv', path: '/inv_cat/' },
    });
    await prisma.product.create({
      data: { id: 'inv_prod', categoryId: 'inv_cat', name: 'Inv product' },
    });
    for (const id of ['A', 'B']) {
      await prisma.sku.create({
        data: {
          id: `inv_sku_${id}`,
          productId: 'inv_prod',
          price: 10,
          attributes: {},
          skuCode: `INV-${id}`,
        },
      });
    }
  };

  const reserve = async (
    orderId: string,
    items: { skuId: string; qty: number }[],
    expiresAt = FUTURE(),
  ) => {
    const reservation = Reservation.restore({
      orderId,
      items,
      status: ReservationStatus.RESERVED,
      expiresAt,
    });
    await reservations.create(reservation);
  };

  const statusOf = async (orderId: string) =>
    (await prisma.reservation.findMany({ where: { orderId } })).map(
      (row) => row.status,
    );

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaService,
        PrismaReservationRepository,
        PrismaStockRepository,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    reservations = module.get(PrismaReservationRepository);
    stock = module.get(PrismaStockRepository);
  });

  beforeEach(async () => {
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await seedCatalog();
  });

  afterAll(async () => {
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.$disconnect();
  });

  describe('the database protects itself (AC-26)', () => {
    it('refuses a negative on-hand', async () => {
      await expect(
        prisma.skuStock.create({ data: { skuId: 'inv_sku_A', onHand: -1 } }),
      ).rejects.toThrow();
    });

    it('accepts an on-hand of 0', async () => {
      await expect(
        prisma.skuStock.create({ data: { skuId: 'inv_sku_A', onHand: 0 } }),
      ).resolves.toBeDefined();
    });

    it.each([0, -3])('refuses a reservation of %s units', async (qty) => {
      await expect(
        prisma.reservation.create({
          data: {
            id: 'r1',
            orderId: 'O1',
            skuId: 'inv_sku_A',
            qty,
            expiresAt: FUTURE(),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a second line for the same order and SKU', async () => {
      await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }]);

      await expect(
        prisma.reservation.create({
          data: {
            id: 'dup',
            orderId: 'O1',
            skuId: 'inv_sku_A',
            qty: 1,
            expiresAt: FUTURE(),
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a SKU that does not exist, for stock and for a reservation', async () => {
      await expect(
        prisma.skuStock.create({ data: { skuId: 'no_such', onHand: 1 } }),
      ).rejects.toThrow();
      await expect(
        reserve('O1', [{ skuId: 'no_such', qty: 1 }]),
      ).rejects.toThrow();
    });

    it('deletes the stock row together with its SKU (CASCADE)', async () => {
      await prisma.skuStock.create({ data: { skuId: 'inv_sku_A', onHand: 5 } });

      await prisma.sku.delete({ where: { id: 'inv_sku_A' } });

      expect(await prisma.skuStock.count()).toBe(0);
    });

    it.each(['RESERVED', 'CONFIRMED', 'RELEASED'] as const)(
      'refuses to delete a SKU that has a %s reservation (RESTRICT)',
      async (status) => {
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }]);
        await prisma.reservation.updateMany({ data: { status } });

        await expect(
          prisma.sku.delete({ where: { id: 'inv_sku_A' } }),
        ).rejects.toThrow();

        expect(await prisma.sku.count({ where: { id: 'inv_sku_A' } })).toBe(1);
      },
    );
  });

  describe('PrismaReservationRepository', () => {
    it('saves every line of an order and reads them back as one reservation', async () => {
      const expiresAt = FUTURE();
      await reserve(
        'O1',
        [
          { skuId: 'inv_sku_B', qty: 1 },
          { skuId: 'inv_sku_A', qty: 2 },
        ],
        expiresAt,
      );

      const found = await reservations.findByOrderId('O1');

      expect(found?.orderId).toBe('O1');
      expect(found?.status).toBe(ReservationStatus.RESERVED);
      expect(found?.items).toEqual([
        { skuId: 'inv_sku_A', qty: 2 },
        { skuId: 'inv_sku_B', qty: 1 },
      ]);
      expect(found?.expiresAt.getTime()).toBe(expiresAt.getTime());
    });

    it('finds nothing for an order that holds nothing', async () => {
      expect(await reservations.findByOrderId('nope')).toBeNull();
      expect(await reservations.existsForOrder('nope')).toBe(false);
    });

    it('answers a clash with ReservationAlreadyExistsError and keeps the first lines (AC-8, AC-9)', async () => {
      await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }]);

      await expect(
        reserve('O1', [
          { skuId: 'inv_sku_A', qty: 5 },
          { skuId: 'inv_sku_B', qty: 5 },
        ]),
      ).rejects.toBeInstanceOf(ReservationAlreadyExistsError);

      // Neither line of the second attempt was written: one statement, all or nothing
      expect((await reservations.findByOrderId('O1'))?.items).toEqual([
        { skuId: 'inv_sku_A', qty: 1 },
      ]);
      expect(await reservations.existsForOrder('O1')).toBe(true);
    });

    describe('confirm (AC-11)', () => {
      beforeEach(async () => {
        await prisma.skuStock.createMany({
          data: [
            { skuId: 'inv_sku_A', onHand: 10 },
            { skuId: 'inv_sku_B', onHand: 4 },
          ],
        });
        await reserve('O1', [
          { skuId: 'inv_sku_A', qty: 2 },
          { skuId: 'inv_sku_B', qty: 1 },
        ]);
      });

      const onHand = async (skuId: string) =>
        (await prisma.skuStock.findUniqueOrThrow({ where: { skuId } })).onHand;

      it('moves RESERVED to CONFIRMED and takes the units out of the warehouse, for every line', async () => {
        expect(await reservations.confirm('O1')).toBe('CONFIRMED');

        expect(await statusOf('O1')).toEqual(['CONFIRMED', 'CONFIRMED']);
        expect(await onHand('inv_sku_A')).toBe(8);
        expect(await onHand('inv_sku_B')).toBe(3);
      });

      it('does nothing the second time and takes the units out only once', async () => {
        await reservations.confirm('O1');

        expect(await reservations.confirm('O1')).toBe('ALREADY_CONFIRMED');

        expect(await onHand('inv_sku_A')).toBe(8);
      });

      it('refuses an order whose units were released', async () => {
        await reservations.release('O1', { onlyIfExpired: false });

        expect(await reservations.confirm('O1')).toBe('RELEASED');

        expect(await onHand('inv_sku_A')).toBe(10);
      });

      it('says NOT_FOUND for an order that holds nothing', async () => {
        expect(await reservations.confirm('nope')).toBe('NOT_FOUND');
      });

      it('changes nothing at all when the stock cannot cover a line (all or nothing)', async () => {
        await prisma.$executeRaw`UPDATE "SkuStock" SET "onHand" = 0 WHERE "skuId" = 'inv_sku_B'`;
        // (the stock was lowered behind the repository's back, which the CHECK alone cannot see)

        await expect(reservations.confirm('O1')).rejects.toThrow();

        expect(await statusOf('O1')).toEqual(['RESERVED', 'RESERVED']);
        expect(await onHand('inv_sku_A')).toBe(10);
      });
    });

    describe('release (AC-12)', () => {
      it('moves RESERVED to RELEASED and returns the lines it released', async () => {
        await reserve('O1', [
          { skuId: 'inv_sku_A', qty: 2 },
          { skuId: 'inv_sku_B', qty: 1 },
        ]);

        const released = await reservations.release('O1', {
          onlyIfExpired: false,
        });

        expect(released).toEqual(
          expect.arrayContaining([
            { skuId: 'inv_sku_A', qty: 2 },
            { skuId: 'inv_sku_B', qty: 1 },
          ]),
        );
        expect(released).toHaveLength(2);
        expect(await statusOf('O1')).toEqual(['RELEASED', 'RELEASED']);
      });

      it('releases once: the second call finds nothing to release', async () => {
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 2 }]);

        await reservations.release('O1', { onlyIfExpired: false });

        expect(
          await reservations.release('O1', { onlyIfExpired: false }),
        ).toEqual([]);
      });

      it('never releases a paid order', async () => {
        await prisma.skuStock.create({
          data: { skuId: 'inv_sku_A', onHand: 5 },
        });
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 2 }]);
        await reservations.confirm('O1');

        expect(
          await reservations.release('O1', { onlyIfExpired: false }),
        ).toEqual([]);
        expect(await statusOf('O1')).toEqual(['CONFIRMED']);
      });

      it('with onlyIfExpired, leaves a hold that has not expired (a timer that came early)', async () => {
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 2 }], FUTURE());

        expect(
          await reservations.release('O1', { onlyIfExpired: true }),
        ).toEqual([]);
        expect(await statusOf('O1')).toEqual(['RESERVED']);
      });

      it('with onlyIfExpired, releases a hold whose expiry has passed, by the database clock', async () => {
        await reserve(
          'O1',
          [{ skuId: 'inv_sku_A', qty: 2 }],
          new Date(Date.now() - EXPIRED_AGO),
        );

        const released = await reservations.release('O1', {
          onlyIfExpired: true,
        });

        expect(released).toEqual([{ skuId: 'inv_sku_A', qty: 2 }]);
      });

      it('releases nothing for an order that holds nothing', async () => {
        expect(
          await reservations.release('nope', { onlyIfExpired: false }),
        ).toEqual([]);
      });
    });

    describe('confirm and release at the same moment: exactly one wins (AC-13)', () => {
      it('ends every order in CONFIRMED or RELEASED, never both, and counts the stock right', async () => {
        await prisma.skuStock.create({
          data: { skuId: 'inv_sku_A', onHand: 100 },
        });
        const orders = Array.from({ length: 30 }, (_, i) => `RACE-${i}`);
        for (const orderId of orders) {
          await reserve(orderId, [{ skuId: 'inv_sku_A', qty: 1 }]);
        }

        const outcomes = await Promise.all(
          orders.flatMap((orderId) => [
            reservations.confirm(orderId),
            reservations.release(orderId, { onlyIfExpired: false }),
          ]),
        );

        let confirmed = 0;
        for (const orderId of orders) {
          const statuses = await statusOf(orderId);
          expect(statuses).toHaveLength(1);
          expect(['CONFIRMED', 'RELEASED']).toContain(statuses[0]);
          if (statuses[0] === 'CONFIRMED') confirmed++;
        }
        // The warehouse lost a unit for exactly the orders that were confirmed
        const { onHand } = await prisma.skuStock.findUniqueOrThrow({
          where: { skuId: 'inv_sku_A' },
        });
        expect(onHand).toBe(100 - confirmed);
        // A release that lost found nothing; a confirm that lost said RELEASED
        expect(
          outcomes.some((o) => o === 'RELEASED' || o === 'CONFIRMED'),
        ).toBe(true);
      });
    });

    describe('returnConfirmed (AC-25, AC-26)', () => {
      const onHand = async (skuId: string) =>
        (await prisma.skuStock.findUniqueOrThrow({ where: { skuId } })).onHand;

      beforeEach(async () => {
        await prisma.skuStock.createMany({
          data: [
            { skuId: 'inv_sku_A', onHand: 10 },
            { skuId: 'inv_sku_B', onHand: 4 },
          ],
        });
        await reserve('O1', [
          { skuId: 'inv_sku_A', qty: 2 },
          { skuId: 'inv_sku_B', qty: 1 },
        ]);
      });

      it('moves CONFIRMED to RETURNED and puts the units back into the warehouse, for every line', async () => {
        await reservations.confirm('O1');
        expect(await onHand('inv_sku_A')).toBe(8);
        expect(await onHand('inv_sku_B')).toBe(3);

        const result = await reservations.returnConfirmed('O1');

        expect(result.kind).toBe('RETURNED');
        if (result.kind !== 'RETURNED') throw new Error('unreachable');
        expect(
          [...result.items].sort((a, b) => a.skuId.localeCompare(b.skuId)),
        ).toEqual([
          { skuId: 'inv_sku_A', qty: 2 },
          { skuId: 'inv_sku_B', qty: 1 },
        ]);
        expect(await statusOf('O1')).toEqual(['RETURNED', 'RETURNED']);
        expect(await onHand('inv_sku_A')).toBe(10);
        expect(await onHand('inv_sku_B')).toBe(4);
      });

      it('does nothing the second time and puts the units back only once', async () => {
        await reservations.confirm('O1');
        await reservations.returnConfirmed('O1');

        expect(await reservations.returnConfirmed('O1')).toEqual({
          kind: 'ALREADY_RETURNED',
        });

        expect(await onHand('inv_sku_A')).toBe(10);
        expect(await statusOf('O1')).toEqual(['RETURNED', 'RETURNED']);
      });

      it('has nothing to return for an order that was never paid (RESERVED or RELEASED)', async () => {
        expect(await reservations.returnConfirmed('O1')).toEqual({
          kind: 'NOT_CONFIRMED',
        });
        await reservations.release('O1', { onlyIfExpired: false });
        expect(await reservations.returnConfirmed('O1')).toEqual({
          kind: 'NOT_CONFIRMED',
        });

        expect(await statusOf('O1')).toEqual(['RELEASED', 'RELEASED']);
        expect(await onHand('inv_sku_A')).toBe(10);
      });

      it('says NOT_FOUND for an order that holds nothing', async () => {
        expect(await reservations.returnConfirmed('nope')).toEqual({
          kind: 'NOT_FOUND',
        });
      });

      it('changes nothing at all when a line cannot be put back (all or nothing)', async () => {
        await reservations.confirm('O1');
        // the stock row of B disappears behind the repository's back
        await prisma.$executeRaw`DELETE FROM "SkuStock" WHERE "skuId" = 'inv_sku_B'`;

        await expect(reservations.returnConfirmed('O1')).rejects.toThrow();

        expect(await statusOf('O1')).toEqual(['CONFIRMED', 'CONFIRMED']);
        expect(await onHand('inv_sku_A')).toBe(8); // not put back: the whole transaction rolled back
      });

      it('is not confirmed again, released or reserved again after the return', async () => {
        await reservations.confirm('O1');
        await reservations.returnConfirmed('O1');

        // a confirm finds the hold gone; a release finds nothing RESERVED
        expect(await reservations.confirm('O1')).toBe('RELEASED');
        expect(
          await reservations.release('O1', { onlyIfExpired: false }),
        ).toEqual([]);
        expect((await reservations.findByOrderId('O1'))?.status).toBe(
          ReservationStatus.RETURNED,
        );
        expect(await onHand('inv_sku_A')).toBe(10);
      });

      it('counts what is held correctly afterwards: a returned order is no longer held', async () => {
        await reservations.confirm('O1');
        await reservations.returnConfirmed('O1');

        expect(await stock.getSnapshot('inv_sku_A')).toEqual({
          onHand: 10,
          reserved: 0,
        });
      });

      it('puts the units back exactly once when ten returns of the same order come together', async () => {
        await reservations.confirm('O1');

        const results = await Promise.all(
          Array.from({ length: 10 }, () => reservations.returnConfirmed('O1')),
        );

        expect(results.filter((r) => r.kind === 'RETURNED')).toHaveLength(1);
        expect(
          results.filter((r) => r.kind === 'ALREADY_RETURNED'),
        ).toHaveLength(9);
        expect(await onHand('inv_sku_A')).toBe(10);
        expect(await onHand('inv_sku_B')).toBe(4);
      });

      it('races a confirm and a release for the same order: the return only ever touches CONFIRMED', async () => {
        await prisma.skuStock.update({
          where: { skuId: 'inv_sku_A' },
          data: { onHand: 100 },
        });
        const orders = Array.from({ length: 30 }, (_, i) => `RET-${i}`);
        for (const orderId of orders) {
          await reserve(orderId, [{ skuId: 'inv_sku_A', qty: 1 }]);
        }
        // half are confirmed first, so a return has something to put back
        for (const orderId of orders.slice(0, 15)) {
          await reservations.confirm(orderId);
        }

        await Promise.all(
          orders.flatMap((orderId) => [
            reservations.returnConfirmed(orderId),
            reservations.release(orderId, { onlyIfExpired: false }),
            reservations.confirm(orderId),
          ]),
        );

        // Whatever the order of the three, each order ends in one final-looking state and the
        // warehouse lost a unit only for the orders that stayed CONFIRMED
        let confirmed = 0;
        for (const orderId of orders) {
          const statuses = await statusOf(orderId);
          expect(statuses).toHaveLength(1);
          expect(['CONFIRMED', 'RELEASED', 'RETURNED']).toContain(statuses[0]);
          if (statuses[0] === 'CONFIRMED') confirmed++;
        }
        expect(await onHand('inv_sku_A')).toBe(100 - confirmed);
      });
    });

    describe('extend (AC-27)', () => {
      const expiryOf = async (orderId: string) =>
        (
          await prisma.reservation.findMany({
            where: { orderId },
            select: { expiresAt: true },
          })
        ).map((row) => row.expiresAt.getTime());
      // The database clock can differ from this machine's by a second or so
      const NEAR = 10_000;

      it('holds the units until that many seconds from now, when that is later than the hold', async () => {
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }], FUTURE());

        const result = await reservations.extend('O1', 3600);

        expect(result.kind).toBe('EXTENDED');
        const expected = Date.now() + 3_600_000;
        const [stored] = await expiryOf('O1');
        expect(Math.abs(stored - expected)).toBeLessThan(NEAR);
        expect(
          Math.abs(
            (result as { expiresAt: Date }).expiresAt.getTime() - expected,
          ),
        ).toBeLessThan(NEAR);
      });

      it('never shortens a hold', async () => {
        const original = new Date(Date.now() + 3_600_000);
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }], original);

        const result = await reservations.extend('O1', 60);

        expect(result.kind).toBe('EXTENDED');
        expect(await expiryOf('O1')).toEqual([original.getTime()]);
      });

      it('gives every line of the order the same new expiry', async () => {
        await reserve(
          'O1',
          [
            { skuId: 'inv_sku_A', qty: 1 },
            { skuId: 'inv_sku_B', qty: 2 },
          ],
          FUTURE(),
        );

        await reservations.extend('O1', 1800);

        const expiries = await expiryOf('O1');
        expect(expiries).toHaveLength(2);
        expect(expiries[0]).toBe(expiries[1]);
      });

      it('does not touch the status, the units held, or any other order', async () => {
        await prisma.skuStock.create({
          data: { skuId: 'inv_sku_A', onHand: 10 },
        });
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 2 }], FUTURE());
        const other = new Date(Date.now() + 100_000);
        await reserve('O2', [{ skuId: 'inv_sku_A', qty: 3 }], other);

        await reservations.extend('O1', 3600);

        expect(await statusOf('O1')).toEqual(['RESERVED']);
        expect(await expiryOf('O2')).toEqual([other.getTime()]);
        expect(await stock.getSnapshot('inv_sku_A')).toEqual({
          onHand: 10,
          reserved: 5,
        });
      });

      it('can be repeated, and the expiry only ever moves forward', async () => {
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }], FUTURE());

        await reservations.extend('O1', 3600);
        const [first] = await expiryOf('O1');
        await reservations.extend('O1', 60);
        const [second] = await expiryOf('O1');
        await reservations.extend('O1', 7200);
        const [third] = await expiryOf('O1');

        expect(second).toBe(first);
        expect(third).toBeGreaterThan(first);
      });

      it('ten at the same moment all succeed and agree on a time', async () => {
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }], FUTURE());

        const results = await Promise.all(
          Array.from({ length: 10 }, () => reservations.extend('O1', 1800)),
        );

        expect(results.every((r) => r.kind === 'EXTENDED')).toBe(true);
        const [stored] = await expiryOf('O1');
        expect(Math.abs(stored - (Date.now() + 1_800_000))).toBeLessThan(NEAR);
      });

      it.each([
        [
          'released',
          async () => reservations.release('O1', { onlyIfExpired: false }),
        ],
        ['confirmed (paid)', async () => reservations.confirm('O1')],
        [
          'returned',
          async () => {
            await reservations.confirm('O1');
            await reservations.returnConfirmed('O1');
          },
        ],
      ])(
        'refuses an order that is %s, and changes nothing',
        async (_, prepare) => {
          await prisma.skuStock.create({
            data: { skuId: 'inv_sku_A', onHand: 10 },
          });
          const original = FUTURE();
          await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }], original);
          await prepare();

          const result = await reservations.extend('O1', 3600);

          expect(result).toEqual({ kind: 'NOT_EXTENDABLE' });
          expect(await expiryOf('O1')).toEqual([original.getTime()]);
        },
      );

      it('refuses a hold that is already past its expiry by the database clock, and does not bring it back', async () => {
        const past = new Date(Date.now() - EXPIRED_AGO);
        await reserve('O1', [{ skuId: 'inv_sku_A', qty: 1 }], past);

        const result = await reservations.extend('O1', 3600);

        expect(result).toEqual({ kind: 'NOT_EXTENDABLE' });
        expect(await expiryOf('O1')).toEqual([past.getTime()]);
        expect(await reservations.findExpiredOrderIds(10)).toEqual(['O1']);
      });

      it('says there is nothing to extend for an order that holds nothing', async () => {
        expect(await reservations.extend('NEVER', 3600)).toEqual({
          kind: 'NOT_FOUND',
        });
      });

      it('an extension and a release at the same moment: whichever comes second finds the other done', async () => {
        for (let i = 0; i < 20; i++) {
          const orderId = `RACE-${i}`;
          await reserve(orderId, [{ skuId: 'inv_sku_A', qty: 1 }], FUTURE());

          const [extended] = await Promise.all([
            reservations.extend(orderId, 3600),
            reservations.release(orderId, { onlyIfExpired: false }),
          ]);

          // The release always happens; the extension either came first or was refused
          expect(await statusOf(orderId)).toEqual(['RELEASED']);
          expect(['EXTENDED', 'NOT_EXTENDABLE']).toContain(extended.kind);
          // Once released, a later extension is refused however far ahead the expiry now is
          expect(await reservations.extend(orderId, 3600)).toEqual({
            kind: 'NOT_EXTENDABLE',
          });
        }
      });
    });

    describe('findExpiredOrderIds (AC-15)', () => {
      it('lists the orders that are RESERVED and past their expiry, oldest first, once each', async () => {
        await reserve(
          'LATE',
          [{ skuId: 'inv_sku_A', qty: 1 }],
          new Date(Date.now() - EXPIRED_AGO),
        );
        await reserve(
          'EARLY',
          [
            { skuId: 'inv_sku_A', qty: 1 },
            { skuId: 'inv_sku_B', qty: 1 },
          ],
          new Date(Date.now() - EXPIRED_AGO - 50_000),
        );
        await reserve('FRESH', [{ skuId: 'inv_sku_A', qty: 1 }], FUTURE());
        await reserve(
          'GONE',
          [{ skuId: 'inv_sku_A', qty: 1 }],
          new Date(Date.now() - EXPIRED_AGO - 10_000),
        );
        await reservations.release('GONE', { onlyIfExpired: false });

        expect(await reservations.findExpiredOrderIds(10)).toEqual([
          'EARLY',
          'LATE',
        ]);
      });

      it('stops at the limit', async () => {
        for (const id of ['E1', 'E2', 'E3']) {
          await reserve(
            id,
            [{ skuId: 'inv_sku_A', qty: 1 }],
            new Date(Date.now() - EXPIRED_AGO),
          );
        }

        expect(await reservations.findExpiredOrderIds(2)).toHaveLength(2);
      });
    });
  });

  describe('PrismaStockRepository', () => {
    it('has no snapshot for a SKU without a stock row', async () => {
      expect(await stock.getSnapshot('inv_sku_A')).toBeNull();
    });

    it('reads onHand and the units held by RESERVED reservations, and nothing else (AC-17)', async () => {
      await prisma.skuStock.create({
        data: { skuId: 'inv_sku_A', onHand: 10 },
      });
      await reserve('O1', [{ skuId: 'inv_sku_A', qty: 2 }]); // RESERVED
      await reserve('O2', [{ skuId: 'inv_sku_A', qty: 3 }]); // RESERVED
      await reserve('O3', [{ skuId: 'inv_sku_A', qty: 1 }]);
      await reservations.confirm('O3'); // CONFIRMED: onHand went 10 -> 9
      await reserve('O4', [{ skuId: 'inv_sku_A', qty: 4 }]);
      await reservations.release('O4', { onlyIfExpired: false }); // RELEASED

      expect(await stock.getSnapshot('inv_sku_A')).toEqual({
        onHand: 9,
        reserved: 5,
      });
    });

    it('counts units held for a SKU that has no stock row as held, with on-hand unknown (no snapshot)', async () => {
      await reserve('O1', [{ skuId: 'inv_sku_B', qty: 2 }]);

      expect(await stock.getSnapshot('inv_sku_B')).toBeNull();
    });
  });
});
