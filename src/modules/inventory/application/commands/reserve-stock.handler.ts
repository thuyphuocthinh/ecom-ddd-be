import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import {
  InventoryErrorCodes,
  JOB_QUEUE,
  type IJobQueue,
  type JobDefinition,
} from '@/core/index.js';
import {
  InventoryDomainException,
  Reservation,
  ReservationAlreadyExistsError,
  ReservationStatus,
  type IAvailabilityStore,
  type IReservationRepository,
  type Shortage,
  type StockItem,
} from '../../domain/index.js';
import {
  inventoryConfig,
  type InventoryConfig,
} from '../../inventory.config.js';
import { StockRebuilder } from '../services/stock-rebuilder.service.js';
import {
  RELEASE_RESERVATION_JOB,
  type ReleaseReservationJobData,
} from '../jobs/release-reservation.job.js';
import { ReserveStockCommand } from './reserve-stock.command.js';

// Each pass asks Redis once; a pass is repeated only after rebuilding numbers Redis had lost
const MAX_HOLD_PASSES = 3;

export interface ReserveStockResult {
  orderId: string;
  expiresAt: Date;
  items: StockItem[];
}

/**
 * Holds the units of a whole order. The order of work is what keeps it safe:
 *
 *  1. Read Postgres: an order that already has its lines is a retry; answer it from there.
 *  2. Redis (one Lua step): take every item or nothing. This is where buyers compete.
 *  3. Postgres: write the lines. If that fails, give the units back in Redis.
 *  4. Forget the "being held" record, and set the timer that gives the units back.
 *
 * A process that dies between 2 and 3 leaves units taken in Redis with no line in Postgres; the
 * repair job finds them through the "being held" record left behind by step 2.
 */
@CommandHandler(ReserveStockCommand)
export class ReserveStockHandler implements ICommandHandler<
  ReserveStockCommand,
  ReserveStockResult
> {
  private readonly logger = new Logger(ReserveStockHandler.name);

  constructor(
    @Inject('IReservationRepository')
    private readonly reservationRepo: IReservationRepository,
    @Inject('IAvailabilityStore') private readonly store: IAvailabilityStore,
    private readonly rebuilder: StockRebuilder,
    @Inject(JOB_QUEUE) private readonly jobs: IJobQueue,
    @Inject(RELEASE_RESERVATION_JOB)
    private readonly releaseJob: JobDefinition<ReleaseReservationJobData>,
    @Inject(inventoryConfig.KEY) private readonly config: InventoryConfig,
  ) {}

  async execute(command: ReserveStockCommand): Promise<ReserveStockResult> {
    const reservation = Reservation.create(
      command.orderId,
      command.items,
      new Date(),
      this.config.reservationTtlSeconds,
    );

    // 1. A retry of an order that is already saved is answered without touching Redis
    const existing = await this.reservationRepo.findByOrderId(
      reservation.orderId,
    );
    if (existing) return this.answerForExisting(existing, reservation);

    // 2. Redis
    for (let pass = 1; pass <= MAX_HOLD_PASSES; pass++) {
      const result = await this.store.hold(
        reservation.orderId,
        reservation.fingerprint(),
        reservation.items,
      );

      switch (result.kind) {
        case 'HELD':
          return this.save(reservation);
        case 'IN_PROGRESS':
          throw new InventoryDomainException(
            InventoryErrorCodes.RESERVATION_IN_PROGRESS,
          );
        case 'SHORT':
          throw InventoryDomainException.outOfStock(result.shortages);
        case 'MISSING': {
          // Redis lost these numbers: that is not "sold out". Rebuild them, then ask again.
          const withoutStock = await this.rebuilder.rebuild(result.skuIds);
          if (withoutStock.length > 0) {
            throw await this.soldOutBecauseNoStock(
              reservation.items,
              withoutStock,
            );
          }
        }
      }
    }

    this.logger.error(
      `Order ${reservation.orderId}: Redis kept losing the numbers after ${MAX_HOLD_PASSES} passes`,
    );
    throw new InventoryDomainException(InventoryErrorCodes.STOCK_UNAVAILABLE);
  }

  /** 3 and 4: the units are taken in Redis; make that permanent in Postgres. */
  private async save(reservation: Reservation): Promise<ReserveStockResult> {
    try {
      await this.reservationRepo.create(reservation);
    } catch (error) {
      await this.giveBackAfterFailure(reservation);
      if (error instanceof ReservationAlreadyExistsError) {
        // Another request saved this order first (the "being held" record can be lost with
        // Redis). Our own units are back; answer like the retry we are.
        const saved = await this.reservationRepo.findByOrderId(
          reservation.orderId,
        );
        if (saved) return this.answerForExisting(saved, reservation);
      }
      this.logger.error(
        `Order ${reservation.orderId}: could not save the reservation: ${(error as Error).message}`,
      );
      throw new InventoryDomainException(InventoryErrorCodes.STOCK_UNAVAILABLE);
    }

    // The reservation is saved. From here nothing may turn the answer into a failure.
    try {
      await this.store.finishHold(reservation.orderId);
    } catch (error) {
      // The record stays; the repair job sees the line in Postgres and only clears it
      this.logger.warn(
        `Order ${reservation.orderId}: could not clear the being-held record: ${(error as Error).message}`,
      );
    }
    try {
      await this.jobs.enqueue(this.releaseJob, {
        orderId: reservation.orderId,
      });
    } catch (error) {
      // No timer: the periodic sweep gives the units back once the hold has expired
      this.logger.warn(
        `Order ${reservation.orderId}: could not set the give-back timer (the sweep will do it): ${(error as Error).message}`,
      );
    }

    return {
      orderId: reservation.orderId,
      expiresAt: reservation.expiresAt,
      items: reservation.items,
    };
  }

  private async giveBackAfterFailure(reservation: Reservation): Promise<void> {
    try {
      await this.store.undoHold(reservation.orderId, reservation.items);
    } catch (error) {
      // Redis is the problem too: the repair job returns the units when it is back
      this.logger.error(
        `Order ${reservation.orderId}: could not give the units back in Redis: ${(error as Error).message}`,
      );
    }
  }

  /** The order already has lines in Postgres: a retry, a different request, or a dead order. */
  private answerForExisting(
    existing: Reservation,
    requested: Reservation,
  ): ReserveStockResult {
    if (
      existing.status === ReservationStatus.RELEASED ||
      existing.status === ReservationStatus.RETURNED
    ) {
      throw new InventoryDomainException(
        InventoryErrorCodes.RESERVATION_RELEASED,
      );
    }
    if (!existing.hasSameContentAs(requested.items)) {
      throw new InventoryDomainException(
        InventoryErrorCodes.RESERVATION_CONFLICT,
      );
    }
    return {
      orderId: existing.orderId,
      expiresAt: existing.expiresAt,
      items: existing.items,
    };
  }

  /**
   * Some SKUs have no stock row at all, so the order cannot be filled. Say so for them, and also
   * for the others that are short, so the caller sees every problem in one answer.
   */
  private async soldOutBecauseNoStock(
    items: StockItem[],
    withoutStock: string[],
  ): Promise<InventoryDomainException> {
    const shortages: Shortage[] = items
      .filter((item) => withoutStock.includes(item.skuId))
      .map((item) => ({
        skuId: item.skuId,
        requested: item.qty,
        available: 0,
      }));

    const others = items.filter((item) => !withoutStock.includes(item.skuId));
    const numbers = await this.store.peek(others.map((item) => item.skuId));
    for (const item of others) {
      const have = numbers.get(item.skuId);
      if (have !== null && have !== undefined && have < item.qty) {
        shortages.push({
          skuId: item.skuId,
          requested: item.qty,
          available: have,
        });
      }
    }
    return InventoryDomainException.outOfStock(shortages);
  }
}
