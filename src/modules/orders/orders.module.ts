import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CartModule } from '../cart/cart.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  CancelOrderHandler,
  ConfirmOrderHandler,
  DeliverOrderHandler,
  ExpireDueOrdersHandler,
  FinishPendingCodOrdersHandler,
  GetOrderHandler,
  ListOrdersHandler,
  OrderMaintenance,
  OrderStockReturner,
  PlaceOrderHandler,
  ReturnStockForCancelledOrdersHandler,
  ShipOrderHandler,
  StartOrderPaymentHandler,
  ReopenOrderHandler,
  ExpireOrderHandler,
  FindStuckPaymentOrdersHandler,
  GetOrderByIdHandler,
  CountOrdersByStatusHandler,
  OrderStatusFeedListener,
  OrderStatusStreamService,
} from './application/index.js';
import {
  OutboxPublisher,
  PrismaOrderRepository,
  PrismaOutboxStore,
  RedisOrderStatusFeed,
} from './infrastructure/index.js';
import { ORDER_STATUS_FEED } from './domain/index.js';
import { ordersConfig } from './orders.config.js';
import { AdminOrderController, OrderController } from './presentation/index.js';

const CommandHandlers = [
  PlaceOrderHandler,
  ConfirmOrderHandler,
  CancelOrderHandler,
  ShipOrderHandler,
  DeliverOrderHandler,
  ExpireDueOrdersHandler,
  FinishPendingCodOrdersHandler,
  ReturnStockForCancelledOrdersHandler,
  StartOrderPaymentHandler,
  ReopenOrderHandler,
  ExpireOrderHandler,
];
const QueryHandlers = [
  GetOrderHandler,
  ListOrdersHandler,
  FindStuckPaymentOrdersHandler,
  GetOrderByIdHandler,
  CountOrdersByStatusHandler,
];

/**
 * Orders: placing them from the cart, their life (cancel, expiry, simulated delivery) and the
 * outbox that tells the rest of the system what happened. It reaches the other modules through the
 * services they export (the catalog's SKU lookup, the cart) and through the command and query
 * buses (inventory holds and confirms stock, the address book gives a snapshot). PrismaService,
 * RedisService, LockService and the event bus come from the global modules in AppModule.
 */
@Module({
  imports: [
    CqrsModule,
    ConfigModule.forFeature(ordersConfig),
    CatalogModule, // SkuLookupService
    CartModule, // CartOrderingService
    InventoryModule, // the stock commands, through the command bus
    UsersModule, // the address query, through the query bus
  ],
  controllers: [OrderController, AdminOrderController],
  providers: [
    { provide: 'IOrderRepository', useClass: PrismaOrderRepository },
    { provide: 'IOutboxStore', useClass: PrismaOutboxStore },
    { provide: ORDER_STATUS_FEED, useClass: RedisOrderStatusFeed },
    OrderStatusFeedListener,
    OrderStatusStreamService,
    OutboxPublisher,
    OrderStockReturner,
    OrderMaintenance,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
})
export class OrdersModule {}
