import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService, type PaginatedResult } from '@/core/index.js';
import {
  Order,
  OrderAlreadyExistsError,
  type IOrderRepository,
  type OrderStatus,
  type OutboxEventDraft,
  type TransitionOptions,
} from '../../domain/index.js';
import { OrderMapper } from './mappers/order.mapper.js';

// Times in the database are UTC wall time without a time zone, and `now()` is a timestamptz that
// Postgres would convert with the session's time zone before comparing, so the database clock is
// always taken as UTC wall time to be comparable with the stored times.
const DATABASE_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/**
 * Orders in Postgres. Everything that writes is ONE short transaction that touches Postgres and
 * nothing else, so a connection is held for a few statements only. Every change of status is a
 * single conditional UPDATE (`WHERE status = <old>`): when two of them reach the same order
 * together, Postgres lets one change the row and the other finds nothing left to change.
 */
@Injectable()
export class PrismaOrderRepository implements IOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(orderId: string): Promise<Order | null> {
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    return row ? OrderMapper.toDomain(row) : null;
  }

  async findByIdForUser(
    userId: string,
    orderId: string,
  ): Promise<Order | null> {
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { items: true },
    });
    return row ? OrderMapper.toDomain(row) : null;
  }

  async listByUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<PaginatedResult<Order> | null> {
    if (cursor !== undefined) {
      // A cursor that is not an order of this user is refused, so it can never be used to probe
      const own = await this.prisma.order.findFirst({
        where: { id: cursor, userId },
        select: { id: true },
      });
      if (!own) return null;
    }

    const rows = await this.prisma.order.findMany({
      where: { userId },
      include: { items: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      data: page.map(OrderMapper.toDomain),
      meta: {
        hasMore,
        nextCursor: hasMore ? page[page.length - 1].id : null,
      },
    };
  }

  async create(order: Order, event: OutboxEventDraft): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      try {
        await tx.order.create({
          data: {
            id: order.id,
            userId: order.userId,
            idempotencyKey: order.idempotencyKey,
            paymentMethod: order.paymentMethod,
            status: order.status,
            version: order.version,
            stockReturnPending: order.stockReturnPending,
            total: order.total,
            shippingAddress:
              order.shippingAddress as unknown as Prisma.InputJsonValue,
            expiresAt: order.expiresAt,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            items: {
              create: order.items.map((item) => ({
                id: randomUUID(),
                skuId: item.skuId,
                productName: item.productName,
                thumbnail: item.thumbnail,
                attributes: item.attributes as Prisma.InputJsonValue,
                unitPrice: item.unitPrice,
                quantity: item.quantity,
                lineTotal: item.lineTotal,
              })),
            },
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new OrderAlreadyExistsError(order.id);
        }
        throw error;
      }
      // Any failure here (a duplicate event id, a lost connection) undoes the order as well
      await this.writeEvent(tx, event);
    });
  }

  async transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    event: OutboxEventDraft,
    options: TransitionOptions = {},
  ): Promise<Order | null> {
    return this.prisma.$transaction(async (tx) => {
      const flag = options.stockReturnPending === true;
      // The time as text with its zone, turned into the UTC wall time the column holds
      const setExpiry = options.expiresAt
        ? Prisma.sql`"expiresAt" = (${options.expiresAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),`
        : Prisma.empty;
      const changed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "Order"
        SET "status" = ${to}::"OrderStatus",
            "version" = "version" + 1,
            "stockReturnPending" = ("stockReturnPending" OR ${flag}::boolean),
            ${setExpiry}
            "updatedAt" = ${DATABASE_NOW}
        WHERE "id" = ${orderId} AND "status" = ${from}::"OrderStatus"
        RETURNING "id"`;
      if (changed.length === 0) return null;

      await this.writeEvent(tx, event);
      const row = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
      return OrderMapper.toDomain(row);
    });
  }

  async findDueOnlineIds(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Order"
      WHERE "status" = 'PENDING' AND "paymentMethod" = 'ONLINE'
        AND "expiresAt" <= ${DATABASE_NOW}
      ORDER BY "expiresAt"
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async findStuckPaymentOrderIds(
    olderThanSeconds: number,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Order"
      WHERE "status" = 'PAYMENT_PROCESSING' AND "paymentMethod" = 'ONLINE'
        AND "updatedAt" <= ${DATABASE_NOW} - make_interval(secs => ${olderThanSeconds})
      ORDER BY "updatedAt"
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async findPendingCodIds(
    olderThanSeconds: number,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Order"
      WHERE "status" = 'PENDING' AND "paymentMethod" = 'COD'
        AND "createdAt" <= ${DATABASE_NOW} - make_interval(secs => ${olderThanSeconds})
      ORDER BY "createdAt"
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async findStockReturnPendingIds(
    olderThanSeconds: number,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Order"
      WHERE "status" = 'CANCELLED' AND "stockReturnPending" = true
        AND "updatedAt" <= ${DATABASE_NOW} - make_interval(secs => ${olderThanSeconds})
      ORDER BY "updatedAt"
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async clearStockReturnPending(orderId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "Order"
      SET "stockReturnPending" = false, "updatedAt" = ${DATABASE_NOW}
      WHERE "id" = ${orderId} AND "stockReturnPending" = true`;
  }

  private writeEvent(tx: Prisma.TransactionClient, event: OutboxEventDraft) {
    return tx.outboxEvent.create({
      data: {
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
        payload: event.payload as Prisma.InputJsonValue,
      },
    });
  }
}
