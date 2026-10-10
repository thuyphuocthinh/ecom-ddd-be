import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CommandBus } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import {
  CACHE,
  DatabaseModule,
  LockModule,
  PrismaService,
  RabbitMQModule,
  RabbitMQService,
  RedisModule,
  RedisService,
} from '../src/core/index.js';
import { JobQueueModule } from '../src/core/infrastructure/messaging/jobs/job-queue.module.js';
import { JOB_QUEUE_OPTIONS } from '../src/core/infrastructure/messaging/jobs/job-queue.port.js';
import { InventoryModule } from '../src/modules/inventory/inventory.module.js';
import { inventoryConfig } from '../src/modules/inventory/inventory.config.js';
import {
  ConfirmReservationCommand,
  ReserveStockCommand,
} from '../src/modules/inventory/application/index.js';

/**
 * The give-back timer through the real RabbitMQ (docker-compose): the hold is made, a delayed
 * message waits in the delay queue, and when it arrives the units go back. Every run uses its own
 * namespace (its own exchange and queues, deleted at the end), so the real queues are never touched.
 */
const NAMESPACE = `e2e-inv-${randomUUID().slice(0, 8)}.`;
const RABBITMQ_URL =
  process.env.RABBITMQ_URL || 'amqp://admin:admin@localhost:5672';
const SKU = 'e2e_inv_sku';
const JOB = `${NAMESPACE}jobs.release-reservation`;
const QUEUES = [
  JOB,
  `${JOB}.delay.1000ms`,
  `${JOB}.retry.1.10000ms`,
  `${JOB}.retry.2.30000ms`,
  `${JOB}.retry.3.90000ms`,
  `${JOB}.dlq`,
];

const until = async (
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('Inventory give-back timer on RabbitMQ (e2e)', () => {
  const original = { ...process.env };
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let commands: CommandBus;
  let redis: ReturnType<RedisService['getClient']>;
  let admin: amqp.ChannelModel;
  let adminChannel: amqp.Channel;

  const availableInRedis = async () => {
    const value = await redis.get(CACHE.INVENTORY.KEYS.AVAILABLE(SKU));
    return value === null ? null : Number(value);
  };
  const statusOf = async (orderId: string) =>
    (await prisma.reservation.findMany({ where: { orderId } })).map(
      (row) => row.status,
    );
  const depth = async (queue: string) =>
    (await adminChannel.checkQueue(queue)).messageCount;
  /** The database clock can lag this machine's: make sure the hold has expired for the database too. */
  const expire = (orderId: string) =>
    prisma.reservation.updateMany({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 3_600_000) },
    });

  const clean = async () => {
    const keys = await redis.keys('ecom:v1:inventory:*');
    if (keys.length > 0) await redis.del(...keys);
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
  };

  beforeAll(async () => {
    process.env.JOB_QUEUE = 'rabbitmq';
    process.env.RABBITMQ_URL = RABBITMQ_URL;
    process.env.JWT_ACCESS_SECRET = 's'.repeat(32);
    Logger.overrideLogger(['error']);

    admin = await amqp.connect(RABBITMQ_URL);
    adminChannel = await admin.createChannel();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
        RedisModule,
        LockModule,
        RabbitMQModule,
        JobQueueModule,
        InventoryModule,
      ],
    })
      .overrideProvider(JOB_QUEUE_OPTIONS)
      .useValue({ namespace: NAMESPACE })
      .overrideProvider(inventoryConfig.KEY)
      // A 1 second hold, so the timer fires within the test
      .useValue({
        reservationTtlSeconds: 1,
        maintenanceIntervalSeconds: 0,
        inflightGraceSeconds: 120,
      })
      .compile();
    await moduleRef.init();
    await until(
      () => moduleRef.get(RabbitMQService).isConnected(),
      'the RabbitMQ connection',
    );

    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(RedisService).getClient();
    commands = moduleRef.get(CommandBus);
    await clean();
    await prisma.category.create({
      data: { id: 'e2e_inv_cat', name: 'E2E', path: '/e2e_inv_cat/' },
    });
    await prisma.product.create({
      data: { id: 'e2e_inv_prod', categoryId: 'e2e_inv_cat', name: 'E2E' },
    });
    await prisma.sku.create({
      data: {
        id: SKU,
        productId: 'e2e_inv_prod',
        price: 10,
        attributes: {},
        skuCode: 'E2E-INV',
      },
    });
    // Stock is put straight into Postgres (like scripts/seed-stock.sql); Redis builds its number from it
    await prisma.skuStock.create({ data: { skuId: SKU, onHand: 10 } });
  }, 30_000);

  afterAll(async () => {
    await clean();
    await moduleRef?.close();
    // Each deletion on a fresh channel: deleting something that does not exist closes the channel
    const remove = async (
      action: (channel: amqp.Channel) => Promise<unknown>,
    ) => {
      const channel = await admin.createChannel();
      await action(channel).catch(() => undefined);
      await channel.close().catch(() => undefined);
    };
    for (const queue of QUEUES) {
      await remove((channel) => channel.deleteQueue(queue));
    }
    await remove((channel) => channel.deleteExchange(`${NAMESPACE}jobs`));
    await admin.close().catch(() => undefined);
    process.env = { ...original };
  });

  it('puts the timer in the delay queue when the stock is held, then gives the units back when it fires (AC-14)', async () => {
    await commands.execute(
      new ReserveStockCommand('O1', [{ skuId: SKU, qty: 2 }]),
    );

    // Held, and the timer waits in the delay queue (not in the queue a worker listens to)
    expect(await availableInRedis()).toBe(8);
    expect(await statusOf('O1')).toEqual(['RESERVED']);
    expect(await depth(`${JOB}.delay.1000ms`)).toBe(1);
    expect(await depth(JOB)).toBe(0);

    await expire('O1');
    await until(
      async () => (await statusOf('O1'))[0] === 'RELEASED',
      'the timer to give the units back',
    );

    expect(await availableInRedis()).toBe(10);
    expect(await depth(`${JOB}.delay.1000ms`)).toBe(0);
    expect(await depth(`${JOB}.dlq`)).toBe(0);
  });

  it('leaves an order that was paid before its timer fired (AC-14)', async () => {
    await commands.execute(
      new ReserveStockCommand('O2', [{ skuId: SKU, qty: 3 }]),
    );
    await commands.execute(new ConfirmReservationCommand('O2'));
    await expire('O2'); // as if its time were up

    // Wait for the timer to have fired: the delay queue drains
    await until(
      async () => (await depth(`${JOB}.delay.1000ms`)) === 0,
      'the timer message to leave the delay queue',
    );
    await new Promise((resolve) => setTimeout(resolve, 500)); // and be handled

    expect(await statusOf('O2')).toEqual(['CONFIRMED']);
    expect(
      (await prisma.skuStock.findUniqueOrThrow({ where: { skuId: SKU } }))
        .onHand,
    ).toBe(7);
    expect(await availableInRedis()).toBe(7);
  });
});
