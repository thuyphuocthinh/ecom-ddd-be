import { Test, TestingModule } from '@nestjs/testing';
import { PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/core/index.js';

const USER = 'pay_schema_user';

/** The database protects the payment tables by itself (AC-17), whatever the code does. */
describe('Payment tables (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.user.upsert({
      where: { id: USER },
      update: {},
      create: { id: USER },
    });
  });

  const clean = async () => {
    await prisma.payment.deleteMany({ where: { order: { userId: USER } } });
    await prisma.order.deleteMany({ where: { userId: USER } });
    await prisma.inboxMessage.deleteMany({
      where: { source: { startsWith: 'schema-test' } },
    });
  };
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.$disconnect();
  });

  const makeOrder = async () => {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        userId: USER,
        idempotencyKey: `k-${id}`,
        paymentMethod: 'ONLINE',
        total: 150000,
        shippingAddress: {},
        expiresAt: new Date(Date.now() + 900_000),
      },
    });
    return id;
  };
  const makePayment = (
    orderId: string,
    overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
  ) =>
    prisma.payment.create({
      data: {
        id: randomUUID(),
        orderId,
        idempotencyKey: `pay-${randomUUID()}`,
        provider: 'fake',
        amount: 150000,
        expiresAt: new Date(Date.now() + 900_000),
        ...overrides,
      },
    });

  it('starts a payment INITIATED at version 1, with nothing collected and no charge yet', async () => {
    const orderId = await makeOrder();

    const payment = await makePayment(orderId);

    expect(payment).toMatchObject({
      status: PaymentStatus.INITIATED,
      version: 1,
      paidAmount: null,
      providerRef: null,
      payUrl: null,
    });
  });

  describe('one payment waiting for the gateway per order', () => {
    it('refuses a second INITIATED payment for the same order', async () => {
      const orderId = await makeOrder();
      await makePayment(orderId);

      await expect(makePayment(orderId)).rejects.toThrow();
      expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    });

    it('lets two requests that start a payment together in only one way: exactly one wins', async () => {
      const orderId = await makeOrder();

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => makePayment(orderId)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    });

    it.each([
      PaymentStatus.FAILED,
      PaymentStatus.EXPIRED,
      PaymentStatus.SUCCEEDED,
      PaymentStatus.REFUND_PENDING,
      PaymentStatus.REFUNDED,
    ])(
      'does not count a payment in %s: the order can have another one',
      async (status) => {
        const orderId = await makeOrder();
        await makePayment(orderId, { status });

        await expect(makePayment(orderId)).resolves.toBeDefined();
      },
    );

    it('lets the next one start once the first stops being INITIATED', async () => {
      const orderId = await makeOrder();
      const first = await makePayment(orderId);
      await expect(makePayment(orderId)).rejects.toThrow();

      await prisma.payment.update({
        where: { id: first.id },
        data: { status: 'FAILED' },
      });

      await expect(makePayment(orderId)).resolves.toBeDefined();
    });

    it('lets different orders each have their own', async () => {
      const a = await makeOrder();
      const b = await makeOrder();

      await makePayment(a);
      await expect(makePayment(b)).resolves.toBeDefined();
    });
  });

  it('refuses the same payment twice: (order, key) is unique', async () => {
    const orderId = await makeOrder();
    await makePayment(orderId, {
      idempotencyKey: 'same-key-0001',
      status: 'FAILED',
    });

    await expect(
      makePayment(orderId, {
        idempotencyKey: 'same-key-0001',
        status: 'FAILED',
      }),
    ).rejects.toThrow();
  });

  it('lets two orders use the same key', async () => {
    const a = await makeOrder();
    const b = await makeOrder();
    await makePayment(a, { idempotencyKey: 'same-key-0001' });

    await expect(
      makePayment(b, { idempotencyKey: 'same-key-0001' }),
    ).resolves.toBeDefined();
  });

  describe('the gateway reference', () => {
    it('is unique for a gateway', async () => {
      const a = await makeOrder();
      const b = await makeOrder();
      await makePayment(a, { providerRef: 'ref-1' });

      await expect(makePayment(b, { providerRef: 'ref-1' })).rejects.toThrow();
    });

    it('can be used by another gateway', async () => {
      const a = await makeOrder();
      const b = await makeOrder();
      await makePayment(a, { providerRef: 'ref-1', provider: 'fake' });

      await expect(
        makePayment(b, { providerRef: 'ref-1', provider: 'vnpay' }),
      ).resolves.toBeDefined();
    });

    it('may be missing on any number of payments (not asked of the gateway yet)', async () => {
      const a = await makeOrder();
      const b = await makeOrder();
      const c = await makeOrder();

      await makePayment(a);
      await makePayment(b);
      await expect(makePayment(c)).resolves.toBeDefined();
    });
  });

  describe('checks on the numbers', () => {
    it.each([0, -1])('refuses an amount of %s', async (amount) => {
      const orderId = await makeOrder();

      await expect(makePayment(orderId, { amount })).rejects.toThrow();
    });

    it.each([0, -5])('refuses a collected amount of %s', async (paidAmount) => {
      const orderId = await makeOrder();

      await expect(makePayment(orderId, { paidAmount })).rejects.toThrow();
    });

    it('accepts a collected amount that is more or less than the amount, as long as it is more than 0', async () => {
      const a = await makeOrder();
      const b = await makeOrder();

      await expect(
        makePayment(a, { paidAmount: 1, status: 'SUCCEEDED' }),
      ).resolves.toBeDefined();
      await expect(
        makePayment(b, { paidAmount: 999999, status: 'SUCCEEDED' }),
      ).resolves.toBeDefined();
    });

    it('refuses a version below 1', async () => {
      const orderId = await makeOrder();

      await expect(makePayment(orderId, { version: 0 })).rejects.toThrow();
    });

    it('holds an amount to the hundredth, and the biggest an order can cost', async () => {
      const orderId = await makeOrder();

      const payment = await makePayment(orderId, { amount: 9_999_999_999.99 });

      expect(Number(payment.amount)).toBe(9_999_999_999.99);
    });

    it('refuses a status that does not exist', async () => {
      const orderId = await makeOrder();

      await expect(
        makePayment(orderId, { status: 'PAID' as never }),
      ).rejects.toThrow();
    });
  });

  describe('the order it belongs to', () => {
    it('refuses a payment for an order that does not exist', async () => {
      await expect(makePayment(randomUUID())).rejects.toThrow();
    });

    it('does not let an order that has payments be deleted', async () => {
      const orderId = await makeOrder();
      await makePayment(orderId);

      await expect(
        prisma.order.delete({ where: { id: orderId } }),
      ).rejects.toThrow();
    });

    it('lets an order with no payments be deleted as before', async () => {
      const orderId = await makeOrder();

      await expect(
        prisma.order.delete({ where: { id: orderId } }),
      ).resolves.toBeDefined();
    });
  });

  describe('the inbox', () => {
    it('refuses a message of a source that is already noted, and accepts it for another source', async () => {
      await prisma.inboxMessage.create({
        data: { source: 'schema-test.a', messageId: 'm1' },
      });

      await expect(
        prisma.inboxMessage.create({
          data: { source: 'schema-test.a', messageId: 'm1' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.inboxMessage.create({
          data: { source: 'schema-test.b', messageId: 'm1' },
        }),
      ).resolves.toBeDefined();
      await expect(
        prisma.inboxMessage.create({
          data: { source: 'schema-test.a', messageId: 'm2' },
        }),
      ).resolves.toBeDefined();
    });

    it('noting the same message ten times at once keeps exactly one', async () => {
      const results = await Promise.allSettled(
        Array.from(
          { length: 10 },
          () =>
            prisma.$executeRaw`
            INSERT INTO "InboxMessage" ("source", "messageId") VALUES ('schema-test.race', 'm1')
            ON CONFLICT DO NOTHING`,
        ),
      );

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(
        (results as PromiseFulfilledResult<number>[]).reduce(
          (sum, r) => sum + r.value,
          0,
        ),
      ).toBe(1);
      expect(
        await prisma.inboxMessage.count({
          where: { source: 'schema-test.race' },
        }),
      ).toBe(1);
    });
  });
});
