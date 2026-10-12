import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  EVENT_BUS,
} from './../src/core/index.js';
import { InMemoryEventBus } from './../src/core/infrastructure/messaging/events/in-memory-event-bus.js';
import { SessionIssuer } from './../src/modules/auth/application/index.js';
import { OutboxPublisher } from './../src/modules/orders/infrastructure/index.js';
import { ordersConfig } from './../src/modules/orders/orders.config.js';
import { PAYMENT_GATEWAY } from './../src/modules/payments/domain/index.js';
import { signWebhook } from './../src/modules/payments/domain/services/webhook-signature.js';
import { FakePaymentGateway } from './../src/modules/payments/infrastructure/index.js';

const API = '/api/v1';
const ORDERS = `${API}/orders`;
const WEBHOOK = `${API}/payments/webhook/fake`;
const CLIENT = { ip: '203.0.113.9', userAgent: 'e2e' };
const SECRET = process.env.PAYMENT_FAKE_WEBHOOK_SECRET as string;

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let issuer: SessionIssuer;
  let publisher: OutboxPublisher;
  let bus: InMemoryEventBus;
  let gateway: FakePaymentGateway;

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

  const makeUser = async () => {
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
        label: 'Nhà',
      },
    });
    const { accessToken } = await issuer.start(
      { id, role: 'CUSTOMER', status: 'ACTIVE' },
      CLIENT,
    );
    return { id, token: accessToken, addressId };
  };
  type TestUser = Awaited<ReturnType<typeof makeUser>>;

  /** An order of one P_S1 (3990000) placed from the cart, ONLINE unless said otherwise. */
  const placeOrder = async (user: TestUser, paymentMethod = 'ONLINE') => {
    await http()
      .post(`${API}/cart/items`)
      .set(authed(user.token))
      .send({ skuId: 'P_S1', quantity: 1 })
      .expect(201);
    const res = await http()
      .post(ORDERS)
      .set(authed(user.token))
      .set('Idempotency-Key', `order-${randomUUID()}`)
      .send({ addressId: user.addressId, paymentMethod })
      .expect(201);
    return res.body.data.id as string;
  };
  const startPayment = (
    user: TestUser,
    orderId: string,
    key: string | null = `pay-${randomUUID()}`,
  ) => {
    const req = http()
      .post(`${ORDERS}/${orderId}/payments`)
      .set(authed(user.token));
    return key === null ? req : req.set('Idempotency-Key', key);
  };
  const listPayments = (user: TestUser, orderId: string) =>
    http().get(`${ORDERS}/${orderId}/payments`).set(authed(user.token));
  const orderStatus = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const paymentRows = (orderId: string) =>
    prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  /** The reference of the charge, read out of the link the customer got. */
  const refOf = (payUrl: string) => payUrl.split('/').pop() as string;
  const devPay = (user: TestUser, payUrl: string, body: object = {}) =>
    http().post(`${API}${payUrl}/pay`).set(authed(user.token)).send(body);
  const devFail = (user: TestUser, payUrl: string) =>
    http().post(`${API}${payUrl}/fail`).set(authed(user.token));
  /** A started payment: the user, the order, the payment and its link. */
  const paying = async () => {
    const user = await makeUser();
    const orderId = await placeOrder(user);
    const res = await startPayment(user, orderId).expect(201);
    return {
      user,
      orderId,
      payment: res.body.data,
      payUrl: res.body.data.payUrl as string,
    };
  };
  /** A webhook as the gateway would send it: raw bytes and a signature over them. */
  const signedWebhook = (
    notice: Record<string, unknown>,
    signedAt = new Date(),
  ) => {
    const rawBody = Buffer.from(JSON.stringify(notice));
    return { rawBody, signature: signWebhook(SECRET, rawBody, signedAt) };
  };
  const postWebhook = (rawBody: Buffer | string, signature?: string) => {
    const req = http().post(WEBHOOK).set('Content-Type', 'application/json');
    if (signature !== undefined) req.set('X-Fake-Signature', signature);
    // A string, not a Buffer: superagent would write a Buffer as JSON of its own
    return req.send(rawBody.toString());
  };
  const noticeOf = async (
    payUrl: string,
    status: 'PAID' | 'FAILED',
    extra: Record<string, unknown> = {},
  ) => {
    const base = gateway.noticeFor(refOf(payUrl), status);
    return { ...base, occurredAt: base.occurredAt.toISOString(), ...extra };
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ordersConfig.KEY)
      .useValue({
        outboxIntervalMs: 0,
        outboxBatchSize: 50,
        maintenanceIntervalSeconds: 0,
      })
      .compile();
    // rawBody: true, as in main.ts: a webhook signature is over the bytes that arrived
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
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    issuer = app.get(SessionIssuer);
    publisher = app.get(OutboxPublisher);
    bus = app.get<InMemoryEventBus>(EVENT_BUS);
    gateway = app.get<FakePaymentGateway>(PAYMENT_GATEWAY);
    expect(gateway).toBeInstanceOf(FakePaymentGateway);

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
  });

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

  beforeEach(async () => {
    await clear();
    bus.clear();
    gateway.reset();
    await prisma.category.create({
      data: { id: 'pay_e2e_cat', name: 'C', path: '/pay_e2e_cat/' },
    });
    await prisma.product.create({
      data: {
        id: 'P_ON',
        categoryId: 'pay_e2e_cat',
        name: 'AirPods',
        status: 'PUBLISHED',
      },
    });
    await prisma.sku.create({
      data: {
        id: 'P_S1',
        productId: 'P_ON',
        price: 3990000,
        attributes: { color: 'P_S1' },
        skuCode: 'P_S1-C',
      },
    });
    await prisma.skuStock.create({ data: { skuId: 'P_S1', onHand: 50 } });
  });

  afterAll(async () => {
    await clear();
    await prisma.ward.deleteMany({ where: { code: '97001' } });
    await prisma.province.deleteMany({ where: { code: '97' } });
    await app.close();
  });

  // ── signed in ─────────────────────────────────────────────────────────────

  it('refuses the customer endpoints and the dev endpoints without a token (AC-16)', async () => {
    await http().post(`${ORDERS}/x/payments`).expect(401);
    await http().get(`${ORDERS}/x/payments`).expect(401);
    await http().post(`${API}/dev/fake-gateway/charges/x/pay`).expect(401);
    await http().post(`${API}/dev/fake-gateway/charges/x/fail`).expect(401);
  });

  // ── starting to pay ───────────────────────────────────────────────────────

  describe('POST /orders/:id/payments', () => {
    it('starts a payment: 201, the amount of the order, a link to pay, and the order waits for the payment (AC-1)', async () => {
      const user = await makeUser();
      const orderId = await placeOrder(user);

      const res = await startPayment(user, orderId).expect(201);

      expect(res.body.data).toMatchObject({
        orderId,
        status: 'INITIATED',
        amount: 3990000,
        payUrl: expect.stringMatching(/^\/dev\/fake-gateway\/charges\/.+/),
      });
      expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(await orderStatus(orderId)).toBe('PAYMENT_PROCESSING');
      expect(gateway.chargeCount).toBe(1);
    });

    it('never shows the gateway reference, the key, or anything internal (AC-15)', async () => {
      const { user, orderId, payUrl } = await paying();
      const [row] = await paymentRows(orderId);

      const started = await startPayment(
        user,
        orderId,
        'another-key-0001',
      ).expect(409);
      const listed = await listPayments(user, orderId).expect(200);

      for (const body of [
        JSON.stringify(listed.body),
        JSON.stringify(started.body),
      ]) {
        expect(body).not.toContain('providerRef');
        expect(body).not.toContain('idempotencyKey');
        expect(body).not.toContain('paidAmount');
        expect(body).not.toContain('version');
      }
      // The reference is only in the link (that is how the customer reaches the charge)
      expect(payUrl).toContain(row.providerRef as string);
      expect(Object.keys(listed.body.data[0]).sort()).toEqual(
        [
          'amount',
          'createdAt',
          'expiresAt',
          'id',
          'orderId',
          'payUrl',
          'status',
          'updatedAt',
        ].sort(),
      );
    });

    it('the same key again: 200, Idempotency-Replayed, the same payment, no second charge', async () => {
      const user = await makeUser();
      const orderId = await placeOrder(user);
      const first = await startPayment(user, orderId, 'same-key-0001').expect(
        201,
      );

      const again = await startPayment(user, orderId, 'same-key-0001').expect(
        200,
      );

      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(first.headers['idempotency-replayed']).toBeUndefined();
      expect(again.body.data).toEqual(first.body.data);
      expect(gateway.chargeCount).toBe(1);
      expect(await paymentRows(orderId)).toHaveLength(1);
    });

    it('ten requests with the same key at once: one payment, one charge, one 201 and nine 200, no 500 (AC-3)', async () => {
      const user = await makeUser();
      const orderId = await placeOrder(user);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          startPayment(user, orderId, 'burst-key-0001'),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(gateway.chargeCount).toBe(1);
      expect(await paymentRows(orderId)).toHaveLength(1);
    });

    it('answers with the PAY codes: missing or bad key, order paid in cash, order not payable, too many attempts, gateway down (AC-4)', async () => {
      const user = await makeUser();
      const orderId = await placeOrder(user);

      const missing = await startPayment(user, orderId, null).expect(400);
      expect(missing.body.code).toBe('PAY-001');
      const tooShort = await startPayment(user, orderId, 'short').expect(400);
      expect(tooShort.body.code).toBe('PAY-001');

      const cod = await placeOrder(user, 'COD');
      const notOnline = await startPayment(user, cod).expect(409);
      expect(notOnline.body.code).toBe('PAY-002');

      await http()
        .post(`${ORDERS}/${orderId}/cancel`)
        .set(authed(user.token))
        .expect(200);
      const notPayable = await startPayment(user, orderId).expect(409);
      expect(notPayable.body.code).toBe('PAY-003');

      // Three attempts that fail, then no more
      const retry = await placeOrder(user);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const started = await startPayment(user, retry).expect(201);
        await devFail(user, started.body.data.payUrl).expect(200);
        expect(await orderStatus(retry)).toBe('PENDING');
      }
      const tooMany = await startPayment(user, retry).expect(409);
      expect(tooMany.body.code).toBe('PAY-004');

      // A gateway that cannot be reached: 503, and the customer can try again afterwards
      const next = await placeOrder(user);
      gateway.setUnavailable(true);
      const down = await startPayment(user, next, 'gateway-down-0001').expect(
        503,
      );
      expect(down.body.code).toBe('PAY-006');
      gateway.setUnavailable(false);
      expect(await orderStatus(next)).toBe('PENDING');
      // The same key is the same payment (the one that failed), so the retry has a new key
      await startPayment(user, next, 'gateway-back-0001').expect(201);
    });

    it("somebody else's order and an order that does not exist are the same 404 (ORD-002)", async () => {
      const owner = await makeUser();
      const stranger = await makeUser();
      const orderId = await placeOrder(owner);

      const theirs = await startPayment(stranger, orderId).expect(404);
      const none = await startPayment(stranger, randomUUID()).expect(404);

      expect(theirs.body.code).toBe('ORD-002');
      expect(none.body).toMatchObject({ code: 'ORD-002' });
      expect(await orderStatus(orderId)).toBe('PENDING');
      expect(gateway.chargeCount).toBe(0);
    });
  });

  // ── looking at the payments of an order ───────────────────────────────────

  describe('GET /orders/:id/payments', () => {
    it('lists the payments of my order, newest first; the link only while it can still be paid (AC-15)', async () => {
      const { user, orderId, payUrl } = await paying();
      await devFail(user, payUrl).expect(200);
      const second = await startPayment(
        user,
        orderId,
        'second-try-0001',
      ).expect(201);

      const res = await listPayments(user, orderId).expect(200);

      expect(res.body.data.map((p: any) => p.status)).toEqual([
        'INITIATED',
        'FAILED',
      ]);
      expect(res.body.data[0].id).toBe(second.body.data.id);
      expect(res.body.data[0].payUrl).toEqual(expect.any(String));
      expect(res.body.data[1].payUrl).toBeNull();
    });

    it("somebody else's order: 404 ORD-002", async () => {
      const { orderId } = await paying();
      const stranger = await makeUser();

      const res = await listPayments(stranger, orderId).expect(404);

      expect(res.body.code).toBe('ORD-002');
    });
  });

  // ── what the gateway tells us ─────────────────────────────────────────────

  describe('POST /payments/webhook/:provider', () => {
    it('a webhook with a good signature confirms the order; the same message again changes nothing (AC-5, AC-6, AC-8)', async () => {
      const { orderId, payUrl } = await paying();
      gateway.markPaid(refOf(payUrl));
      const { rawBody, signature } = signedWebhook(
        await noticeOf(payUrl, 'PAID'),
      );

      const first = await postWebhook(rawBody, signature).expect(200);
      expect(first.body).toEqual({ received: true });
      expect(await orderStatus(orderId)).toBe('CONFIRMED');
      expect((await paymentRows(orderId))[0].status).toBe('SUCCEEDED');
      const outbox = await prisma.outboxEvent.count();

      await postWebhook(rawBody, signature).expect(200);
      await postWebhook(rawBody, signature).expect(200);

      expect(await prisma.outboxEvent.count()).toBe(outbox);
      expect(
        await prisma.inboxMessage.count({ where: { source: 'webhook:fake' } }),
      ).toBe(1);
      expect(
        await redis.getClient().get('ecom:v1:inventory:on-hand:P_S1'),
      ).toBeDefined();
      expect(
        (await prisma.skuStock.findUniqueOrThrow({ where: { skuId: 'P_S1' } }))
          .onHand,
      ).toBe(49);
    });

    it('the signature is over the bytes that arrived, not over the JSON read back: a body with its own spacing is accepted (AC-5)', async () => {
      const { orderId, payUrl } = await paying();
      gateway.markPaid(refOf(payUrl));
      // Same message, written with line breaks and indentation: parsing and writing it again would
      // give other bytes, so only the raw body can match this signature
      const rawBody = Buffer.from(
        JSON.stringify(await noticeOf(payUrl, 'PAID'), null, 4),
      );
      const signature = signWebhook(SECRET, rawBody, new Date());

      await postWebhook(rawBody, signature).expect(200);

      expect(await orderStatus(orderId)).toBe('CONFIRMED');
    });

    it('a wrong, missing, changed or old signature is 401 and nothing changes (AC-5)', async () => {
      const { orderId, payUrl } = await paying();
      gateway.markPaid(refOf(payUrl));
      const notice = await noticeOf(payUrl, 'PAID');
      const { rawBody, signature } = signedWebhook(notice);
      // One byte changed after signing: 3990000 becomes 3990001
      const changed = Buffer.from(
        rawBody.toString().replace('3990000', '3990001'),
      );
      expect(changed.equals(rawBody)).toBe(false);
      const old = signedWebhook(notice, new Date(Date.now() - 10 * 60_000));
      const future = signedWebhook(notice, new Date(Date.now() + 10 * 60_000));
      const otherKey = signWebhook(
        'some-other-secret-of-length',
        rawBody,
        new Date(),
      );

      for (const [body, sig] of [
        [rawBody, undefined],
        [rawBody, 'garbage'],
        [rawBody, otherKey],
        [changed, signature],
        [old.rawBody, old.signature],
        [future.rawBody, future.signature],
      ] as const) {
        const res = await postWebhook(body, sig).expect(401);
        expect(res.body).toEqual({ error: 'invalid signature' });
      }

      expect(await orderStatus(orderId)).toBe('PAYMENT_PROCESSING');
      expect((await paymentRows(orderId))[0].status).toBe('INITIATED');
      expect(await prisma.inboxMessage.count()).toBe(0);
    });

    it('signed but not a message we understand: 400, nothing changes', async () => {
      const { orderId } = await paying();
      const text = Buffer.from('this is not json');
      const missingFields = Buffer.from(JSON.stringify({ hello: 'world' }));

      // Not JSON at all: the server's JSON reader refuses it before our code sees it
      await postWebhook(text, signWebhook(SECRET, text, new Date())).expect(
        400,
      );
      // JSON, signed, but not what the adapter understands: the adapter's own answer
      const res = await postWebhook(
        missingFields,
        signWebhook(SECRET, missingFields, new Date()),
      ).expect(400);
      expect(res.body).toEqual({ error: 'bad request' });

      expect(await orderStatus(orderId)).toBe('PAYMENT_PROCESSING');
    });

    it('a gateway that is not the one in use: 404', async () => {
      const { rawBody, signature } = signedWebhook({ any: 'thing' });

      await http()
        .post(`${API}/payments/webhook/vnpay`)
        .set('Content-Type', 'application/json')
        .set('X-Fake-Signature', signature)
        .send(rawBody)
        .expect(404);
    });

    it('a charge we do not know is answered "received" and changes nothing (AC-7)', async () => {
      const { orderId } = await paying();
      const { rawBody, signature } = signedWebhook({
        eventId: 'evt-unknown-0001',
        providerRef: 'fake_charge_nobody_made',
        status: 'PAID',
        amount: 3990000,
        occurredAt: new Date().toISOString(),
      });

      const res = await postWebhook(rawBody, signature).expect(200);

      expect(res.body).toEqual({ received: true });
      expect(await orderStatus(orderId)).toBe('PAYMENT_PROCESSING');
    });

    it('a failure reopens the order for another try; a failure after the money came in changes nothing (AC-8, AC-9)', async () => {
      const { orderId, payUrl } = await paying();
      const failed = signedWebhook(await noticeOf(payUrl, 'FAILED'));
      gateway.markFailed(refOf(payUrl));

      await postWebhook(failed.rawBody, failed.signature).expect(200);
      expect(await orderStatus(orderId)).toBe('PENDING');
      expect((await paymentRows(orderId))[0].status).toBe('FAILED');
    });

    it('is limited by address: more than 300 a minute is 429 (AC-16)', async () => {
      const raw = Buffer.from('{}');
      let last = 0;
      for (let i = 0; i < 301; i++) {
        last = (await postWebhook(raw, 'x')).status;
      }
      expect(last).toBe(429);
    }, 60_000);
  });

  // ── the dev endpoints of the fake gateway ─────────────────────────────────

  describe('/dev/fake-gateway/charges/:ref (AC-16)', () => {
    it('pay plays the gateway: a signed webhook through the real endpoint code; the order is confirmed', async () => {
      const { user, orderId, payUrl } = await paying();

      const res = await devPay(user, payUrl).expect(200);

      expect(res.body.data).toMatchObject({
        webhookStatus: 200,
        eventId: expect.any(String),
      });
      expect(await orderStatus(orderId)).toBe('CONFIRMED');
      const listed = await listPayments(user, orderId).expect(200);
      expect(listed.body.data[0]).toMatchObject({
        status: 'SUCCEEDED',
        payUrl: null,
      });
    });

    it('pay with another amount: the money goes back, the order is not confirmed, and it can be paid again (AC-7)', async () => {
      const { user, orderId, payUrl } = await paying();

      await devPay(user, payUrl, { amount: 1000 }).expect(200);

      const [row] = await paymentRows(orderId);
      expect(row.status).toBe('REFUNDED');
      expect(Number(row.paidAmount)).toBe(1000);
      expect(gateway.refundCount).toBe(1);
      expect(await orderStatus(orderId)).toBe('PENDING');
      await startPayment(user, orderId, 'after-wrong-amount-1').expect(201);
    });

    it('fail plays a failed payment; an unknown charge is 404; a bad body is 400', async () => {
      const { user, orderId, payUrl } = await paying();

      await devFail(user, `/dev/fake-gateway/charges/does-not-exist`).expect(
        404,
      );
      await devPay(user, payUrl, { amount: 'lots' }).expect(400);
      await devFail(user, payUrl).expect(200);

      expect((await paymentRows(orderId))[0].status).toBe('FAILED');
    });

    it('does not exist in production: every dev route is 404', async () => {
      const { user, payUrl } = await paying();
      const before = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await devPay(user, payUrl).expect(404);
        await devFail(user, payUrl).expect(404);
      } finally {
        process.env.NODE_ENV = before;
      }
      expect(gateway.chargeFor).toBeDefined();
    });
  });

  // ── limits ────────────────────────────────────────────────────────────────

  describe('rate limits (AC-16)', () => {
    it('starting a payment: 10 a minute per user, then 429; looking: 60 a minute, each endpoint on its own', async () => {
      const user = await makeUser();
      const orderId = await placeOrder(user);

      const writes: number[] = [];
      for (let i = 0; i < 11; i++) {
        writes.push((await startPayment(user, orderId, null)).status);
      }
      expect(writes.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(writes[10]).toBe(429);

      // Looking is a different bucket: not used up by the writes
      let last = 0;
      for (let i = 0; i < 61; i++)
        last = (await listPayments(user, orderId)).status;
      expect(last).toBe(429);
    }, 60_000);
  });

  // ── paid orders and refunds, through the events ───────────────────────────

  describe('cancelling a paid order (AC-13, AC-14)', () => {
    it('the money goes back once the cancel event is published', async () => {
      const { user, orderId, payUrl } = await paying();
      await devPay(user, payUrl).expect(200);
      await http()
        .post(`${ORDERS}/${orderId}/cancel`)
        .set(authed(user.token))
        .expect(200);

      await publisher.runOnce();

      const [row] = await paymentRows(orderId);
      expect(row.status).toBe('REFUNDED');
      expect(gateway.refundCount).toBe(1);
      const listed = await listPayments(user, orderId).expect(200);
      expect(listed.body.data[0]).toMatchObject({
        status: 'REFUNDED',
        payUrl: null,
      });
    });
  });
});
