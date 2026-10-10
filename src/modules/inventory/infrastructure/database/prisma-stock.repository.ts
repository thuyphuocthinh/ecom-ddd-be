import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/index.js';
import type { IStockRepository, StockSnapshot } from '../../domain/index.js';

@Injectable()
export class PrismaStockRepository implements IStockRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(skuId: string): Promise<StockSnapshot | null> {
    // One statement, so `onHand` and the held total come from the same consistent view of the data
    const rows = await this.prisma.$queryRaw<
      { onHand: number; reserved: bigint | number }[]
    >`
      SELECT s."onHand" AS "onHand",
             COALESCE((
               SELECT SUM(r."qty") FROM "Reservation" r
               WHERE r."skuId" = s."skuId" AND r."status" = 'RESERVED'
             ), 0) AS "reserved"
      FROM "SkuStock" s
      WHERE s."skuId" = ${skuId}`;
    if (rows.length === 0) return null;
    // SUM of an integer column is a bigint in Postgres
    return {
      onHand: Number(rows[0].onHand),
      reserved: Number(rows[0].reserved),
    };
  }
}
