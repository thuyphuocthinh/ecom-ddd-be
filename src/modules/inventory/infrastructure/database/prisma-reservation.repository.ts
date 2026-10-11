import { Injectable } from '@nestjs/common';
import { Prisma, ReservationStatus as PrismaStatus } from '@prisma/client';
import { PrismaService, snowflake } from '@/core/index.js';
import {
  Reservation,
  ReservationAlreadyExistsError,
  ReservationStatus,
  type ConfirmOutcome,
  type IReservationRepository,
  type ReturnResult,
  type StockItem,
} from '../../domain/index.js';

const STATUS: Record<PrismaStatus, ReservationStatus> = {
  RESERVED: ReservationStatus.RESERVED,
  CONFIRMED: ReservationStatus.CONFIRMED,
  RELEASED: ReservationStatus.RELEASED,
  RETURNED: ReservationStatus.RETURNED,
};

// `expiresAt` is a TIMESTAMP without time zone and Prisma stores UTC in it. `now()` is a
// timestamptz, which Postgres would convert using the SESSION's time zone before comparing, so the
// database clock is always taken as UTC wall time to be comparable with `expiresAt`.
const DATABASE_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/**
 * Reservations in Postgres. Every change of status is a single conditional UPDATE
 * (`WHERE status = 'RESERVED'`): when two of them reach the same order together, Postgres lets
 * one change the row and the other finds nothing left to change. That is what makes confirm and
 * release safe to repeat and safe to race.
 */
@Injectable()
export class PrismaReservationRepository implements IReservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByOrderId(orderId: string): Promise<Reservation | null> {
    const rows = await this.prisma.reservation.findMany({
      where: { orderId },
      orderBy: { skuId: 'asc' },
    });
    if (rows.length === 0) return null;
    // All lines of an order change status together, so the first line speaks for the order
    return Reservation.restore({
      orderId,
      items: rows.map((row) => ({ skuId: row.skuId, qty: row.qty })),
      status: STATUS[rows[0].status],
      expiresAt: rows[0].expiresAt,
    });
  }

  async create(reservation: Reservation): Promise<void> {
    try {
      await this.prisma.reservation.createMany({
        data: reservation.items.map((item) => ({
          id: snowflake.nextId(),
          orderId: reservation.orderId,
          skuId: item.skuId,
          qty: item.qty,
          status: PrismaStatus.RESERVED,
          expiresAt: reservation.expiresAt,
        })),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ReservationAlreadyExistsError(reservation.orderId);
      }
      throw error;
    }
  }

  async existsForOrder(orderId: string): Promise<boolean> {
    const found = await this.prisma.reservation.findFirst({
      where: { orderId },
      select: { id: true },
    });
    return found !== null;
  }

  async confirm(orderId: string): Promise<ConfirmOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.$queryRaw<StockItem[]>`
        UPDATE "Reservation"
        SET "status" = 'CONFIRMED', "updatedAt" = ${DATABASE_NOW}
        WHERE "orderId" = ${orderId} AND "status" = 'RESERVED'
        RETURNING "skuId", "qty"`;

      if (changed.length === 0) {
        // Nothing was RESERVED: say what it is instead. A returned order counts as released: the hold is gone.
        const existing = await tx.reservation.findFirst({
          where: { orderId },
          select: { status: true },
        });
        if (!existing) return 'NOT_FOUND';
        return existing.status === PrismaStatus.CONFIRMED
          ? 'ALREADY_CONFIRMED'
          : 'RELEASED';
      }

      // Paid: the units leave the warehouse. In the same transaction, so either both happen or none.
      for (const line of changed) {
        const taken = await tx.$executeRaw`
          UPDATE "SkuStock"
          SET "onHand" = "onHand" - ${line.qty}, "updatedAt" = ${DATABASE_NOW}
          WHERE "skuId" = ${line.skuId} AND "onHand" >= ${line.qty}`;
        if (taken !== 1) {
          // Cannot happen while onHand is never set below what is held; roll everything back
          throw new Error(
            `Stock of ${line.skuId} is lower than the ${line.qty} units held for order ${orderId}`,
          );
        }
      }
      return 'CONFIRMED';
    });
  }

  async release(
    orderId: string,
    options: { onlyIfExpired: boolean },
  ): Promise<StockItem[]> {
    const onlyIfExpired = options.onlyIfExpired
      ? Prisma.sql`AND "expiresAt" <= ${DATABASE_NOW}`
      : Prisma.empty;
    return this.prisma.$queryRaw<StockItem[]>`
      UPDATE "Reservation"
      SET "status" = 'RELEASED', "updatedAt" = ${DATABASE_NOW}
      WHERE "orderId" = ${orderId} AND "status" = 'RESERVED' ${onlyIfExpired}
      RETURNING "skuId", "qty"`;
  }

  async returnConfirmed(orderId: string): Promise<ReturnResult> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.$queryRaw<StockItem[]>`
        UPDATE "Reservation"
        SET "status" = 'RETURNED', "updatedAt" = ${DATABASE_NOW}
        WHERE "orderId" = ${orderId} AND "status" = 'CONFIRMED'
        RETURNING "skuId", "qty"`;

      if (changed.length === 0) {
        // Nothing was CONFIRMED: say what it is instead
        const existing = await tx.reservation.findFirst({
          where: { orderId },
          select: { status: true },
        });
        if (!existing) return { kind: 'NOT_FOUND' };
        return existing.status === PrismaStatus.RETURNED
          ? { kind: 'ALREADY_RETURNED' }
          : { kind: 'NOT_CONFIRMED' };
      }

      // The units go back into the warehouse. In the same transaction as the status change, so
      // either both happen or none: no unit is ever counted twice or lost.
      for (const line of changed) {
        const put = await tx.$executeRaw`
          UPDATE "SkuStock"
          SET "onHand" = "onHand" + ${line.qty}, "updatedAt" = ${DATABASE_NOW}
          WHERE "skuId" = ${line.skuId}`;
        if (put !== 1) {
          // A reservation cannot exist without a stock row (it needed one to be confirmed)
          throw new Error(
            `No stock row of ${line.skuId} to put the ${line.qty} units of order ${orderId} back into`,
          );
        }
      }
      return { kind: 'RETURNED', items: changed };
    });
  }

  async findExpiredOrderIds(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ orderId: string }[]>`
      SELECT "orderId"
      FROM "Reservation"
      WHERE "status" = 'RESERVED' AND "expiresAt" <= ${DATABASE_NOW}
      GROUP BY "orderId"
      ORDER BY MIN("expiresAt")
      LIMIT ${limit}`;
    return rows.map((row) => row.orderId);
  }
}
