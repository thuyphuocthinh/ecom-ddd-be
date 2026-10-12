import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  RabbitMQService,
  EVENT_BUS,
} from './../src/core/index.js';
import {
  EVENT_BUS_OPTIONS,
  type IEventBus,
} from './../src/core/infrastructure/messaging/events/event-bus.port.js';
import { RabbitMqEventBus } from './../src/core/infrastructure/messaging/events/rabbitmq-event-bus.js';
import { SessionIssuer } from './../src/modules/auth/application/index.js';
import { OutboxPublisher } from './../src/modules/orders/infrastructure/index.js';
import { ordersConfig } from './../src/modules/orders/orders.config.js';
import { PaymentMaintenance } from './../src/modules/payments/application/index.js';
import { PAYMENT_GATEWAY } from './../src/modules/payments/domain/index.js';
import { FakePaymentGateway } from './../src/modules/payments/infrastructure/index.js';

/**
 * The refund-on-cancel consumer of the payment module on the real RabbitMQ: an order that was paid
 * is cancelled, the order's outbox publishes the event, RabbitMQ carries it to the consumer's own
 * queue, and the consumer sends the money back. Also what happens when the consumer fails (the
 * event goes to the dead-letter queue and the sweep refunds anyway). Every run uses its own
 * exchange and queues, deleted at the end.
 */
const NAMESPACE = `e2e-${randomUUID().slice(0, 8)}.`;
const EXCHANGE = `${NAMESPACE}events`;
const QUEUE = `${NAMESPACE}payments.order-events`;
const DEAD_QUEUE = `${QUEUE}.dead`;
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';
const API = '/api/v1';
const ORDERS = `${API}/orders`;
const CLIENT = { ip: '203.0.113.11', userAgent: 'e2e' };

const until = async (
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('Payments on RabbitMQ (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let issuer: SessionIssuer;
  let publisher: OutboxPublisher;
  let maintenance: PaymentMaintenance;
  let gateway: FakePaymentGateway;
  let admin: amqp.ChannelModel;
  let channel: amqp.Channel;
  const original = { ...process.env };

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
  const depth = async (queue: string) =>
    (await channel.checkQueue(queue)).messageCount;
  const paymentOf = async (orderId: string) =>
    prisma.payment.findFirstOrThrow({ where: { orderId } });
  const noted = () =>
    prisma.inboxMessage.count({ where: { source: 'payments.order-events' } });

  /** A paid (CONFIRMED) order of one P_S1, then cancelled by its customer. */
  const paidThenCancelled = async () => {
    const id = randomUUID();
    await prisma.user.create({ data: { id, role: 'CUSTOMER' } });
    const addressId = randomUUID();
    await prisma.address.create({
      data: {
        id: addressId,
        userId: id,
        recipientName: 'Nguyễn Văn A',
        phone: '0901234567',
        provinceCode: '97',
        provinceName: 'Tỉnh Thử Nghiệm',
        wardCode: '97001',
        wardName: 'Phường Thử Nghiệm',
        street: '12 Đường Thử',
      },
    });
    const { accessToken } = await issuer.start(
      { id, role: 'CUSTOMER', status: 'ACTIVE' },
      CLIENT,
    );
    await http()
      .post(`${API}/cart/items`)
      .set(authed(accessToken))
      .send({ skuId: 'PE_S1', quantity: 1 })
      .expect(201);
    const placed = await http()
      .post(ORDERS)
      .set(authed(accessToken))
      .set('Idempotency-Key', `order-${randomUUID()}`)
      .send({ addressId, paymentMethod: 'ONLINE' })
      .expect(201);
    const orderId = placed.body.data.id as string;
    const started = await http()
      .post(`${ORDERS}/${orderId}/payments`)
      .set(authed(accessToken))
      .set('Idempotency-Key', `pay-${randomUUID()}`)
      .expect(201);
    await http()
      .post(`${API}${started.body.data.payUrl}/pay`)
      .set(authed(accessToken))
      .expect(200);
    expect((await paymentOf(orderId)).status).toBe('SUCCEEDED');
    await http()
      .post(`${ORDERS}/${orderId}/cancel`)
      .set(authed(accessToken))
      .expect(200);
    return orderId;
  };

  const clear = async () => {
    await redis.getClient().flushdb();
    await prisma.inboxMessage.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.order.deleteMany();
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.address.deleteMany();
    await prisma.session.deleteMany();
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
  };

  beforeAll(async () => {
    process.env.JOB_QUEUE = 'rabbitmq';
    process.env.RABBITMQ_URL = RABBITMQ_URL;
    admin = await amqp.connect(RABBITMQ_URL);
    channel = await admin.createChannel();

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EVENT_BUS_OPTIONS)
      .useValue({ namespace: NAMESPACE })
      .overrideProvider(ordersConfig.KEY)
      .useValue({
        outboxIntervalMs: 0,
        outboxBatchSize: 50,
        maintenanceIntervalSeconds: 0,
      })
      .compile();
    app = module.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(app.get(ClsService)));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix(API.replace('/', ''));
    await app.init();
    await until(
      () => app.get(RabbitMQService).isConnected(),
      'the RabbitMQ connection',
    );
    expect(app.get<IEventBus>(EVENT_BUS)).toBeInstanceOf(RabbitMqEventBus);
    // The consumer's queue is made when the connection is up
    await until(async () => {
      const probe = await admin.createChannel();
      probe.on('error', () => undefined);
      try {
        await probe.checkQueue(QUEUE);
        return true;
      } catch {
        return false;
      } finally {
        await probe.close().catch(() => undefined);
      }
    }, 'the queue of the payment consumer');

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    issuer = app.get(SessionIssuer);
    publisher = app.get(OutboxPublisher);
    maintenance = app.get(PaymentMaintenance);
    gateway = app.get<FakePaymentGateway>(PAYMENT_GATEWAY);

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
  }, 60_000);

  beforeEach(async () => {
    await clear();
    gateway.reset();
    await channel.purgeQueue(DEAD_QUEUE).catch(() => undefined);
    await prisma.category.create({
      data: { id: 'pay_ev_cat', name: 'C', path: '/pay_ev_cat/' },
    });
    await prisma.product.create({
      data: {
        id: 'PE_ON',
        categoryId: 'pay_ev_cat',
        name: 'AirPods',
        status: 'PUBLISHED',
      },
    });
    await prisma.sku.create({
      data: {
        id: 'PE_S1',
        productId: 'PE_ON',
        price: 3990000,
        attributes: { color: 'PE_S1' },
        skuCode: 'PE_S1-C',
      },
    });
    await prisma.skuStock.create({ data: { skuId: 'PE_S1', onHand: 50 } });
  });

  afterAll(async () => {
    await clear();
    await prisma.ward.deleteMany({ where: { code: '97001' } });
    await prisma.province.deleteMany({ where: { code: '97' } });
    await app.close(); // the consumer stops first, so its queues can be deleted
    for (const queue of [QUEUE, DEAD_QUEUE]) {
      await channel.deleteQueue(queue).catch(() => undefined);
    }
    const probe = await admin.createChannel();
    probe.on('error', () => undefined);
    await probe.deleteExchange(EXCHANGE).catch(() => undefined);
    await admin.close().catch(() => undefined);
    process.env = original;
  });

  it('a cancelled paid order: the event travels through RabbitMQ and the consumer sends the money back, once (AC-14)', async () => {
    const orderId = await paidThenCancelled();
    expect((await paymentOf(orderId)).status).toBe('SUCCEEDED');

    await publisher.runOnce();

    await until(
      async () => (await paymentOf(orderId)).status === 'REFUNDED',
      'the refund',
    );
    expect(gateway.refundCount).toBe(1);
    expect(await noted()).toBe(1);
    await until(async () => (await depth(QUEUE)) === 0, 'the queue to empty');
    expect(await depth(DEAD_QUEUE)).toBe(0);
  });

  it('the same event published again changes nothing: one refund, one note in the inbox', async () => {
    const orderId = await paidThenCancelled();
    await publisher.runOnce();
    await until(
      async () => (await paymentOf(orderId)).status === 'REFUNDED',
      'the refund',
    );
    const cancelled = (await prisma.outboxEvent.findMany()).find(
      (e) =>
        e.type === 'order.status_changed' &&
        (e.payload as { to?: string }).to === 'CANCELLED',
    )!;
    const bus = app.get<IEventBus>(EVENT_BUS);

    await bus.publish({
      id: cancelled.id,
      name: cancelled.type,
      occurredAt: new Date(),
      data: cancelled.payload,
    });
    await bus.publish({
      id: cancelled.id,
      name: cancelled.type,
      occurredAt: new Date(),
      data: cancelled.payload,
    });
    await until(async () => (await depth(QUEUE)) === 0, 'the queue to empty');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(gateway.refundCount).toBe(1);
    expect(await noted()).toBe(1);
  });

  it('when the consumer fails, the event goes to the dead-letter queue, and the sweep still sends the money back', async () => {
    const orderId = await paidThenCancelled();
    vi.spyOn(gateway, 'refund').mockRejectedValueOnce(
      new Error('a bug in the adapter'),
    );

    await publisher.runOnce();

    await until(
      async () => (await depth(DEAD_QUEUE)) === 1,
      'the event in the dead-letter queue',
    );
    expect((await paymentOf(orderId)).status).toBe('REFUND_PENDING');
    expect(await noted()).toBe(0);

    await maintenance.runOnce();

    expect((await paymentOf(orderId)).status).toBe('REFUNDED');
    expect(gateway.refundCount).toBe(1);
  });

  it('with the consumer down, the event waits in its queue; the sweep refunds without it', async () => {
    const orderId = await paidThenCancelled();
    // The event is never published (the consumer, the bus, RabbitMQ: whichever is down)

    await maintenance.runOnce();

    expect((await paymentOf(orderId)).status).toBe('REFUNDED');
    expect(gateway.refundCount).toBe(1);
    // Published late, the event finds the payment already refunded and does nothing more
    await publisher.runOnce();
    await until(async () => (await depth(QUEUE)) === 0, 'the queue to empty');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gateway.refundCount).toBe(1);
  });
});
