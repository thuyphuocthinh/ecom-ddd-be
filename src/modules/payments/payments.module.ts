import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import {
  ApplyPaymentResultHandler,
  FinishPaidPaymentHandler,
  FinishPaidPaymentsHandler,
  ListOrderPaymentsHandler,
  OrderStatusChangedListener,
  PaymentMaintenance,
  PaymentWebhookService,
  ReconcilePendingPaymentsHandler,
  RefundPaymentHandler,
  RefundPendingPaymentsHandler,
  ReopenStuckOrdersHandler,
  StartPaymentHandler,
} from './application/index.js';
import { PAYMENT_GATEWAY } from './domain/index.js';
import {
  PrismaInboxStore,
  PrismaPaymentRepository,
  createPaymentGateway,
} from './infrastructure/index.js';
import { paymentsConfig, type PaymentsConfig } from './payments.config.js';
import {
  DevFakeGatewayController,
  PaymentController,
  PaymentWebhookController,
} from './presentation/index.js';

const CommandHandlers = [
  StartPaymentHandler,
  ApplyPaymentResultHandler,
  FinishPaidPaymentHandler,
  RefundPaymentHandler,
  ReconcilePendingPaymentsHandler,
  FinishPaidPaymentsHandler,
  RefundPendingPaymentsHandler,
  ReopenStuckOrdersHandler,
];
const QueryHandlers = [ListOrderPaymentsHandler];

/**
 * Payments: paying an online order, what the payment gateway tells us back (webhooks), and sending
 * money back. It reaches orders and stock only through the command and query buses (the modules
 * are imported so their handlers exist). Which gateway is used comes from `PAYMENT_GATEWAY`, and
 * the rest of the module only knows the `IPaymentGateway` port. PrismaService, RedisService,
 * LockService and the event bus come from the global modules in AppModule.
 */
@Module({
  imports: [
    CqrsModule,
    ConfigModule.forFeature(paymentsConfig),
    OrdersModule, // the order commands and queries, through the buses
    InventoryModule, // ExtendReservation, through the command bus
  ],
  controllers: [
    PaymentController,
    PaymentWebhookController,
    DevFakeGatewayController,
  ],
  providers: [
    { provide: 'IPaymentRepository', useClass: PrismaPaymentRepository },
    { provide: 'IInboxStore', useClass: PrismaInboxStore },
    {
      provide: PAYMENT_GATEWAY,
      inject: [paymentsConfig.KEY],
      useFactory: (config: PaymentsConfig) => createPaymentGateway(config),
    },
    PaymentWebhookService,
    PaymentMaintenance,
    OrderStatusChangedListener,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
})
export class PaymentsModule {}
