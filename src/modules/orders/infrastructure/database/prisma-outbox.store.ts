import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core/index.js';
import type {
  ClaimResult,
  IOutboxStore,
  OutboxRow,
} from '../../domain/index.js';

interface RawOutboxRow {
  id: string;
  seq: bigint;
  type: string;
  aggregateId: string;
  payload: unknown;
  createdAt: Date;
}

const DATABASE_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

// The transaction stays open while a batch is sent, so the default 5 seconds would cut it off
const BATCH_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * The events not sent yet. `FOR UPDATE SKIP LOCKED` is what lets two relays run at the same time:
 * each takes the rows nobody else holds, so they never work on the same event together. The rows
 * stay locked until the transaction ends. The sent events are marked inside that transaction; if
 * the process dies after sending but before the commit, the event is simply sent again (at least
 * once), which is why every event carries a stable id.
 *
 * This is the one place where a connection is held for longer than a few statements: for the time
 * it takes to send one batch.
 */
@Injectable()
export class PrismaOutboxStore implements IOutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  async claimBatch(
    limit: number,
    send: (row: OutboxRow) => Promise<void>,
  ): Promise<ClaimResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<RawOutboxRow[]>`
          SELECT "id", "seq", "type", "aggregateId", "payload", "createdAt"
          FROM "OutboxEvent"
          WHERE "publishedAt" IS NULL
          ORDER BY "seq"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`;

        let sent = 0;
        let failure: Error | null = null;
        for (const row of rows) {
          try {
            await send({
              id: row.id,
              seq: BigInt(row.seq),
              type: row.type,
              aggregateId: row.aggregateId,
              payload: row.payload,
              createdAt: row.createdAt,
            });
          } catch (error) {
            // This event and the ones after it stay unsent; the ones before it are marked below
            failure = error as Error;
            break;
          }
          await tx.$executeRaw`
            UPDATE "OutboxEvent" SET "publishedAt" = ${DATABASE_NOW} WHERE "id" = ${row.id}`;
          sent++;
        }
        return { sent, failure };
      },
      { timeout: BATCH_TRANSACTION_TIMEOUT_MS },
    );
  }
}
