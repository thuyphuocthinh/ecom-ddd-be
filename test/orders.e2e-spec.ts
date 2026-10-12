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
  CACHE,
} from './../src/core/index.js';
import { InMemoryEventBus } from './../src/core/infrastructure/messaging/events/in-memory-event-bus.js';
import { SessionIssuer } from './../src/modules/auth/application/index.js';
import { OutboxPublisher } from './../src/modules/orders/infrastructure/index.js';
import { ordersConfig } from './../src/modules/orders/orders.config.js';

const API = '/api/v1';
const ORDERS = `${API}/orders`;
const ADMIN_ORDERS = `${API}/admin/orders`;
const CLIENT = { ip: '203.0.113.7', userAgent: 'e2e' };

describe('Orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let issuer: SessionIssuer;
  let publisher: OutboxPublisher;
  let bus: InMemoryEventBus;

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A user made straight in the database (no registration limit spent) with an address and a token. */
  const makeUser = async (role: 'CUSTOMER' | 'ADMIN' = 'CUSTOMER') => {
    const id = randomUUID();
    await prisma.user.create({ data: { id, role } });
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
      { id, role, status: 'ACTIVE' },
      CLIENT,
    );
    return { id, token: accessToken, addressId };
  };
  type TestUser = Awaited<ReturnType<typeof makeUser>>;

  const inCart = (user: TestUser, skuId: string, quantity = 1) =>
    http()
      .post(`${API}/cart/items`)
      .set(authed(user.token))
      .send({ skuId, quantity })
      .expect(201);
  const place = (
    user: TestUser,
    paymentMethod: unknown = 'ONLINE',
    key: string | null = `key-${randomUUID()}`,
    body: Record<string, unknown> = {},
  ) => {
    const req = http()
      .post(ORDERS)
      .set(authed(user.token))
      .send({ addressId: user.addressId, paymentMethod, ...body });
    return key === null ? req : req.set('Idempotency-Key', key);
  };
  const get = (user: TestUser, id: string) =>
    http().get(`${ORDERS}/${id}`).set(authed(user.token));
  const cancel = (user: TestUser, id: string) =>
    http().post(`${ORDERS}/${id}/cancel`).set(authed(user.token));
  const available = async (skuId: string) =>
    Number(await redis.getClient().get(CACHE.INVENTORY.KEYS.AVAILABLE(skuId)));

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The test runs the outbox itself, so it can look at the outbox before it is emptied
      .overrideProvider(ordersConfig.KEY)
      .useValue({
        outboxIntervalMs: 0,
        outboxBatchSize: 50,
        maintenanceIntervalSeconds: 0,
      })
      .compile();
    app = module.createNestApplication();
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
    await prisma.category.create({
      data: { id: 'e2e_cat', name: 'C', path: '/e2e_cat/' },
    });
    await prisma.product.createMany({
      data: [
        {
          id: 'E_ON',
          categoryId: 'e2e_cat',
          name: 'AirPods',
          status: 'PUBLISHED',
        },
        {
          id: 'E_DRAFT',
          categoryId: 'e2e_cat',
          name: 'Hidden',
          status: 'DRAFT',
        },
      ],
    });
    for (const [id, productId, price, stock] of [
      ['E_S1', 'E_ON', 3990000, 10],
      ['E_S2', 'E_ON', 500000.5, 10],
      ['E_LAST', 'E_ON', 100, 1],
      ['E_HIDDEN', 'E_DRAFT', 100, 10],
    ] as const) {
      await prisma.sku.create({
        data: {
          id,
          productId,
          price,
          attributes: { color: id },
          skuCode: `${id}-C`,
        },
      });
      await prisma.skuStock.create({ data: { skuId: id, onHand: stock } });
    }
  });

  afterAll(async () => {
    await clear();
    await prisma.ward.deleteMany({ where: { code: '97001' } });
    await prisma.province.deleteMany({ where: { code: '97' } });
    await app.close();
  });

  // ── AC-17: signed in ───────────────────────────────────────────────────────

  it('refuses every endpoint without a token, and the admin ones to a customer (AC-13, AC-17)', async () => {
    const customer = await makeUser();
    await http().post(ORDERS).send({}).expect(401);
    await http().get(ORDERS).expect(401);
    await http().get(`${ORDERS}/x`).expect(401);
    await http().post(`${ORDERS}/x/cancel`).expect(401);
    await http().post(`${ADMIN_ORDERS}/x/ship`).expect(401);
    await http().post(`${ADMIN_ORDERS}/x/deliver`).expect(401);

    await http()
      .post(`${ADMIN_ORDERS}/x/ship`)
      .set(authed(customer.token))
      .expect(403);
    await http()
      .post(`${ADMIN_ORDERS}/x/deliver`)
      .set(authed(customer.token))
      .expect(403);
  });

  // ── AC-1, AC-2: placing ────────────────────────────────────────────────────

  it('places an online order: 201, the order as placed, nothing internal in the answer (AC-1, AC-2)', async () => {
    const user = await makeUser();
    await inCart(user, 'E_S1', 2);
    await inCart(user, 'E_S2', 1);

    const res = await place(user, 'ONLINE', 'checkout-key-0001').expect(201);

    expect(res.headers['idempotency-replayed']).toBeUndefined();
    const order = res.body.data;
    expect(order).toMatchObject({
      status: 'PENDING',
      paymentMethod: 'ONLINE',
      total: 3990000 * 2 + 500000.5,
      shippingAddress: {
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
    expect(order.items).toEqual([
      expect.objectContaining({
        skuId: 'E_S1',
        productName: 'AirPods',
        unitPrice: 3990000,
        quantity: 2,
        lineTotal: 7980000,
        attributes: { color: 'E_S1' },
      }),
      expect.objectContaining({
        skuId: 'E_S2',
        unitPrice: 500000.5,
        quantity: 1,
        lineTotal: 500000.5,
      }),
    ]);
    expect(Object.keys(order).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'items',
      'paymentMethod',
      'shippingAddress',
      'status',
      'total',
      'updatedAt',
    ]);
    // The cart is emptied and the stock is held
    const cart = await http()
      .get(`${API}/cart`)
      .set(authed(user.token))
      .expect(200);
    expect(cart.body.data.items).toEqual([]);
    expect(await available('E_S1')).toBe(8);
  });

  it('places a cash-on-delivery order: 201 and already CONFIRMED (AC-3)', async () => {
    const user = await makeUser();
    await inCart(user, 'E_S1', 2);

    const res = await place(user, 'COD').expect(201);

    expect(res.body.data).toMatchObject({
      status: 'CONFIRMED',
      paymentMethod: 'COD',
    });
    expect(
      (await prisma.skuStock.findUniqueOrThrow({ where: { skuId: 'E_S1' } }))
        .onHand,
    ).toBe(8);
  });

  it('tells the rest of the system through the outbox, without the address or the phone (AC-15)', async () => {
    const user = await makeUser();
    await inCart(user, 'E_S1', 1);
    const res = await place(user, 'COD').expect(201);

    await publisher.runOnce();

    expect(bus.published.map((e) => e.name)).toEqual([
      'order.created',
      'order.status_changed',
    ]);
    expect(bus.published[0].data).toMatchObject({
      orderId: res.body.data.id,
      userId: user.id,
      paymentMethod: 'COD',
    });
    const text = JSON.stringify(bus.published);
    expect(text).not.toContain('0901234567');
    expect(text).not.toContain('Đường Thử');
  });

  // ── AC-4: the same key again ───────────────────────────────────────────────

  it('answers the same key again with 200, the same order and Idempotency-Replayed (AC-4)', async () => {
    const user = await makeUser();
    await inCart(user, 'E_S1', 2);
    const first = await place(user, 'ONLINE', 'checkout-key-0002').expect(201);

    const again = await place(user, 'ONLINE', 'checkout-key-0002').expect(200);

    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await prisma.order.count()).toBe(1);
    expect(await available('E_S1')).toBe(8);
  });

  it('gives each user their own order for the same key (AC-4)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await inCart(a, 'E_S1');
    await inCart(b, 'E_S1');

    const first = await place(a, 'ONLINE', 'shared-key-0001').expect(201);
    const second = await place(b, 'ONLINE', 'shared-key-0001').expect(201);

    expect(first.body.data.id).not.toBe(second.body.data.id);
  });

  // ── 400: the request itself is wrong ───────────────────────────────────────

  describe('a request that is wrong is refused with 400 and changes nothing', () => {
    it.each([
      ['no Idempotency-Key', null],
      ['a key that is too short', 'short'],
      ['a key with characters that are not allowed', 'has space in it!'],
      ['a key that is too long', 'x'.repeat(101)],
    ])('%s: ORD-005', async (_, key) => {
      const user = await makeUser();
      await inCart(user, 'E_S1');

      const res = await place(user, 'ONLINE', key).expect(400);

      expect(res.body.code).toBe('ORD-005');
      expect(await prisma.order.count()).toBe(0);
      expect(await prisma.reservation.count()).toBe(0);
    });

    it.each([
      ['a payment method that does not exist', { paymentMethod: 'CRYPTO' }],
      ['no payment method', { paymentMethod: undefined }],
      ['no address', { addressId: undefined }],
      ['a field that is not allowed (userId)', { userId: 'someone-else' }],
      ['a field that is not allowed (total)', { total: 1 }],
    ])('%s', async (_, body) => {
      const user = await makeUser();
      await inCart(user, 'E_S1');

      const res = await http()
        .post(ORDERS)
        .set(authed(user.token))
        .set('Idempotency-Key', 'checkout-key-0003')
        .send({ addressId: user.addressId, paymentMethod: 'ONLINE', ...body })
        .expect(400);

      expect(res.body.code).toBe('VAL-001');
      expect(await prisma.reservation.count()).toBe(0);
    });
  });

  // ── 409 and 404 when it cannot be placed (AC-6, AC-7) ──────────────────────

  describe('an order that cannot be placed leaves nothing behind (AC-6, AC-7)', () => {
    const nothingLeft = async () => {
      expect(await prisma.order.count()).toBe(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(await prisma.reservation.count()).toBe(0);
    };

    it('an empty cart: 409 ORD-003', async () => {
      const user = await makeUser();

      const res = await place(user).expect(409);

      expect(res.body.code).toBe('ORD-003');
      await nothingLeft();
    });

    it('an item no longer on sale: 409 ORD-004 with the SKU', async () => {
      const user = await makeUser();
      await inCart(user, 'E_S1');
      // Hide the product after the item went into the cart
      await prisma.product.update({
        where: { id: 'E_ON' },
        data: { status: 'DRAFT' },
      });

      const res = await place(user).expect(409);

      expect(res.body.code).toBe('ORD-004');
      expect(res.body.errors.skuIds).toEqual(['E_S1']);
      await nothingLeft();
    });

    it('not enough stock: 409 ORD-001 with the shortage, and the other item is not held either', async () => {
      const user = await makeUser();
      await inCart(user, 'E_S1', 2);
      await inCart(user, 'E_LAST', 1);
      await prisma.skuStock.update({
        where: { skuId: 'E_LAST' },
        data: { onHand: 0 },
      });
      // Redis forgets its stock numbers; they are rebuilt from Postgres
      const stockKeys = await redis.getClient().keys('ecom:v1:inventory:*');
      if (stockKeys.length > 0) await redis.getClient().del(...stockKeys);

      const res = await place(user).expect(409);

      expect(res.body.code).toBe('ORD-001');
      expect(res.body.errors.shortages).toEqual([
        { skuId: 'E_LAST', requested: 1, available: 0 },
      ]);
      await nothingLeft();
    });

    it('an address of someone else or that does not exist: 404 ADDR-001', async () => {
      const user = await makeUser();
      const other = await makeUser();
      await inCart(user, 'E_S1');

      const theirs = await place(user, 'ONLINE', undefined, {
        addressId: other.addressId,
      });
      const nothing = await place(user, 'ONLINE', undefined, {
        addressId: randomUUID(),
      });

      expect(theirs.status).toBe(404);
      expect(theirs.body.code).toBe('ADDR-001');
      expect(nothing.status).toBe(404);
      await nothingLeft();
    });
  });

  // ── security: one user can never reach another user's order ───────────────

  it('another user cannot read, list, cancel, ship, or take over an order by any route (AC-14, AC-12, AC-13)', async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    await inCart(owner, 'E_S1', 2);
    const id = (await place(owner, 'COD', 'owner-key-0001').expect(201)).body
      .data.id;
    await inCart(intruder, 'E_S2', 1);

    // Reading: the same 404 as an order that does not exist, and the list never shows it
    await get(intruder, id).expect(404);
    const list = await http()
      .get(ORDERS)
      .set(authed(intruder.token))
      .expect(200);
    expect(JSON.stringify(list.body)).not.toContain(id);
    // Cancelling and the admin endpoints
    await cancel(intruder, id).expect(404);
    await http()
      .post(`${ADMIN_ORDERS}/${id}/ship`)
      .set(authed(intruder.token))
      .expect(403);
    // Using the owner's cursor, the owner's key, or the owner's address
    await http()
      .get(ORDERS)
      .query({ cursor: id })
      .set(authed(intruder.token))
      .expect(400);
    const theirAddress = await place(intruder, 'ONLINE', 'intruder-key-02', {
      addressId: owner.addressId,
    });
    expect(theirAddress.status).toBe(404);
    const sameKey = await place(intruder, 'ONLINE', 'owner-key-0001').expect(
      201,
    );
    expect(sameKey.body.data.id).not.toBe(id); // the key is counted per user

    // The owner's order is exactly as it was
    const after = (await get(owner, id).expect(200)).body.data;
    expect(after).toMatchObject({ status: 'CONFIRMED', total: 3990000 * 2 });
    expect(await prisma.order.count({ where: { userId: owner.id } })).toBe(1);
  });

  // ── AC-5: at the same time ─────────────────────────────────────────────────

  describe('requests at the same time (AC-5)', () => {
    it('5 requests with the same key: one 201, four 200, one order, no 500', async () => {
      const user = await makeUser();
      await inCart(user, 'E_S1', 2);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          place(user, 'COD', 'checkout-key-0004'),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
      expect(await prisma.order.count()).toBe(1);
      expect(
        await prisma.outboxEvent.count({ where: { type: 'order.created' } }),
      ).toBe(1);
      expect(
        (await prisma.skuStock.findUniqueOrThrow({ where: { skuId: 'E_S1' } }))
          .onHand,
      ).toBe(8);
    });

    it('10 users after the last unit: one 201, nine 409 ORD-001, never a 500', async () => {
      const users = await Promise.all(
        Array.from({ length: 10 }, () => makeUser()),
      );
      for (const user of users) await inCart(user, 'E_LAST', 1);

      const results = await Promise.all(
        users.map((user) => place(user, 'ONLINE')),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const lost = results.filter((r) => r.status === 409);
      expect(lost).toHaveLength(9);
      for (const r of lost) expect(r.body.code).toBe('ORD-001');
      expect(await available('E_LAST')).toBe(0);
      expect(await prisma.order.count()).toBe(1);
    });
  });

  // ── AC-14: viewing ─────────────────────────────────────────────────────────

  describe('viewing orders (AC-14)', () => {
    it("shows one order to its owner, and the same 404 ORD-002 for someone else's and for none", async () => {
      const owner = await makeUser();
      const other = await makeUser();
      await inCart(owner, 'E_S1');
      const id = (await place(owner).expect(201)).body.data.id;

      const mine = await get(owner, id).expect(200);
      const theirs = await get(other, id).expect(404);
      const none = await get(owner, randomUUID()).expect(404);

      expect(mine.body.data.id).toBe(id);
      expect(theirs.body.code).toBe('ORD-002');
      expect(none.body.code).toBe('ORD-002');
      expect(theirs.body.message).toBe(none.body.message);
    });

    it('lists only my orders, newest first, in pages with no repeat and no gap', async () => {
      const me = await makeUser();
      const other = await makeUser();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        await inCart(me, 'E_S1');
        ids.push(
          (await place(me, 'ONLINE', `list-key-000${i}`).expect(201)).body.data
            .id,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await inCart(other, 'E_S1');
      await place(other).expect(201);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await http()
          .get(ORDERS)
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .set(authed(me.token))
          .expect(200);
        pages++;
        seen.push(...res.body.data.map((o: { id: string }) => o.id));
        expect(res.body.data.length).toBeLessThanOrEqual(2);
        cursor = res.body.meta.nextCursor ?? undefined;
        if (!res.body.meta.hasMore) break;
      } while (cursor);

      expect(seen).toEqual([...ids].reverse());
      expect(pages).toBe(3);
    });

    it('shows a short line for each order in the list', async () => {
      const me = await makeUser();
      await inCart(me, 'E_S1', 2);
      await inCart(me, 'E_S2', 1);
      await place(me).expect(201);

      const res = await http().get(ORDERS).set(authed(me.token)).expect(200);

      expect(Object.keys(res.body.data[0]).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'id',
        'itemCount',
        'paymentMethod',
        'status',
        'total',
      ]);
      expect(res.body.data[0].itemCount).toBe(2);
    });

    it.each([0, 51, -1, 'abc', 1.5])(
      'refuses limit=%s with 400',
      async (limit) => {
        const me = await makeUser();

        await http()
          .get(ORDERS)
          .query({ limit })
          .set(authed(me.token))
          .expect(400);
      },
    );

    it("refuses a cursor that is not one of my orders with 400, and never shows the other user's data", async () => {
      const me = await makeUser();
      const other = await makeUser();
      await inCart(other, 'E_S1');
      const theirs = (await place(other).expect(201)).body.data.id;

      const res = await http()
        .get(ORDERS)
        .query({ cursor: theirs })
        .set(authed(me.token))
        .expect(400);

      expect(res.body.code).toBe('ORD-000');
      expect(JSON.stringify(res.body)).not.toContain(theirs);
      await http()
        .get(ORDERS)
        .query({ cursor: randomUUID() })
        .set(authed(me.token))
        .expect(400);
    });
  });

  // ── AC-12: cancelling ──────────────────────────────────────────────────────

  describe('cancelling (AC-12)', () => {
    it('cancels a PENDING order: 200, stock back; cancelling again is 409 ORD-006', async () => {
      const user = await makeUser();
      await inCart(user, 'E_S1', 2);
      const id = (await place(user).expect(201)).body.data.id;
      expect(await available('E_S1')).toBe(8);

      const res = await cancel(user, id).expect(200);

      expect(res.body.data.status).toBe('CANCELLED');
      expect(await available('E_S1')).toBe(10);
      const again = await cancel(user, id).expect(409);
      expect(again.body.code).toBe('ORD-006');
    });

    it('cancels a CONFIRMED cash-on-delivery order: 200 and the stock goes back in the warehouse', async () => {
      const user = await makeUser();
      await inCart(user, 'E_S1', 2);
      const id = (await place(user, 'COD').expect(201)).body.data.id;

      await cancel(user, id).expect(200);

      expect(
        (await prisma.skuStock.findUniqueOrThrow({ where: { skuId: 'E_S1' } }))
          .onHand,
      ).toBe(10);
      expect(await available('E_S1')).toBe(10);
      expect((await get(user, id).expect(200)).body.data.status).toBe(
        'CANCELLED',
      );
    });

    it("someone else's order and an order that does not exist: 404 ORD-002", async () => {
      const owner = await makeUser();
      const other = await makeUser();
      await inCart(owner, 'E_S1');
      const id = (await place(owner).expect(201)).body.data.id;

      expect((await cancel(other, id).expect(404)).body.code).toBe('ORD-002');
      expect((await cancel(owner, randomUUID()).expect(404)).body.code).toBe(
        'ORD-002',
      );
      expect((await get(owner, id).expect(200)).body.data.status).toBe(
        'PENDING',
      );
    });
  });

  // ── AC-13: the admin delivers ──────────────────────────────────────────────

  describe('the admin delivers (AC-13)', () => {
    it('ship then deliver, with the wrong order of steps refused', async () => {
      const admin = await makeUser('ADMIN');
      const user = await makeUser();
      await inCart(user, 'E_S1');
      const id = (await place(user, 'COD').expect(201)).body.data.id;
      const ship = () =>
        http().post(`${ADMIN_ORDERS}/${id}/ship`).set(authed(admin.token));
      const deliver = () =>
        http().post(`${ADMIN_ORDERS}/${id}/deliver`).set(authed(admin.token));

      expect((await deliver().expect(409)).body.code).toBe('ORD-006'); // not shipped yet
      expect((await ship().expect(200)).body.data.status).toBe('SHIPPING');
      expect((await ship().expect(409)).body.code).toBe('ORD-006');
      expect((await cancel(user, id).expect(409)).body.code).toBe('ORD-006'); // too late to cancel
      expect((await deliver().expect(200)).body.data.status).toBe('DELIVERED');
      expect((await get(user, id).expect(200)).body.data.status).toBe(
        'DELIVERED',
      );
    });

    it('an order that is not confirmed cannot be shipped, and an unknown order is 404', async () => {
      const admin = await makeUser('ADMIN');
      const user = await makeUser();
      await inCart(user, 'E_S1');
      const id = (await place(user, 'ONLINE').expect(201)).body.data.id;

      expect(
        (
          await http()
            .post(`${ADMIN_ORDERS}/${id}/ship`)
            .set(authed(admin.token))
            .expect(409)
        ).body.code,
      ).toBe('ORD-006');
      expect(
        (
          await http()
            .post(`${ADMIN_ORDERS}/${randomUUID()}/ship`)
            .set(authed(admin.token))
            .expect(404)
        ).body.code,
      ).toBe('ORD-002');
    });
  });

  // ── AC-17: rate limits ─────────────────────────────────────────────────────

  describe('rate limits (AC-17)', () => {
    it('allows 10 placements a minute, then 429; each endpoint is counted on its own', async () => {
      const user = await makeUser();

      for (let i = 0; i < 10; i++) {
        const res = await place(user, 'ONLINE', `limit-key-00${i}`);
        expect(res.status).toBe(409); // an empty cart, but it counts
      }
      await place(user, 'ONLINE', 'limit-key-0099').expect(429);
      await get(user, randomUUID()).expect(404); // reading is not affected
    });

    it('allows 10 cancels a minute, then 429', async () => {
      const user = await makeUser();

      for (let i = 0; i < 10; i++) await cancel(user, randomUUID()).expect(404);
      await cancel(user, randomUUID()).expect(429);
    });

    it('allows 60 reads a minute, then 429', async () => {
      const user = await makeUser();

      for (let i = 0; i < 60; i++)
        await http().get(ORDERS).set(authed(user.token)).expect(200);
      await http().get(ORDERS).set(authed(user.token)).expect(429);
    });
  });
});
