import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core/index.js';
import type { OutboxEventDraft } from '../../../orders/domain/index.js';
import {
  Payment,
  PaymentAlreadyExistsError,
  PaymentInProgressError,
  type IInboxStore,
  type InitiatedPayment,
  type IPaymentRepository,
  type PaymentMove,
  type PaymentStatus,
} from '../../domain/index.js';
import { PaymentMapper } from './mappers/payment.mapper.js';

// Times in the database are UTC wall time without a time zone, and `now()` is a timestamptz that
// Postgres would convert with the session's time zone before comparing, so the database clock is
// always taken as UTC wall time to be comparable with the stored times.
const DATABASE_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** The name of the partial unique index that allows one INITIATED payment per order. */
const ONE_INITIATED_PER_ORDER = 'Payment_orderId_initiated_key';

/**
 * Payments in Postgres. Everything that writes is ONE short transaction that touches Postgres and
 * nothing else, so a connection is held for a few statements only. Every change of status is a
 * single conditional UPDATE (`WHERE status IN (<old statuses>)`): when two of them reach the same
 * payment together, Postgres lets one change the row and the other finds nothing left to change.
 */
@Injectable()
export class PrismaPaymentRepository implements IPaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(paymentId: string): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    return row ? PaymentMapper.toDomain(row) : null;
  }

  async findByProviderRef(
    provider: string,
    providerRef: string,
  ): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({
      where: { provider_providerRef: { provider, providerRef } },
    });
    return row ? PaymentMapper.toDomain(row) : null;
  }

  async listByOrder(orderId: string): Promise<Payment[]> {
    const rows = await this.prisma.payment.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(PaymentMapper.toDomain);
  }

  countByOrder(orderId: string): Promise<number> {
    return this.prisma.payment.count({ where: { orderId } });
  }

  async create(payment: Payment): Promise<void> {
    try {
      await this.prisma.payment.create({
        data: {
          id: payment.id,
          orderId: payment.orderId,
          idempotencyKey: payment.idempotencyKey,
          provider: payment.provider,
          providerRef: payment.providerRef,
          status: payment.status,
          version: payment.version,
          amount: payment.amount,
          paidAmount: payment.paidAmount,
          payUrl: payment.payUrl,
          expiresAt: payment.expiresAt,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Which rule refused it: the one-per-order index, or the id / (order, key) being taken.
        // Prisma puts the name of the index that was violated in the driver's error.
        const violated = JSON.stringify(error.meta ?? {});
        throw violated.includes(ONE_INITIATED_PER_ORDER)
          ? new PaymentInProgressError(payment.orderId)
          : new PaymentAlreadyExistsError(payment.id);
      }
      throw error;
    }
  }

  async attachCharge(
    paymentId: string,
    providerRef: string,
    payUrl: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE "Payment"
      SET "providerRef" = ${providerRef}, "payUrl" = ${payUrl}, "updatedAt" = ${DATABASE_NOW}
      WHERE "id" = ${paymentId} AND "status" = 'INITIATED' AND "providerRef" IS NULL`;
    return changed === 1;
  }

  async transition(
    paymentId: string,
    from: readonly PaymentStatus[],
    to: PaymentStatus,
    event: OutboxEventDraft | null,
    move: PaymentMove = {},
  ): Promise<Payment | null> {
    return this.prisma.$transaction(async (tx) => {
      const setPaid =
        move.paidAmount === undefined
          ? Prisma.empty
          : Prisma.sql`"paidAmount" = ${move.paidAmount}::numeric,`;
      const changed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "Payment"
        SET "status" = ${to}::"PaymentStatus",
            "version" = "version" + 1,
            ${setPaid}
            "updatedAt" = ${DATABASE_NOW}
        WHERE "id" = ${paymentId}
          AND "status" = ANY(${[...from]}::"PaymentStatus"[])
        RETURNING "id"`;
      if (changed.length === 0) return null;

      if (event) {
        await tx.outboxEvent.create({
          data: {
            id: event.id,
            type: event.type,
            aggregateId: event.aggregateId,
            payload: event.payload as Prisma.InputJsonValue,
          },
        });
      }
      const row = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      return PaymentMapper.toDomain(row);
    });
  }

  async findInitiatedForReconcile(
    olderThanSeconds: number,
    limit: number,
  ): Promise<InitiatedPayment[]> {
    const rows = await this.prisma.$queryRaw<
      { id: string; pastDeadline: boolean }[]
    >`
      SELECT "id", ("expiresAt" <= ${DATABASE_NOW}) AS "pastDeadline" FROM "Payment"
      WHERE "status" = 'INITIATED'
        AND "createdAt" <= ${DATABASE_NOW} - make_interval(secs => ${olderThanSeconds})
      ORDER BY "createdAt"
      LIMIT ${limit}`;
    return rows;
  }

  async findPaidButOrderStillPayingIds(
    olderThanSeconds: number,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p."id" FROM "Payment" p
      JOIN "Order" o ON o."id" = p."orderId"
      WHERE p."status" = 'SUCCEEDED' AND o."status" = 'PAYMENT_PROCESSING'
        AND p."updatedAt" <= ${DATABASE_NOW} - make_interval(secs => ${olderThanSeconds})
      ORDER BY p."updatedAt"
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async findRefundableIds(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p."id" FROM "Payment" p
      JOIN "Order" o ON o."id" = p."orderId"
      WHERE p."status" = 'REFUND_PENDING'
         OR (p."status" = 'SUCCEEDED' AND o."status" IN ('CANCELLED', 'EXPIRED'))
      ORDER BY p."updatedAt"
      LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async hasLivePayment(orderId: string): Promise<boolean> {
    const live = await this.prisma.payment.count({
      where: { orderId, status: { in: ['INITIATED', 'SUCCEEDED'] } },
      take: 1,
    });
    return live > 0;
  }
}

/** The handled-messages notebook, in Postgres. */
@Injectable()
export class PrismaInboxStore implements IInboxStore {
  constructor(private readonly prisma: PrismaService) {}

  async record(source: string, messageId: string): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "InboxMessage" ("source", "messageId")
      VALUES (${source}, ${messageId})
      ON CONFLICT DO NOTHING`;
    return inserted === 1;
  }

  async forget(source: string, messageId: string): Promise<void> {
    await this.prisma.inboxMessage.deleteMany({ where: { source, messageId } });
  }
}
