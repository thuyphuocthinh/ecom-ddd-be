import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import {
  CACHE,
  DatabaseModule,
  EVENT_BUS,
  JobQueueModule,
  LockModule,
  PrismaService,
  RedisModule,
  RedisService,
} from '@/core/index.js';
import { CatalogMapper } from '../../catalog/infrastructure/database/mappers/catalog.mapper.js';
import { PrismaProductRepository } from '../../catalog/infrastructure/database/repositories/prisma-product.repository.js';
import { SkuLookupService } from '../../catalog/application/index.js';
import { EventBusModule } from '../../../core/infrastructure/messaging/events/event-bus.module.js';
import type { InMemoryEventBus } from '../../../core/infrastructure/messaging/events/in-memory-event-bus.js';
import { InventoryModule } from '../../inventory/inventory.module.js';
import { RedisCartStore } from '../../cart/infrastructure/index.js';
import { CartOrderingService } from '../../cart/application/index.js';
import { PrismaAddressRepository } from '../../users/infrastructure/database/prisma-address.repository.js';
import { GetAddressHandler } from '../../users/application/index.js';
import {
  OutboxPublisher,
  PrismaOrderRepository,
  PrismaOutboxStore,
} from '../../orders/infrastructure/index.js';
import {
  CancelOrderHandler,
  ConfirmOrderHandler,
  ExpireDueOrdersHandler,
  ExpireOrderHandler,
  FinishPendingCodOrdersHandler,
  GetOrderByIdHandler,
  GetOrderHandler,
  FindStuckPaymentOrdersHandler,
  OrderStockReturner,
  PlaceOrderCommand,
  PlaceOrderHandler,
  ReopenOrderHandler,
  ReturnStockForCancelledOrdersHandler,
  StartOrderPaymentHandler,
  type PlaceOrderResult,
} from '../../orders/application/index.js';
import { PaymentMethod } from '../../orders/domain/index.js';
import { ordersConfig } from '../../orders/orders.config.js';
import { PAYMENT_GATEWAY } from '../domain/index.js';
import {
  FakePaymentGateway,
  PrismaInboxStore,
  PrismaPaymentRepository,
} from '../infrastructure/index.js';
import {
  ApplyPaymentResultCommand,
  ApplyPaymentResultHandler,
  FinishPaidPaymentHandler,
  FinishPaidPaymentsHandler,
  OrderStatusChangedListener,
  PaymentMaintenance,
  ReconcilePendingPaymentsHandler,
  RefundPaymentHandler,
  RefundPendingPaymentsHandler,
  ReopenStuckOrdersHandler,
  StartPaymentCommand,
  StartPaymentHandler,
  type ApplyResult,
  type StartPaymentResult,
} from '../application/index.js';
import { paymentsConfig } from '../payments.config.js';

export const FLOW_USER = 'payflow_user_1';
export const OTHER_USER = 'payflow_user_2';
const USERS = [FLOW_USER, OTHER_USER];
export const FLOW_WINDOW_MINUTES = 30;
export const FLOW_SECRET = 'a-fake-gateway-secret-of-length';

/**
 * The payment flow with the REAL catalog, stock, cart, address book, orders and payments (Postgres
 * and Redis) and the fake gateway, put together once for the integration tests. Everything the tests
 * need to set up and to look at is here, so each test says only what it is about.
 */
export async function buildPaymentFlow(
  options: { windowMinutes?: number } = {},
) {
  const gateway = new FakePaymentGateway({ secret: FLOW_SECRET });
  const module: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
      RedisModule,
      LockModule,
      JobQueueModule,
      EventBusModule,
      CqrsModule,
      InventoryModule,
    ],
    providers: [
      CatalogMapper,
      { provide: 'IProductRepository', useClass: PrismaProductRepository },
      SkuLookupService,
      RedisCartStore,
      { provide: 'ICartStore', useExisting: RedisCartStore },
      CartOrderingService,
      { provide: 'IAddressRepository', useClass: PrismaAddressRepository },
      GetAddressHandler,
      PrismaOrderRepository,
      { provide: 'IOrderRepository', useExisting: PrismaOrderRepository },
      {
        provide: ordersConfig.KEY,
        useValue: {
          outboxIntervalMs: 0,
          outboxBatchSize: 50,
          maintenanceIntervalSeconds: 0,
        },
      },
      PrismaOutboxStore,
      { provide: 'IOutboxStore', useExisting: PrismaOutboxStore },
      OutboxPublisher,
      OrderStockReturner,
      PlaceOrderHandler,
      ConfirmOrderHandler,
      CancelOrderHandler,
      ExpireDueOrdersHandler,
      FinishPendingCodOrdersHandler,
      ReturnStockForCancelledOrdersHandler,
      GetOrderHandler,
      GetOrderByIdHandler,
      FindStuckPaymentOrdersHandler,
      StartOrderPaymentHandler,
      ReopenOrderHandler,
      ExpireOrderHandler,
      PrismaPaymentRepository,
      { provide: 'IPaymentRepository', useExisting: PrismaPaymentRepository },
      PrismaInboxStore,
      { provide: 'IInboxStore', useExisting: PrismaInboxStore },
      { provide: PAYMENT_GATEWAY, useValue: gateway },
      {
        provide: paymentsConfig.KEY,
        useValue: {
          gateway: 'fake',
          windowMinutes: options.windowMinutes ?? FLOW_WINDOW_MINUTES,
          maintenanceIntervalSeconds: 0,
          webhookToleranceSeconds: 300,
          fakeWebhookSecret: FLOW_SECRET,
        },
      },
      StartPaymentHandler,
      ApplyPaymentResultHandler,
      FinishPaidPaymentHandler,
      RefundPaymentHandler,
      ReconcilePendingPaymentsHandler,
      FinishPaidPaymentsHandler,
      RefundPendingPaymentsHandler,
      ReopenStuckOrdersHandler,
      PaymentMaintenance,
      OrderStatusChangedListener,
    ],
  }).compile();
  await module.init();

  const prisma = module.get(PrismaService);
  const redis = module.get(RedisService).getClient();
  const commands = module.get(CommandBus);
  const queries = module.get(QueryBus);
  const cartStore = module.get(RedisCartStore);
  const payments = module.get(PrismaPaymentRepository);
  const orders = module.get(PrismaOrderRepository);
  const inbox = module.get(PrismaInboxStore);
  const bus = module.get<InMemoryEventBus>(EVENT_BUS);
  const publisher = module.get(OutboxPublisher);
  const maintenance = module.get(PaymentMaintenance);

  let counter = 0;
  let addressId = '';

  const cleanRedis = async () => {
    for (const pattern of [
      'ecom:v1:cart:*',
      'ecom:v1:inventory:*',
      'ecom:v1:lock:*',
    ]) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
  };
  const cleanPostgres = async () => {
    await prisma.outboxEvent.deleteMany();
    await prisma.payment.deleteMany({
      where: { order: { userId: { in: USERS } } },
    });
    await prisma.order.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.address.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.inboxMessage.deleteMany({
      where: { source: { startsWith: 'webhook:' } },
    });
    await prisma.inboxMessage.deleteMany({
      where: { source: { startsWith: 'payments.' } },
    });
  };

  await prisma.province.upsert({
    where: { code: '97' },
    update: {},
    create: { code: '97', name: 'Tỉnh Thử Nghiệm', type: 'PROVINCE' },
  });
  await prisma.ward.upsert({
    where: { code: '97001' },
    update: {},
    create: {
      code: '97001',
      provinceCode: '97',
      name: 'Phường Thử Nghiệm',
      type: 'WARD',
    },
  });
  for (const id of USERS) {
    await prisma.user.upsert({ where: { id }, update: {}, create: { id } });
  }

  const flow = {
    module,
    prisma,
    redis,
    commands,
    queries,
    gateway,
    payments,
    orders,
    inbox,
    cartStore,
    bus,
    publisher,
    maintenance,

    /** Cleans everything and seeds one category, one product and one address for FLOW_USER. */
    async reset() {
      gateway.reset();
      bus.clear();
      await cleanRedis();
      await cleanPostgres();
      await prisma.category.create({
        data: { id: 'pay_cat', name: 'C', path: '/pay_cat/' },
      });
      await prisma.product.create({
        data: {
          id: 'pay_prod',
          categoryId: 'pay_cat',
          name: 'AirPods',
          status: 'PUBLISHED',
        },
      });
      addressId = `pay-address-${Date.now()}`;
      await prisma.address.create({
        data: {
          id: addressId,
          userId: FLOW_USER,
          recipientName: 'A',
          phone: '0901234567',
          provinceCode: '97',
          provinceName: 'Tỉnh Thử Nghiệm',
          wardCode: '97001',
          wardName: 'Phường Thử Nghiệm',
          street: '1 Đường Thử',
        },
      });
    },

    async close() {
      await cleanRedis();
      await cleanPostgres();
      await prisma.user.deleteMany({ where: { id: { in: USERS } } });
      await prisma.ward.deleteMany({ where: { code: '97001' } });
      await prisma.province.deleteMany({ where: { code: '97' } });
      await module.close();
    },

    /** Places an order of 3 units (50000 each, so it costs 150000) of its own SKU with 10 in stock. */
    async placed(method = PaymentMethod.ONLINE) {
      const n = ++counter;
      const skuId = `PAYFLOW_${n}`;
      await prisma.sku.create({
        data: {
          id: skuId,
          productId: 'pay_prod',
          price: 50000,
          attributes: { n: String(n) },
          skuCode: `CODE-${skuId}`,
        },
      });
      await prisma.skuStock.create({ data: { skuId, onHand: 10 } });
      await cartStore.add(FLOW_USER, skuId, 3, 50000);
      const { order } = await commands.execute<
        PlaceOrderCommand,
        PlaceOrderResult
      >(
        new PlaceOrderCommand(
          FLOW_USER,
          `pay-flow-key-${n}-xxxx`,
          addressId,
          method,
        ),
      );
      return { order, skuId };
    },

    pay(orderId: string, key = 'pay-attempt-0001', userId = FLOW_USER) {
      return commands.execute<StartPaymentCommand, StartPaymentResult>(
        new StartPaymentCommand(userId, orderId, key),
      );
    },

    /** An order placed and started to be paid: the state a webhook arrives in. */
    async paying() {
      const { order, skuId } = await flow.placed();
      const { payment } = await flow.pay(order.id);
      return { order, skuId, payment };
    },

    /**
     * What a verified webhook of this charge says. Like the real thing, the gateway agrees with what
     * it reports: it has the charge as paid (for the amount it says) or as failed. Pass `false` as
     * `gatewayAgrees` to report something the gateway itself does not know.
     */
    apply(
      providerRef: string,
      status: 'PAID' | 'FAILED',
      amount: number,
      eventId:
        | string
        | undefined = `evt-${++counter}-${Math.random().toString(36).slice(2)}`,
      gatewayAgrees = true,
    ) {
      if (gatewayAgrees) {
        try {
          if (status === 'PAID' && amount > 0)
            gateway.markPaid(providerRef, amount);
          else if (status === 'FAILED') gateway.markFailed(providerRef);
        } catch {
          // A charge the gateway does not have: the report is about something that is not ours
        }
      }
      return commands.execute<ApplyPaymentResultCommand, ApplyResult>(
        new ApplyPaymentResultCommand(
          'fake',
          providerRef,
          status,
          amount,
          eventId,
        ),
      );
    },

    async failureOf(promise: Promise<unknown>) {
      try {
        await promise;
      } catch (error: any) {
        return error.code as string;
      }
      throw new Error('should have failed');
    },

    orderOf: async (id: string) => (await orders.findById(id))!,
    paymentOf: async (id: string) => (await payments.findById(id))!,
    holds: (orderId: string) =>
      prisma.reservation.findMany({ where: { orderId } }),
    onHand: async (skuId: string) =>
      (await prisma.skuStock.findUniqueOrThrow({ where: { skuId } })).onHand,
    available: async (skuId: string) =>
      Number(await redis.get(CACHE.INVENTORY.KEYS.AVAILABLE(skuId))),
    eventsOf: async (aggregateId: string, type?: string) =>
      (
        await prisma.outboxEvent.findMany({
          where: { aggregateId, ...(type ? { type } : {}) },
          orderBy: { seq: 'asc' },
        })
      ).map((e) => e),
    orderChanges: async (orderId: string) =>
      (
        await prisma.outboxEvent.findMany({
          where: { aggregateId: orderId, type: 'order.status_changed' },
          orderBy: { seq: 'asc' },
        })
      ).map((e) => `${(e.payload as any).from}>${(e.payload as any).to}`),
    paymentEventTypes: async (paymentId: string) =>
      (
        await prisma.outboxEvent.findMany({
          where: { aggregateId: paymentId },
          orderBy: { seq: 'asc' },
        })
      ).map((e) => e.type),
    /** Sends what is waiting in the outbox to the bus (and so to the consumers on it). */
    publishOutbox: async () => {
      for (let round = 0; round < 5; round++) {
        const { sent } = await publisher.runOnce();
        if (sent === 0) return;
      }
    },
    /** Moves a time column of a payment far back, by the database clock. */
    setPaymentColumn: (paymentId: string, column: string, agoMs: number) =>
      prisma.$executeRawUnsafe(
        `UPDATE "Payment" SET "${column}" = (now() AT TIME ZONE 'UTC') - make_interval(secs => $1) WHERE "id" = $2`,
        agoMs / 1000,
        paymentId,
      ),
  };
  return flow;
}

export type PaymentFlow = Awaited<ReturnType<typeof buildPaymentFlow>>;
