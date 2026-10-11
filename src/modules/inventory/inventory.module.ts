import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { inventoryConfig, type InventoryConfig } from './inventory.config.js';
import {
  ReserveStockHandler,
  ConfirmReservationHandler,
  ReleaseReservationHandler,
  ReturnReservationHandler,
  ReleaseExpiredReservationHandler,
  ReleaseExpiredReservationsHandler,
  RepairInFlightHoldsHandler,
  StockRebuilder,
  StockAvailabilityService,
  ReservationReleaser,
  ReservationMaintenance,
  ReleaseReservationJobHandler,
  RELEASE_RESERVATION_JOB,
  createReleaseReservationJob,
} from './application/index.js';
import {
  PrismaReservationRepository,
  PrismaStockRepository,
  RedisAvailabilityStore,
} from './infrastructure/index.js';

const CommandHandlers = [
  ReserveStockHandler,
  ConfirmReservationHandler,
  ReleaseReservationHandler,
  ReturnReservationHandler,
  ReleaseExpiredReservationHandler,
  ReleaseExpiredReservationsHandler,
  RepairInFlightHoldsHandler,
];

/**
 * Stock: how many units of each SKU exist, how many are held for unpaid orders, and how many can
 * be sold now. No HTTP endpoints yet: the order module will call the commands through the
 * CommandBus, and the cart reads availability through the exported StockAvailabilityService. PrismaService, RedisService, LockService and the job queue come from the global
 * modules in AppModule.
 */
@Module({
  imports: [CqrsModule, ConfigModule.forFeature(inventoryConfig)],
  providers: [
    {
      provide: 'IReservationRepository',
      useClass: PrismaReservationRepository,
    },
    { provide: 'IStockRepository', useClass: PrismaStockRepository },
    { provide: 'IAvailabilityStore', useClass: RedisAvailabilityStore },
    {
      provide: RELEASE_RESERVATION_JOB,
      inject: [inventoryConfig.KEY],
      useFactory: (config: InventoryConfig) =>
        createReleaseReservationJob(config.reservationTtlSeconds),
    },
    StockRebuilder,
    StockAvailabilityService,
    ReservationReleaser,
    ReleaseReservationJobHandler,
    ReservationMaintenance,
    ...CommandHandlers,
  ],
  exports: [StockAvailabilityService], // the cart reads the stock of many SKUs at once with it
})
export class InventoryModule {}
